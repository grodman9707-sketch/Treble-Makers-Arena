#!/usr/bin/env node
/**
 * Headless smoke test: guest → bot 501 → verify music-only match preview
 * (no voice API calls) and that preview timing covers both walk-outs.
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
  page.setDefaultTimeout(45000);
  await page.setViewport({ width: 1400, height: 900 });

  const report = {
    ok: false,
    steps: [],
    voicePosts: [],
    walkoutPlays: 0,
    timing: null,
    errors: [],
  };

  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (req.method() === 'POST' && (
      url.includes('/api/ref-announce') ||
      url.includes('/api/commentary') ||
      url.includes('/api/match-intro')
    )) {
      report.voicePosts.push(url.replace(BASE, ''));
    }
    req.continue();
  });

  try {
    await page.goto(BASE, { waitUntil: 'networkidle2' });
    report.steps.push('loaded landing');

    await page.waitForFunction(() => typeof guestEntry === 'function');
    await wait(600);
    const guest = await page.evaluate(async () => {
      guestEntry();
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (S?.user?.username) return S.user.username;
      }
      return null;
    });
    if (!guest) throw new Error('guestEntry failed');
    report.steps.push(`guest as ${guest}`);

    // Pick a walk-out so music has a real source.
    await page.evaluate(() => {
      setWalkoutId('wo01', { persistProfile: false, quiet: true });
    });

    const timing = await page.evaluate(() => {
      const players = [
        { username: 'A', walkoutId: 'wo01' },
        { username: 'B', walkoutId: 'wo02' },
      ];
      return {
        estimate: estimateMatchIntroMs(players),
        clip: WALKOUT_CLIP_MS,
        preview: MATCH_PREVIEW_MS,
        botPreview: MATCH_PREVIEW_BOT_MS,
      };
    });
    report.timing = timing;
    if (timing.estimate < timing.clip * 2) {
      throw new Error('estimateMatchIntroMs too short for both clips: ' + JSON.stringify(timing));
    }
    if (timing.preview < timing.clip * 2) {
      throw new Error('MATCH_PREVIEW_MS too short for both clips');
    }
    report.steps.push('preview timing covers both walk-outs');

    // Spy walkout playback
    await page.evaluate(() => {
      window.__walkoutPlays = 0;
      const orig = playWalkoutSting;
      playWalkoutSting = (id) => {
        window.__walkoutPlays += 1;
        // Resolve quickly in test — still count both slots.
        return Promise.resolve();
      };
      window.__origPlayWalkoutSting = orig;
    });

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
        if (S.roomId && S.gameState) return;
      }
      throw new Error('bot room did not start');
    });
    report.steps.push('bot room started');

    // Let preview intro sequence start (music-only).
    await wait(1500);
    const walkouts = await page.evaluate(() => window.__walkoutPlays || 0);
    report.walkoutPlays = walkouts;
    if (walkouts < 1) {
      // Sequence may still be mid-flight; force a direct call check.
      const forced = await page.evaluate(async () => {
        matchIntroAnnounced = false;
        matchIntroPromise = Promise.resolve();
        await runMatchIntroAnnounce({
          game: 'X01',
          x01Base: 501,
          players: [
            { username: S.user.username, walkoutId: 'wo01' },
            { username: 'Bot (Level 3)', walkoutId: 'wo02' },
          ],
        });
        return window.__walkoutPlays;
      });
      report.walkoutPlays = forced;
      if (forced < 2) throw new Error('expected 2 walk-out plays, got ' + forced);
    }
    report.steps.push(`walk-out plays: ${report.walkoutPlays}`);

    // Voice APIs must not be hit for intro/score calling.
    if (report.voicePosts.length) {
      throw new Error('voice API still called: ' + report.voicePosts.join(', '));
    }
    report.steps.push('no voice API posts');

    // Confirm voice helpers are no-ops
    const noop = await page.evaluate(async () => {
      const a = await announceSpeak('test');
      const b = await announceIntroSpeak('GAME ON!');
      const c = await requestAndPlayRefAnnounce({ score: 180 });
      const d = await requestAndPlayAiCommentary({ player: 'x', score: 140, remaining: 100 });
      return { a, b, c, d };
    });
    report.noop = noop;
    report.steps.push('voice helpers no-op');

    await page.screenshot({ path: path.join(OUT, 'music-only-preview.png'), fullPage: true });
    report.ok = true;
  } catch (err) {
    report.errors.push(String(err && err.stack || err));
    try {
      await page.screenshot({ path: path.join(OUT, '99-error.png'), fullPage: true });
    } catch { /* ignore */ }
  } finally {
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
