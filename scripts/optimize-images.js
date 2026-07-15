/*
 * optimize-images.js
 *
 * Resize + convert the oversized landing/arena artwork to WebP using sharp.
 * (jimp — already a dependency for remove-crest-bg.js — does not encode WebP,
 * so sharp handles the resize + WebP encode here. Run remove-crest-bg.js FIRST
 * if you need to regenerate the transparent crest PNGs; this script consumes
 * those processed PNGs.)
 *
 * Output WebP files are written next to their source. The build step
 * (build.js) then copies only the referenced WebP files into public/, so the
 * heavy PNG/JPG originals and *\_originals never ship.
 *
 * Targets ~2x each asset's displayed size (transparency preserved for crests).
 *
 * Usage:  node scripts/optimize-images.js
 */
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');

// width = ~2x displayed CSS size. null = keep intrinsic size (only re-encode).
const TASKS = [
  // Full-screen arena background (displayed as cover): cap to 1600px wide.
  { src: 'treble_arena_background.png',                       out: 'treble_arena_background.webp',                       width: 1600, quality: 72, alpha: false },
  // Main crest: displayed up to 400px → 800px. Keep transparency.
  { src: 'treblemak_crests/Treble-makers_Main_Crest.png',     out: 'treblemak_crests/Treble-makers_Main_Crest.webp',     width: 800,  quality: 82, alpha: true },
  // WDL partner crest: displayed up to 182px → 400px.
  { src: 'wdl-images/WDL_Crest.png',                          out: 'wdl-images/WDL_Crest.webp',                          width: 400,  quality: 82, alpha: true },
  // Lazy Leagues partner crest: displayed up to 182px → 400px.
  // Uses the metalized cut-out so the partner logo matches the other metal crests.
  { src: 'lazy-images/LazyLeagues_Crest_metal.png',           out: 'lazy-images/LazyLeagues_Crest.webp',                 width: 400,  quality: 82, alpha: true },
  // Sub-league crests: displayed 91px → 200px.
  { src: 'wdl-images/WDL_American_Crest.png',                 out: 'wdl-images/WDL_American_Crest.webp',                 width: 200,  quality: 82, alpha: true },
  { src: 'wdl-images/WDL_European_Crest.png',                 out: 'wdl-images/WDL_European_Crest.webp',                 width: 200,  quality: 82, alpha: true },
  { src: 'wdl-images/WDL_UK_Crest.png',                       out: 'wdl-images/WDL_UK_Crest.webp',                       width: 200,  quality: 82, alpha: true },
  // Golf course illustration (rendered at scale(2)): cap to 1200px wide.
  { src: 'Golf Darts/par-3-course.png',                       out: 'Golf Darts/par-3-course.webp',                       width: 1200, quality: 78, alpha: true },
];

async function run() {
  let beforeTotal = 0, afterTotal = 0;
  for (const t of TASKS) {
    const srcAbs = path.join(ROOT, t.src);
    const outAbs = path.join(ROOT, t.out);
    if (!fs.existsSync(srcAbs)) {
      console.warn(`  SKIP (missing): ${t.src}`);
      continue;
    }
    const beforeKB = fs.statSync(srcAbs).size / 1024;
    let pipeline = sharp(srcAbs);
    const meta = await pipeline.metadata();
    if (t.width && meta.width && meta.width > t.width) {
      pipeline = pipeline.resize({ width: t.width, withoutEnlargement: true });
    }
    await pipeline
      .webp({ quality: t.quality, alphaQuality: 100, effort: 5 })
      .toFile(outAbs);
    const afterKB = fs.statSync(outAbs).size / 1024;
    beforeTotal += beforeKB;
    afterTotal += afterKB;
    console.log(
      `  ${t.out.padEnd(48)} ${beforeKB.toFixed(0).padStart(6)} KB -> ${afterKB.toFixed(0).padStart(5)} KB` +
      `  (${meta.width}x${meta.height} -> w<=${t.width})`
    );
  }
  console.log(`\n  TOTAL: ${beforeTotal.toFixed(0)} KB (source) -> ${afterTotal.toFixed(0)} KB (webp)`);
  console.log('  Done. Run `npm run build` to copy the webp assets into public/.');
}

run().catch((err) => { console.error(err); process.exit(1); });
