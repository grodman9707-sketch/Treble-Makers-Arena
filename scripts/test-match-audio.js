#!/usr/bin/env node
/**
 * Headless Chrome match smoke test: guest → bot 501 → submit visits → assert
 * score-call / commentary key-moment gating helpers.
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3000';
const OUT = process.env.TEST_OUT || '/tmp/cursor/artifacts/screenshots';
fs.mkdirSync(OUT, { recursive: true });

async function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/usr/local/bin/google-chrome',
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1400,900',
    ],
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  await page.setViewport({ width: 1400, height: 900 });

  const consoleLogs = [];
  page.on('console', (msg) => {
    const text = msg.text();
    consoleLogs.push(`[${msg.type()}] ${text}`);
  });
  page.on('pageerror', (err) => consoleLogs.push(`[pageerror] ${err.message}`));

  const report = {
    ok: false,
    steps: [],
    callouts: [],
    commentaryRequests: [],
    introRequests: [],
    refRequests: [],
    remaining: null,
    errors: [],
  };

  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('/api/ref-announce') && req.method() === 'POST') {
      let body = {};
      try { body = JSON.parse(req.postData() || '{}'); } catch { /* ignore */ }
      report.refRequests.push(body);
    }
    if (url.includes('/api/commentary') && req.method() === 'POST') {
      let body = {};
      try { body = JSON.parse(req.postData() || '{}'); } catch { /* ignore */ }
      report.commentaryRequests.push(body);
    }
    if (url.includes('/api/match-intro') && req.method() === 'POST') {
      let body = {};
      try { body = JSON.parse(req.postData() || '{}'); } catch { /* ignore */ }
      report.introRequests.push(body);
    }
    req.continue();
  });

  try {
    await page.goto(BASE, { waitUntil: 'networkidle2' });
    report.steps.push('loaded landing');
    await page.screenshot({ path: path.join(OUT, '01-landing.png'), fullPage: true });

    // Wait for WS + arena status
    await page.waitForFunction(() => typeof guestEntry === 'function' && typeof wsSend === 'function');
    await wait(800);

    const guestOk = await page.evaluate(async () => {
      guestEntry();
      // Wait briefly for auth_ok to land in S.user
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (S?.user?.username) return S.user.username;
      }
      return null;
    });
    if (!guestOk) throw new Error('guestEntry failed');
    report.steps.push(`guest as ${guestOk}`);
    await wait(500);
    await page.screenshot({ path: path.join(OUT, '02-lobby.png'), fullPage: true });

    // Enable announce + a commentary personality for key-moment checks
    await page.evaluate(() => {
      announceMuted = false;
      try { localStorage.setItem('tma-announce-muted', '0'); } catch {}
      commentaryPersonalityId = 'hyped';
      try { localStorage.setItem('tma-commentary-personality', 'hyped'); } catch {}
      syncAnnouncePrefsUI?.();
    });

    // Verify key-moment helper
    const momentChecks = await page.evaluate(() => {
      const samples = [
        { visit: 45, remaining: 456, expect: false },
        { visit: 60, remaining: 396, expect: false },
        { visit: 100, remaining: 296, expect: true },
        { visit: 140, remaining: 156, expect: true },
        { visit: 180, remaining: 321, expect: true },
        { visit: 26, remaining: 30, bust: false, expect: true }, // short checkout left
        { visit: 40, remaining: 461, bust: true, expect: true },
        { visit: 40, remaining: 0, legWon: true, expect: true },
      ];
      return samples.map((s) => {
        const got = isCommentaryKeyMoment({
          visit: s.visit,
          remaining: s.remaining,
          bust: !!s.bust,
          legWon: !!s.legWon,
          matchWon: !!s.matchWon,
        });
        return { ...s, got, pass: got === s.expect };
      });
    });
    report.momentChecks = momentChecks;
    if (momentChecks.some((c) => !c.pass)) {
      throw new Error('isCommentaryKeyMoment checks failed: ' + JSON.stringify(momentChecks));
    }
    report.steps.push('key-moment helper ok');

    // Spoken score helper
    const spoken = await page.evaluate(() => ([
      scoreToSpokenWordsClient(26),
      scoreToSpokenWordsClient(140),
      scoreToSpokenWordsClient(180),
    ]));
    report.spoken = spoken;
    if (spoken[0] !== 'TWENTY-SIX' || spoken[1] !== 'ONE HUNDRED AND FORTY' || spoken[2] !== 'ONE HUNDRED AND EIGHTY') {
      throw new Error('spoken words mismatch: ' + JSON.stringify(spoken));
    }
    report.steps.push('spoken score words ok');

    // Start bot match via page APIs (bypass flaky modal clicks)
    await page.evaluate(async () => {
      S.game = 'X01';
      S.matchVariation = {
        x01Base: 501,
        startRule: 'straight-in',
        finishRule: 'double-out',
        legs: 1,
        visitTimerSeconds: 0,
      };
      selectedBotSkill = 3;
      createBotMatch();
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (S.roomId && S.gameState) return true;
      }
      throw new Error('bot room did not start');
    });
    report.steps.push('bot room started');

    // Attach fake camera; bot_room_started already called startMatchUI.
    await page.evaluate(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        S.localStream = stream;
        attachLocalCamera?.();
      } catch (e) {
        console.warn('getUserMedia failed', e);
      }
      // Short-circuit long walk-out waits so the match can begin.
      matchIntroAnnounced = true;
      matchIntroPromise = Promise.resolve();
      try { hideMatchPreviewOverlay(); } catch {}
      try { beginMatchAfterPreview(); } catch {}
    });

    // Wait until score input is ready and it is our turn
    await page.waitForFunction(() => {
      const inp = document.getElementById('x01-score-input');
      return !!(inp && typeof isMyMatchTurn === 'function' && isMyMatchTurn() && !S.isSpectating);
    }, { timeout: 45000 });
    await page.screenshot({ path: path.join(OUT, '03-match.png'), fullPage: true });
    report.steps.push('match UI ready for scoring');

    // Helper to submit an X01 visit through the real UI function
    async function submitVisit(score) {
      const result = await page.evaluate(async (total) => {
        const before = {
          remaining: S.gameState?.remaining?.slice?.() || null,
          turn: S.turn,
          mySeat: S.mySeat,
          spectating: S.isSpectating,
        };
        for (let i = 0; i < 80; i++) {
          if (isMyMatchTurn()) break;
          await new Promise((r) => setTimeout(r, 250));
        }
        if (!isMyMatchTurn()) {
          return {
            ok: false,
            error: 'never my turn',
            turn: S.turn,
            mySeat: S.mySeat,
            spectating: S.isSpectating,
            before,
          };
        }
        const inp = document.getElementById('x01-score-input');
        if (!inp) return { ok: false, error: 'no score input' };
        inp.value = String(total);
        submitX01();
        await new Promise((r) => setTimeout(r, 400));
        return {
          ok: true,
          remaining: S.gameState?.remaining?.slice?.() || null,
          turn: S.turn,
          history0: S.history?.[0] || null,
          before,
        };
      }, score);
      report.callouts.push({ score, result });
      return result;
    }

    // Routine scores
    let r = await submitVisit(45);
    if (!r.ok) throw new Error('submit 45 failed: ' + JSON.stringify(r));
    report.steps.push('submitted 45');
    await wait(1200); // allow bot reply pacing

    r = await submitVisit(60);
    if (!r.ok) throw new Error('submit 60 failed: ' + JSON.stringify(r));
    report.steps.push('submitted 60');
    await wait(1200);

    // Key moment
    r = await submitVisit(140);
    if (!r.ok) throw new Error('submit 140 failed: ' + JSON.stringify(r));
    report.steps.push('submitted 140');
    await wait(1500);

    await page.screenshot({ path: path.join(OUT, '04-after-scores.png'), fullPage: true });

    report.remaining = await page.evaluate(() => S.gameState?.remaining || null);
    report.turn = await page.evaluate(() => S.turn);
    report.username = await page.evaluate(() => S.user?.username);

    // Directly exercise announceVisitScore gating (independent of network TTS)
    const gate = await page.evaluate(() => {
      const beforeRef = announceSpeakQueue;
      // Spy by wrapping request functions
      const commentaryCalls = [];
      const refCalls = [];
      const origC = requestAndPlayAiCommentary;
      const origR = requestAndPlayRefAnnounce;
      requestAndPlayAiCommentary = (opts) => { commentaryCalls.push(opts); return Promise.resolve(); };
      requestAndPlayRefAnnounce = (opts) => { refCalls.push(opts); return Promise.resolve(); };
      try {
        announceVisitScore('45', { visit: 45, remaining: 456 });
        announceVisitScore('140', { visit: 140, remaining: 316 });
        announceVisitScore('BUST', { visit: 40, remaining: 461, bust: true });
        announceVisitScore('40', { visit: 40, remaining: 0, legWon: true });
      } finally {
        requestAndPlayAiCommentary = origC;
        requestAndPlayRefAnnounce = origR;
      }
      return {
        refCalls: refCalls.map((c) => ({ score: c.score, bust: c.bust, legWon: c.legWon, matchWon: c.matchWon })),
        commentaryCalls: commentaryCalls.map((c) => ({ score: c.score, remaining: c.remaining })),
      };
    });
    report.gate = gate;
    if (gate.refCalls.length !== 4) throw new Error('expected 4 ref calls');
    if (gate.commentaryCalls.length !== 3) {
      throw new Error('expected commentary only on 140/bust/leg, got ' + JSON.stringify(gate.commentaryCalls));
    }
    if (gate.commentaryCalls.some((c) => c.score === 45)) {
      throw new Error('commentary incorrectly fired on routine 45');
    }
    report.steps.push('announceVisitScore gating ok');

    // Server deterministic ref lines (even without Deepgram — expect 503)
    const refStatus = await page.evaluate(async () => {
      const res = await fetch('/api/ref-announce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ score: 26, bust: false, matchWon: false, legWon: false, locale: 'en-us' }),
      });
      return { status: res.status, text: await res.text() };
    });
    report.refApi = refStatus;
    report.steps.push(`ref-api status ${refStatus.status}`);

    report.ok = true;
  } catch (err) {
    report.errors.push(String(err && err.stack || err));
    try {
      await page.screenshot({ path: path.join(OUT, '99-error.png'), fullPage: true });
    } catch { /* ignore */ }
  } finally {
    report.consoleTail = consoleLogs.slice(-40);
    fs.writeFileSync('/tmp/cursor/artifacts/test-match-audio-report.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    await browser.close();
  }

  if (!report.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
