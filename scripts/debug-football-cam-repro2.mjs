/**
 * Force Football match UI + natural clear/rebuild paths.
 */
import puppeteer from 'puppeteer-core';
import fs from 'fs';

const LOG = '/opt/cursor/logs/debug.log';
function nlog(hypothesisId, location, message, data = {}) {
  fs.appendFileSync(LOG, JSON.stringify({
    sessionId: '087a', hypothesisId, location, message, data, timestamp: Date.now(), runId: 'repro2'
  }) + '\n');
}

const browser = await puppeteer.launch({
  executablePath: '/usr/local/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
page.on('pageerror', (err) => nlog('X', 'pageerror', String(err?.message || err)));

async function snap(label) {
  const data = await page.evaluate(() => ({
    videoLocal: !!document.getElementById('video-local'),
    youParent: document.getElementById('webcam-you')?.parentElement?.id || null,
    oppParent: document.getElementById('webcam-opp')?.parentElement?.id || null,
    youInFb: !!(document.getElementById('webcam-you') && document.getElementById('football-field-layer')?.contains(document.getElementById('webcam-you'))),
    footballCamsMounted: typeof footballCamsMounted !== 'undefined' ? footballCamsMounted : null,
    fbSlotChild: document.getElementById('fb-cam-player')?.firstElementChild?.id || null,
    gridDisplay: document.getElementById('webcam-grid') ? getComputedStyle(document.getElementById('webcam-grid')).display : null,
    ml: document.querySelector('.match-layout')?.className || null,
    hasSrc: !!document.getElementById('video-local')?.srcObject,
  }));
  nlog('R', 'snap', label, data);
  return data;
}

try {
  await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (document.getElementById('conn-status')?.textContent || '').includes('CONNECTED'));
  await page.evaluate(() => guestEntry());
  await new Promise(r => setTimeout(r, 600));
  await page.evaluate(() => openCameraPanel(false));
  await new Promise(r => setTimeout(r, 800));
  await page.evaluate(() => enableCameraFromModal());
  await new Promise(r => setTimeout(r, 400));
  await page.evaluate(() => closeModal('cam-modal'));

  // Directly enter Football match UI (bypass lobby/WS bot room flakiness)
  await page.evaluate(() => {
    S.game = 'Football Darts';
    S.isBot = true;
    S.isLocal = false;
    S.camReady = true;
    S.turn = 0;
    S.mySeat = 0;
    S.opponentName = 'Digital Dart Bot';
    S.gameState = {
      goals: [0, 0], ballX: 50, possession: null, events: [],
      visitDarts: [0, 0], visitThrows: [[], []], round: 0,
    };
    showPage('match');
    const ml = document.querySelector('.match-layout');
    ml?.classList.add('football-darts-match');
    document.getElementById('sb-name-opp').textContent = 'BOT';
    updateMatchUI();
  });
  await new Promise(r => setTimeout(r, 500));
  const mounted = await snap('after-forced-football-ui');

  // Re-render visualizer repeatedly (pitch updates) — should stay in-place
  await page.evaluate(() => {
    for (let i = 0; i < 5; i++) {
      S.gameState.events = [{ text: `tick ${i}` }];
      S.gameState.ballX = 50 + i;
      renderVisualizer();
    }
  });
  await snap('after-repeated-renders');

  // Force rebuild path: wipe .football-events so existingRoom check fails while cams mounted
  const rebuildWhileMounted = await page.evaluate(() => {
    const before = {
      flag: footballCamsMounted,
      videoLocal: !!document.getElementById('video-local'),
      youInFb: !!(document.getElementById('webcam-you') && document.getElementById('football-field-layer')?.contains(document.getElementById('webcam-you'))),
    };
    document.querySelector('.football-events')?.remove();
    renderVisualizer(); // should restore then rebuild
    return {
      before,
      afterVideoLocal: !!document.getElementById('video-local'),
      afterFlag: footballCamsMounted,
      afterParent: document.getElementById('webcam-you')?.parentElement?.id || null,
      slotChild: document.getElementById('fb-cam-player')?.firstElementChild?.id || null,
    };
  });
  nlog('D', 'natural-rebuild', 'rebuild when events node missing', rebuildWhileMounted);

  // Switch to X01 via updateMatchUI clear path
  const switchGame = await page.evaluate(() => {
    const before = {
      flag: footballCamsMounted,
      videoLocal: !!document.getElementById('video-local'),
      youInFb: !!(document.getElementById('webcam-you') && document.getElementById('football-field-layer')?.contains(document.getElementById('webcam-you'))),
    };
    S.game = 'X01';
    S.gameState = { base: 501, scores: [501, 501] };
    document.querySelector('.match-layout')?.classList.remove('football-darts-match');
    updateMatchUI();
    return {
      before,
      afterVideoLocal: !!document.getElementById('video-local'),
      afterYouParent: document.getElementById('webcam-you')?.parentElement?.id || null,
      afterFlag: footballCamsMounted,
      fbEmpty: !document.getElementById('football-field-layer')?.innerHTML,
    };
  });
  nlog('D', 'switch-to-x01', 'updateMatchUI leave football', switchGame);
  await snap('after-switch-x01');

  // leaveMatch path after remounting football
  await page.evaluate(() => {
    S.game = 'Football Darts';
    S.isBot = true;
    S.gameState = { goals: [0, 0], ballX: 50, possession: null, events: [], visitDarts: [0, 0], visitThrows: [[], []], round: 0 };
    document.querySelector('.match-layout')?.classList.add('football-darts-match');
    showPage('match');
    updateMatchUI();
  });
  await snap('remounted-football');
  await page.evaluate(() => leaveMatch());
  await snap('after-leaveMatch');

  // CSS display:none does not block getUserMedia — remount football, hide grid, rebind
  const cssProbe = await page.evaluate(async () => {
    S.game = 'Football Darts';
    S.gameState = { goals: [0, 0], ballX: 50, possession: null, events: [], visitDarts: [0, 0], visitThrows: [[], []], round: 0 };
    document.querySelector('.match-layout')?.classList.add('football-darts-match');
    showPage('match');
    updateMatchUI();
    const gridDisp = getComputedStyle(document.getElementById('webcam-grid')).display;
    const beforeSrc = !!document.getElementById('video-local')?.srcObject;
    attachLocalCamera();
    const afterSrc = !!document.getElementById('video-local')?.srcObject;
    // play attempt
    let playErr = null;
    try {
      await document.getElementById('video-local')?.play();
    } catch (e) { playErr = String(e?.message || e); }
    return { gridDisp, beforeSrc, afterSrc, playErr, parent: document.getElementById('webcam-you')?.parentElement?.id || null };
  });
  nlog('F', 'css-display-none', 'bind while football layout hides webcam-grid', cssProbe);

  nlog('R', 'summary2', 'done', { mounted: mounted.footballCamsMounted, rebuildOk: rebuildWhileMounted.afterVideoLocal, switchOk: switchGame.afterVideoLocal });
} catch (e) {
  nlog('X', 'fatal', String(e?.stack || e));
} finally {
  await browser.close();
}
