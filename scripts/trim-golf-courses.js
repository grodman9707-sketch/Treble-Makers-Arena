/*
 * trim-golf-courses.js
 *
 * Prepares the illustrated Golf Checkouts course art for the web UI.
 *
 * For each raw `golf_imgs/Hole N.png` (N = 1..9) it:
 *   1. Makes the surrounding WHITE background TRANSPARENT. A 4-connected
 *      border flood-fill (modelled on scripts/remove-crest-bg.js) keys on
 *      whiteness so only the contiguous outer white field is cleared — any
 *      white *inside* the illustration (bunkers, cart paths, labels) is left
 *      untouched because it is not reachable from the border.
 *   2. Trims the now-transparent margin away with sharp's `.trim()` so the
 *      output is cropped tightly to the course content bounding box.
 *   3. Encodes an optimized, space-free `golf_imgs/hole-N.webp` (transparent).
 *
 * The raw `Hole N.png` originals are NEVER modified or deleted, so the script
 * is safely re-runnable (e.g. to tune the whiteness threshold).
 *
 * Usage:  node scripts/trim-golf-courses.js   (or `npm run golf-images`)
 */
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'golf_imgs');

// A border-connected pixel is treated as background when every channel is
// brighter than this. High enough to swallow the white field + its antialiased
// rim, low enough to preserve the course artwork's own light tones.
const WHITE_MIN = 232;
// Max web width for the encoded course art (illustrations are ~1000px wide).
const MAX_WIDTH = 1000;

async function processHole(n) {
  const srcAbs = path.join(DIR, `Hole ${n}.png`);
  const outAbs = path.join(DIR, `hole-${n}.webp`);
  if (!fs.existsSync(srcAbs)) {
    console.warn(`  SKIP (missing): golf_imgs/Hole ${n}.png`);
    return null;
  }

  const { data, info } = await sharp(srcAbs)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, n4 = w * h;

  const bg = new Uint8Array(n4); // 1 = border-connected white background
  const stack = new Int32Array(n4);
  let sp = 0;

  const isWhite = (idx) => {
    const o = idx * 4;
    return data[o] >= WHITE_MIN && data[o + 1] >= WHITE_MIN && data[o + 2] >= WHITE_MIN;
  };
  const push = (idx) => {
    if (!bg[idx] && isWhite(idx)) { bg[idx] = 1; stack[sp++] = idx; }
  };

  // Seed from every border pixel.
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + (w - 1)); }

  // 4-connected flood fill.
  while (sp > 0) {
    const idx = stack[--sp];
    const x = idx % w;
    const y = (idx - x) / w;
    if (x > 0) push(idx - 1);
    if (x < w - 1) push(idx + 1);
    if (y > 0) push(idx - w);
    if (y < h - 1) push(idx + w);
  }

  // Border-connected white -> fully transparent. Everything else untouched.
  let removed = 0;
  for (let idx = 0; idx < n4; idx++) {
    if (bg[idx]) { data[idx * 4 + 3] = 0; removed++; }
  }

  let pipeline = sharp(data, { raw: { width: w, height: h, channels: 4 } })
    // Crop away the now-transparent margin to the content bounding box.
    .trim();
  const meta = await pipeline.clone().metadata();
  if (w > MAX_WIDTH) {
    pipeline = pipeline.resize({ width: MAX_WIDTH, withoutEnlargement: true });
  }
  await pipeline
    .webp({ quality: 82, alphaQuality: 100, effort: 5 })
    .toFile(outAbs);

  const beforeKB = fs.statSync(srcAbs).size / 1024;
  const afterKB = fs.statSync(outAbs).size / 1024;
  console.log(
    `  Hole ${n}.png ${beforeKB.toFixed(0).padStart(5)} KB (${w}x${h}) ` +
    `-> hole-${n}.webp ${afterKB.toFixed(0).padStart(4)} KB ` +
    `(white removed ${(removed / n4 * 100).toFixed(1)}%)`
  );
  return outAbs;
}

(async () => {
  const produced = [];
  for (let n = 1; n <= 9; n++) {
    const out = await processHole(n);
    if (out) produced.push(path.basename(out));
  }
  console.log(`\n  Produced ${produced.length} files: ${produced.join(', ')}`);
  console.log('  Done. Run `node build.js` to copy the webp assets into public/.');
})().catch((err) => { console.error(err); process.exit(1); });
