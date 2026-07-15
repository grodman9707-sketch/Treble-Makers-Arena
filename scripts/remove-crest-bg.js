/*
 * remove-crest-bg.js
 *
 * CONSERVATIVE edge-connected background removal for the landing-page crests.
 *
 * Goal: replace the big solid black box around each crest with transparency,
 * leaving ONLY A THIN DARK LINE hugging the crest outline, with the crest
 * artwork left 100% PRISTINE. We must NOT erode the crest's dark edges (an
 * earlier feathered flood-fill ruined them).
 *
 * How it stays safe:
 *   - 4-connected BFS/flood-fill starting from every border pixel.
 *   - A pixel is treated as background ONLY if its luminance
 *     (0.299R+0.587G+0.114B) is BELOW a VERY LOW threshold (tLow). This is the
 *     key: the fill stops the instant it reaches the crest's antialiased rim,
 *     so the crest plus a thin natural dark rim survive untouched.
 *   - Matched pixels -> alpha 0. NO brightness feather, NO edge fading: the
 *     boundary is left exactly as-is so a thin dark outline persists.
 *   - Interior dark pixels not reachable from the border stay fully opaque,
 *     so dartboards / banners / dart flights are never punched through.
 *
 * Always reads the PRISTINE ORIGINAL from *\_originals so re-runs (e.g. to
 * lower the threshold) never lose the source artwork. _originals is never
 * modified or deleted.
 *
 * Usage:  node scripts/remove-crest-bg.js
 */
const path = require('path');
const fs = require('fs');
const Jimp = require('jimp');

const ROOT = path.resolve(__dirname, '..');

// Per-crest config. tLow = luminance (0-255) below which a border-connected
// pixel is removed. Keep this LOW so only the flat near-pure-black field is
// stripped. If a crest ever looks eroded/ragged, LOWER tLow and re-run.
const TASKS = [
  {
    src: 'treblemak_crests/_originals/Treble-makers_Main_Crest.png',
    out: 'treblemak_crests/Treble-makers_Main_Crest.png',
    // Emissive green/purple lightning on pure black. Keep this a CONSERVATIVE
    // hard cut: only the near-pure-black border field is stripped. A higher
    // threshold (or the graded 'glow' mode) leaks through the crest's dark
    // gunmetal channels into the body and washes the whole emblem out, so the
    // threshold must stay very low to seal the crest interior.
    tLow: 6,
  },
  {
    src: 'wdl-images/_originals/WDL_American_Crest.png',
    out: 'wdl-images/WDL_American_Crest.png',
    tLow: 10,
  },
  {
    src: 'wdl-images/_originals/WDL_Crest.jpeg',
    out: 'wdl-images/WDL_Crest.png',
    tLow: 10,
  },
  {
    src: 'wdl-images/_originals/WDL_European_Crest.jpg',
    out: 'wdl-images/WDL_European_Crest.png',
    tLow: 10,
  },
  {
    src: 'wdl-images/_originals/WDL_UK_Crest.jpg',
    out: 'wdl-images/WDL_UK_Crest.png',
    tLow: 10,
  },
  {
    src: 'lazy-images/_originals/LazyLeagues_Crest.png',
    out: 'lazy-images/LazyLeagues_Crest.png',
    // The Lazy Leagues emblem sits on a flat dark-charcoal field (~rgb 29,33,35),
    // NOT near-black, so luminance keying fails here. Key on colour distance to the
    // sampled border colour instead; tol is small enough that the emblem's own
    // near-black outlines stay farther than tol from the field and survive intact.
    mode: 'color',
    tol: 44,
  },
];

const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

async function processCrest(task) {
  const srcAbs = path.join(ROOT, task.src);
  const outAbs = path.join(ROOT, task.out);

  if (!fs.existsSync(srcAbs)) {
    throw new Error(`MISSING ORIGINAL: ${task.src}`);
  }

  const img = await Jimp.read(srcAbs);
  const { width: w, height: h, data } = img.bitmap;
  const n = w * h;

  const bg = new Uint8Array(n); // 1 = border-connected background
  const stack = new Int32Array(n);
  let sp = 0;

  let isBg;
  if (task.mode === 'color') {
    // Reference background colour = average of every border pixel.
    let rs = 0, gs = 0, bs = 0, cnt = 0;
    const sample = (idx) => { const o = idx * 4; rs += data[o]; gs += data[o + 1]; bs += data[o + 2]; cnt++; };
    for (let x = 0; x < w; x++) { sample(x); sample((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { sample(y * w); sample(y * w + (w - 1)); }
    const refR = rs / cnt, refG = gs / cnt, refB = bs / cnt;
    const tol2 = task.tol * task.tol;
    isBg = (idx) => {
      const o = idx * 4;
      const dr = data[o] - refR, dg = data[o + 1] - refG, db = data[o + 2] - refB;
      return dr * dr + dg * dg + db * db < tol2;
    };
  } else if (task.mode === 'glow') {
    // Region = everything border-connected and dimmer than the bright solid
    // crest rim. Per-pixel alpha is assigned by luminance below (graded fade).
    isBg = (idx) => {
      const o = idx * 4;
      return lum(data[o], data[o + 1], data[o + 2]) < task.tHigh;
    };
  } else {
    isBg = (idx) => {
      const o = idx * 4;
      return lum(data[o], data[o + 1], data[o + 2]) < task.tLow;
    };
  }
  const push = (idx) => {
    if (!bg[idx] && isBg(idx)) { bg[idx] = 1; stack[sp++] = idx; }
  };

  // Seed from every border pixel.
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + (w - 1)); }

  // 4-connected flood fill (conservative: won't leak through 1px diagonal gaps).
  while (sp > 0) {
    const idx = stack[--sp];
    const x = idx % w;
    const y = (idx - x) / w;
    if (x > 0) push(idx - 1);
    if (x < w - 1) push(idx + 1);
    if (y > 0) push(idx - w);
    if (y < h - 1) push(idx + w);
  }

  // Apply: background -> alpha 0. NO feather, NO edge fade. Everything else
  // (including the thin dark rim and all interior pixels) is left untouched.
  let removed = 0;
  for (let idx = 0; idx < n; idx++) {
    if (!bg[idx]) continue;
    const o = idx * 4;
    if (task.mode === 'glow') {
      // Graded fade: black -> 0, glow brightens toward the rim's full opacity.
      data[o + 3] = Math.min(255, Math.round(lum(data[o], data[o + 1], data[o + 2]) * 255 / task.tHigh));
    } else {
      data[o + 3] = 0;
    }
    removed++;
  }

  // Opaque bounding box (sanity check that interior survived intact).
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 0) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }

  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  await img.writeAsync(outAbs);

  console.log(`\n[${task.src}]`);
  console.log(`  size         : ${w} x ${h} (${n} px)`);
  console.log(`  key          : ${task.mode === 'color' ? `color(tol=${task.tol})` : task.mode === 'glow' ? `glow(tHigh=${task.tHigh})` : `lum(tLow=${task.tLow})`}`);
  console.log(`  bg removed   : ${removed} px (${(removed / n * 100).toFixed(1)}%)`);
  console.log(`  opaque bbox  : x[${minX}-${maxX}] y[${minY}-${maxY}]`);
  console.log(`  -> wrote     : ${task.out}`);
}

(async () => {
  for (const task of TASKS) {
    await processCrest(task);
  }
  console.log('\nDone.');
})().catch((err) => { console.error(err); process.exit(1); });
