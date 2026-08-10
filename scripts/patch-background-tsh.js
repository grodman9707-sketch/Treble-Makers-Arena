/*
 * patch-background-tsh.js
 *
 * Replace the integrated WDL wall lettering and the small bottom-bar WDL crest
 * in treble_arena_background.png with TSH branding.
 *
 * Prefers a scene-matched "integrated" TSH letter render (same slant, metal,
 * circuit connections, dartboard behind) soft-blended into the original
 * arena background so the letters feel mounted in the scene like WDL.
 *
 * Usage:  node scripts/patch-background-tsh.js
 */
const path = require('path');
const fs = require('fs');
const Jimp = require('jimp');

const ROOT = path.resolve(__dirname, '..');
const BG = path.join(ROOT, 'treble_arena_background.png');
const BG_BACKUP = path.join(ROOT, 'treble_arena_background_wdl_backup.png');
const LETTERS_INTEGRATED = path.join(ROOT, 'tsh-images/_originals/TSH_wall_letters_integrated.png');
const LETTERS_FALLBACK = path.join(ROOT, 'tsh-images/_originals/TSH_wall_letters.png');
const CREST = path.join(ROOT, 'tsh-images/_originals/TSH_Main_Crest.png');

// Soft-blend window covering the old WDL wall-sign letters (full-image coords).
// Kept taller on the letter faces, shorter into the circuit shelf so original
// gold traces still appear to plug into the underside of the glyphs.
const LETTER_BLEND = { x: 960, y: 175, w: 520, h: 290, feather: 42 };
// Bottom-bar crest between TOKYO / NEW YORK.
const BOTTOM_CREST = { cx: 760, cy: 925, size: 82 };

function lum(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function softCircleAlpha(dx, dy, rx, ry) {
  const nx = dx / rx;
  const ny = dy / ry;
  const d = Math.sqrt(nx * nx + ny * ny);
  if (d >= 1) return 0;
  if (d <= 0.72) return 1;
  return 1 - (d - 0.72) / 0.28;
}

function softRectAlpha(dx, dy, hw, hh, feather) {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax >= hw || ay >= hh) return 0;
  const fx = ax > hw - feather ? 1 - (ax - (hw - feather)) / feather : 1;
  const fy = ay > hh - feather ? 1 - (ay - (hh - feather)) / feather : 1;
  return Math.max(0, Math.min(1, fx * fy));
}

async function cutBlackBg(srcAbs, tLow = 28) {
  const img = await Jimp.read(srcAbs);
  const { width: w, height: h, data } = img.bitmap;
  const n = w * h;
  const bg = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;
  const isBg = (idx) => {
    const o = idx * 4;
    return lum(data[o], data[o + 1], data[o + 2]) < tLow;
  };
  const push = (idx) => {
    if (!bg[idx] && isBg(idx)) {
      bg[idx] = 1;
      stack[sp++] = idx;
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + (w - 1));
  }
  while (sp > 0) {
    const idx = stack[--sp];
    const x = idx % w;
    const y = (idx - x) / w;
    if (x > 0) push(idx - 1);
    if (x < w - 1) push(idx + 1);
    if (y > 0) push(idx - w);
    if (y < h - 1) push(idx + w);
  }
  for (let idx = 0; idx < n; idx++) {
    if (bg[idx]) data[idx * 4 + 3] = 0;
  }
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return img;
  return img.crop(minX, minY, maxX - minX + 1, maxY - minY + 1);
}

function sampleFill(bg, cx, cy, rx) {
  const { width: w, height: h, data } = bg.bitmap;
  let rs = 0, gs = 0, bs = 0, cnt = 0;
  for (let y = cy - 40; y < cy + 40; y++) {
    for (let x = cx - rx - 80; x < cx - rx - 20; x++) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const o = (y * w + x) * 4;
      const L = lum(data[o], data[o + 1], data[o + 2]);
      if (L < 90) {
        rs += data[o];
        gs += data[o + 1];
        bs += data[o + 2];
        cnt++;
      }
    }
  }
  return {
    r: cnt ? Math.round(rs / cnt) : 28,
    g: cnt ? Math.round(gs / cnt) : 30,
    b: cnt ? Math.round(bs / cnt) : 36,
  };
}

function coverEllipse(bg, cx, cy, rx, ry) {
  const { width: w, height: h, data } = bg.bitmap;
  const fill = sampleFill(bg, cx, cy, rx);
  for (let y = Math.max(0, cy - ry); y < Math.min(h, cy + ry); y++) {
    for (let x = Math.max(0, cx - rx); x < Math.min(w, cx + rx); x++) {
      const a = softCircleAlpha(x - cx, y - cy, rx, ry);
      if (a <= 0) continue;
      const o = (y * w + x) * 4;
      data[o] = Math.round(data[o] * (1 - a) + fill.r * a);
      data[o + 1] = Math.round(data[o + 1] * (1 - a) + fill.g * a);
      data[o + 2] = Math.round(data[o + 2] * (1 - a) + fill.b * a);
    }
  }
}

function coverRect(bg, cx, cy, hw, hh, feather = 18) {
  const { width: w, height: h, data } = bg.bitmap;
  const fill = sampleFill(bg, cx, cy, hw);
  for (let y = Math.max(0, cy - hh); y < Math.min(h, cy + hh); y++) {
    for (let x = Math.max(0, cx - hw); x < Math.min(w, cx + hw); x++) {
      const a = softRectAlpha(x - cx, y - cy, hw, hh, feather);
      if (a <= 0) continue;
      const o = (y * w + x) * 4;
      data[o] = Math.round(data[o] * (1 - a) + fill.r * a);
      data[o + 1] = Math.round(data[o + 1] * (1 - a) + fill.g * a);
      data[o + 2] = Math.round(data[o + 2] * (1 - a) + fill.b * a);
    }
  }
}

function compositeCentered(bg, overlay, cx, cy, targetW, opacity = 1) {
  const scale = targetW / overlay.bitmap.width;
  const targetH = Math.round(overlay.bitmap.height * scale);
  const resized = overlay.clone().resize(targetW, targetH);
  const x0 = Math.round(cx - targetW / 2);
  const y0 = Math.round(cy - targetH / 2);
  const { width: bw, height: bh, data: bd } = bg.bitmap;
  const { width: ow, height: oh, data: od } = resized.bitmap;
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const dx = x0 + x;
      const dy = y0 + y;
      if (dx < 0 || dy < 0 || dx >= bw || dy >= bh) continue;
      const oi = (y * ow + x) * 4;
      const oa = (od[oi + 3] / 255) * opacity;
      if (oa <= 0.01) continue;
      const bi = (dy * bw + dx) * 4;
      bd[bi] = Math.round(bd[bi] * (1 - oa) + od[oi] * oa);
      bd[bi + 1] = Math.round(bd[bi + 1] * (1 - oa) + od[oi + 1] * oa);
      bd[bi + 2] = Math.round(bd[bi + 2] * (1 - oa) + od[oi + 2] * oa);
    }
  }
}

/**
 * Soft-blend a same-sized scene render into bg over a feathered rectangle.
 * Used so integrated TSH wall letters inherit the arena lighting / circuits.
 */
function softBlendRegion(bg, src, region) {
  if (src.bitmap.width !== bg.bitmap.width || src.bitmap.height !== bg.bitmap.height) {
    src = src.clone().resize(bg.bitmap.width, bg.bitmap.height);
  }
  const { x, y, w, h, feather } = region;
  const { width: bw, height: bh, data: bd } = bg.bitmap;
  const sd = src.bitmap.data;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const hw = w / 2;
  const hh = h / 2;

  for (let py = Math.max(0, y); py < Math.min(bh, y + h); py++) {
    for (let px = Math.max(0, x); px < Math.min(bw, x + w); px++) {
      const a = softRectAlpha(px - cx, py - cy, hw, hh, feather);
      if (a <= 0.01) continue;
      // Bias toward the source in the centre so WDL glyphs are fully replaced.
      const mix = Math.min(1, a * 1.05);
      const i = (py * bw + px) * 4;
      bd[i] = Math.round(bd[i] * (1 - mix) + sd[i] * mix);
      bd[i + 1] = Math.round(bd[i + 1] * (1 - mix) + sd[i + 1] * mix);
      bd[i + 2] = Math.round(bd[i + 2] * (1 - mix) + sd[i + 2] * mix);
    }
  }
}

async function pasteFallbackLetters(bg) {
  // Legacy path: wipe + flat letter overlay (used only if integrated render missing).
  coverRect(bg, 1210, 330, 340, 170, 22);
  coverEllipse(bg, 1205, 335, 310, 175);
  coverEllipse(bg, 1360, 300, 180, 155);
  const letters = await cutBlackBg(LETTERS_FALLBACK, 30);
  compositeCentered(bg, letters, 1195, 325, 480, 0.98);
}

(async () => {
  if (!fs.existsSync(CREST)) throw new Error('Missing ' + CREST);
  if (!fs.existsSync(BG_BACKUP)) {
    throw new Error(
      'Missing WDL background backup at ' + path.relative(ROOT, BG_BACKUP) +
      '. Restore with: git show main:treble_arena_background.png > treble_arena_background_wdl_backup.png'
    );
  }

  const bg = await Jimp.read(BG_BACKUP);
  console.log('Loaded WDL backup background', bg.bitmap.width, 'x', bg.bitmap.height);

  if (fs.existsSync(LETTERS_INTEGRATED)) {
    const integrated = await Jimp.read(LETTERS_INTEGRATED);
    softBlendRegion(bg, integrated, LETTER_BLEND);
    console.log('Soft-blended integrated TSH wall letters from', path.relative(ROOT, LETTERS_INTEGRATED));
  } else if (fs.existsSync(LETTERS_FALLBACK)) {
    console.warn('Integrated letter render missing — using flat fallback letters');
    await pasteFallbackLetters(bg);
  } else {
    throw new Error('No TSH wall letter source found');
  }

  // Cover + replace the small bottom-bar WDL crest between TOKYO / NEW YORK.
  coverRect(bg, BOTTOM_CREST.cx, BOTTOM_CREST.cy + 5, 78, 55, 12);
  coverEllipse(bg, BOTTOM_CREST.cx, BOTTOM_CREST.cy, 70, 48);
  coverEllipse(bg, BOTTOM_CREST.cx, BOTTOM_CREST.cy + 30, 90, 40);
  const crest = await cutBlackBg(CREST, 12);
  compositeCentered(bg, crest, BOTTOM_CREST.cx, BOTTOM_CREST.cy, BOTTOM_CREST.size, 1);
  console.log('Composited TSH bottom crest');

  await bg.writeAsync(BG);
  console.log('Wrote', path.relative(ROOT, BG));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
