/**
 * Runtime repro for football cam / Enable Camera investigation.
 */
import puppeteer from 'puppeteer-core';
import fs from 'fs';

const LOG = '/opt/cursor/logs/debug.log';
function nlog(hypothesisId, location, message, data = {}) {
  fs.appendFileSync(LOG, JSON.stringify({
    sessionId: '087a', hypothesisId, location, message, data, timestamp: Date.now(), runId: 'repro'
  }) + '\n');
}

const chrome = process.env.CHROME_PATH || '/usr/local/bin/google-chrome';
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: 'new',
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

const page = await browser.newPage();
page.setDefaultTimeout(45000);
page.on('pageerror', (err) => nlog('X', 'pageerror', String(err?.message || err)));
page.on('console', (msg) => {
  if (msg.type() === 'error') nlog('X', 'console-error', msg.text());
});

async function snap(label) {
  const data = await page.evaluate(() => {
    const you = document.getElementById('webcam-you');
    const opp = document.getElementById('webcam-opp');
    const fb = document.getElementById('football-field-layer');
    const grid = document.getElementById('webcam-grid');
    const err = document.getElementById('cam-error');
    const conn = document.getElementById('conn-status')?.textContent || '';
    // Access script-scope via function closures that already exist
    const camReady = typeof isCamReady === 'function' ? isCamReady() : null;
    return {
      videoLocal: !!document.getElementById('video-local'),
      videoRemote: !!document.getElementById('video-remote'),
      youParent: you?.parentElement?.id || null,
      oppParent: opp?.parentElement?.id || null,
      youInFb: !!(you && fb && fb.contains(you)),
      oppInFb: !!(opp && fb && fb.contains(opp)),
      footballCamsMounted: typeof footballCamsMounted !== 'undefined' ? footballCamsMounted : null,
      camReady,
      hasLocalVidSrc: !!document.getElementById('video-local')?.srcObject,
      camError: err && !err.classList.contains('hidden') ? err.textContent : null,
      gridDisplay: grid ? getComputedStyle(grid).display : null,
      conn,
      pageMatchActive: document.getElementById('page-match')?.classList.contains('active') || document.getElementById('page-match')?.style.display === 'block',
      fbSlot: !!document.getElementById('fb-cam-player'),
      mlClass: document.querySelector('.match-layout')?.className || null,
    };
  });
  nlog('R', 'repro-snap', label, data);
  return data;
}

try {
  await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const t = document.getElementById('conn-status')?.textContent || '';
    return t.includes('CONNECTED');
  }, { timeout: 20000 });
  nlog('E', 'repro', 'ws connected via conn-status');

  await page.evaluate(() => guestEntry());
  await page.waitForFunction(() => {
    return document.getElementById('page-auth')?.classList.contains('hidden')
      || document.body.classList.contains('app-active')
      || !!document.getElementById('nav-user')?.textContent?.trim();
  }, { timeout: 15000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 800));
  nlog('E', 'repro', 'after guest entry', {
    bodyClass: await page.evaluate(() => document.body.className),
    nav: await page.evaluate(() => document.getElementById('nav-user')?.textContent || null),
  });

  // Enable camera path (pre-match, non-football)
  await page.evaluate(() => openCameraPanel(false));
  await new Promise(r => setTimeout(r, 1200));
  await snap('after-open-camera-panel');
  await page.evaluate(() => enableCameraFromModal());
  await new Promise(r => setTimeout(r, 1000));
  const afterEnable = await snap('after-enable-camera');
  nlog('A', 'repro', 'Enable Camera (fresh session, before Football)', {
    camReady: afterEnable.camReady,
    videoLocal: afterEnable.videoLocal,
    camError: afterEnable.camError,
    hasLocalVidSrc: afterEnable.hasLocalVidSrc,
  });

  await page.evaluate(() => { try { closeModal('cam-modal'); } catch (_) {} });

  // Start Football bot match
  await page.evaluate(() => {
    selectedGame = 'Football Darts';
    selectedMatchType = 'bot';
    S.game = 'Football Darts';
    S.matchVariation = {};
    S.botSkill = 3;
    S.camReady = true;
    createBotMatch();
  });

  await page.waitForFunction(() => {
    const ml = document.querySelector('.match-layout');
    return (ml && ml.classList.contains('football-darts-match'))
      || !!document.getElementById('fb-cam-player')
      || (typeof footballCamsMounted !== 'undefined' && footballCamsMounted);
  }, { timeout: 25000 }).catch(async () => {
    nlog('X', 'repro', 'football match wait timed out', await snap('timeout-wait-football'));
  });

  await new Promise(r => setTimeout(r, 1000));
  const inMatch = await snap('in-football-match');

  // Thrower swap
  await page.evaluate(() => {
    if (typeof mountFootballCams === 'function') {
      S.isBot = true;
      S.turn = 1;
      mountFootballCams(true);
      S.turn = 0;
      mountFootballCams(true);
    }
  });
  await snap('after-thrower-swap');

  // Leave
  await page.evaluate(() => { if (typeof leaveMatch === 'function') leaveMatch(); });
  await new Promise(r => setTimeout(r, 600));
  const afterLeave = await snap('after-leave-football');

  // Hypothesis D: flag skew + innerHTML clears live video nodes
  const destroyProbe = await page.evaluate(() => {
    const fb = document.getElementById('football-field-layer');
    if (!fb) return { error: 'no fb layer' };
    fb.classList.remove('hidden');
    fb.innerHTML = `<div class="fb-room"><div class="fb-cam-col"><div class="fb-cam-wrap"><div class="fb-cam-slot" id="fb-cam-player"></div></div></div></div>`;
    const slot = document.getElementById('fb-cam-player');
    const you = document.getElementById('webcam-you');
    if (slot && you) slot.appendChild(you);
    const before = {
      videoLocal: !!document.getElementById('video-local'),
      youInFb: !!(document.getElementById('webcam-you') && fb.contains(document.getElementById('webcam-you'))),
      flag: footballCamsMounted,
    };
    footballCamsMounted = false; // skew: nodes in layer, flag says not mounted
    // mirrors updateMatchUI danger: clear without restore when flag false
    fb.innerHTML = '';
    return {
      before,
      afterVideoLocal: !!document.getElementById('video-local'),
      afterYou: !!document.getElementById('webcam-you'),
      afterOpp: !!document.getElementById('webcam-opp'),
    };
  });
  nlog('D', 'repro', 'flag-skew destroy probe', destroyProbe);

  await page.evaluate(() => openCameraPanel(false));
  await new Promise(r => setTimeout(r, 800));
  await page.evaluate(() => enableCameraFromModal());
  await new Promise(r => setTimeout(r, 800));
  const postDestroy = await snap('after-enable-post-destroy');
  nlog('A', 'repro', 'Enable Camera after DOM destroy', postDestroy);

  // Null-active throw probe (golf fallback missing)
  const nullActive = await page.evaluate(() => {
    try {
      // recreate minimal slot
      const fb = document.getElementById('football-field-layer');
      fb.innerHTML = `<div class="fb-room"><div class="fb-cam-slot" id="fb-cam-player"></div></div>`;
      // you/opp already destroyed — mount should early-return on !you
      let threw = null;
      try { mountFootballCams(true); } catch (e) { threw = String(e?.message || e); }
      return { threw, hasYou: !!document.getElementById('webcam-you'), hasSlot: !!document.getElementById('fb-cam-player') };
    } catch (e) {
      return { outer: String(e?.message || e) };
    }
  });
  nlog('C', 'repro', 'mount after destroy / null you', nullActive);

  nlog('R', 'repro', 'summary', {
    enableOkBeforeFootball: !!(afterEnable.camReady && afterEnable.videoLocal && !afterEnable.camError),
    mountedInMatch: inMatch.footballCamsMounted,
    videoSurvivedLeave: afterLeave.videoLocal,
    destroyKillsVideo: destroyProbe?.afterVideoLocal === false,
  });
} catch (err) {
  nlog('X', 'repro-fatal', String(err?.stack || err));
} finally {
  await browser.close();
}
