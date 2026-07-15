/*
 * build.js — produce the public/ bundle that the server serves.
 *
 * What it does:
 *   1. Reads the hand-edited source index.html (inline <style> + <script>).
 *   2. Splits the inline CSS -> app.css and inline JS -> app.js.
 *   3. Minifies both with esbuild (top-level/global names are preserved, so the
 *      inline onclick="..." handlers keep working).
 *   4. Writes public/index.html referencing the external app.css / app.js.
 *   5. Copies ONLY the referenced (optimized WebP) assets into public/, so
 *      server.js, data.json (password hashes!), scripts/, smoke-test
 *      artifacts and the heavy PNG/JPG originals never ship / are downloadable.
 *
 * Run: node build.js   (or `npm run build`)
 */
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

const ROOT = __dirname;
const SRC_HTML = path.join(ROOT, 'index.html');
const PUBLIC_DIR = path.join(ROOT, 'public');

// Optimized assets referenced by index.html — copied verbatim into public/.
// (Generate the .webp files first with `npm run images`.)
const ASSETS = [
  'treble_arena_background.webp',
  'treblemak_crests/Treble-makers_Main_Crest.webp',
  'wdl-images/WDL_Crest.webp',
  'lazy-images/LazyLeagues_Crest.webp',
  'wdl-images/WDL_American_Crest.webp',
  'wdl-images/WDL_European_Crest.webp',
  'wdl-images/WDL_UK_Crest.webp',
  'Golf Darts/par-3-course.webp',
  'lazy-images/LazyLeagues_Crest.png',
  'golf_imgs/hole-1.webp',
  'golf_imgs/hole-2.webp',
  'golf_imgs/hole-3.webp',
  'golf_imgs/hole-4.webp',
  'golf_imgs/hole-5.webp',
  'golf_imgs/hole-6.webp',
  'golf_imgs/hole-7.webp',
  'golf_imgs/hole-8.webp',
  'golf_imgs/hole-9.webp',
];

function extractBlock(html, tag) {
  const open = html.indexOf(`<${tag}>`);
  const close = html.indexOf(`</${tag}>`, open);
  if (open === -1 || close === -1) {
    throw new Error(`Could not find a single <${tag}>...</${tag}> block in index.html`);
  }
  const inner = html.slice(open + `<${tag}>`.length, close);
  const before = html.slice(0, open);
  const after = html.slice(close + `</${tag}>`.length);
  return { inner, before, after };
}

async function build() {
  const srcHtml = fs.readFileSync(SRC_HTML, 'utf8');

  // 1) Pull out the inline CSS.
  const css = extractBlock(srcHtml, 'style');
  // 2) From the remaining HTML, pull out the inline JS.
  const htmlNoStyle = css.before + '__APP_CSS__' + css.after;
  const js = extractBlock(htmlNoStyle, 'script');
  const htmlShell = js.before + '__APP_JS__' + js.after;

  // 3) Minify.
  const [cssMin, jsMin] = await Promise.all([
    esbuild.transform(css.inner, { loader: 'css', minify: true }),
    esbuild.transform(js.inner, { loader: 'js', minify: true }),
  ]);

  // 4) Assemble public/index.html with external references.
  // Cache-bust: assets are served `immutable` for 30d (see server.js), so a
  // stable filename would pin returning browsers to a STALE copy of the CSS/JS
  // and every crest forever. Stamp a per-build version onto every local asset
  // URL so a rebuild always invalidates the cache and ships the new artwork.
  const VER = Date.now().toString(36);
  let html = htmlShell
    .replace('__APP_CSS__', `<link rel="stylesheet" href="app.css?v=${VER}">`)
    .replace('__APP_JS__', `<script src="app.js?v=${VER}"></script>`);
  // Append ?v=VER to local <img src>/<link href> pointing at our image assets
  // (skip absolute URLs, data:, anchors, and anything already versioned).
  html = html.replace(
    /\b(src|href)="(?!https?:|data:|#|mailto:|app\.(?:css|js))([^"?#]+\.(?:webp|png|jpe?g|svg))"/g,
    `$1="$2?v=${VER}"`
  );

  // Stamp the same version onto url(...) asset refs inside the CSS (e.g. the
  // arena background) so they bust the immutable cache alongside everything else.
  const cssOut = cssMin.code.replace(
    /url\((['"]?)(?!https?:|data:)([^"')?#]+\.(?:webp|png|jpe?g|svg))\1\)/g,
    `url($1$2?v=${VER}$1)`
  );

  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  fs.writeFileSync(path.join(PUBLIC_DIR, 'app.css'), cssOut);
  fs.writeFileSync(path.join(PUBLIC_DIR, 'app.js'), jsMin.code);
  fs.writeFileSync(path.join(PUBLIC_DIR, 'index.html'), html);

  // 5) Copy referenced assets.
  let copied = 0, missing = 0;
  for (const rel of ASSETS) {
    const from = path.join(ROOT, rel);
    const to = path.join(PUBLIC_DIR, rel);
    if (!fs.existsSync(from)) {
      console.warn(`  ! missing asset (run \`npm run images\`): ${rel}`);
      missing++;
      continue;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    copied++;
  }

  const kb = (p) => (fs.statSync(p).size / 1024).toFixed(1);
  console.log('Build complete -> public/');
  console.log(`  index.html : ${kb(path.join(PUBLIC_DIR, 'index.html'))} KB`);
  console.log(`  app.css    : ${kb(path.join(PUBLIC_DIR, 'app.css'))} KB (minified)`);
  console.log(`  app.js     : ${kb(path.join(PUBLIC_DIR, 'app.js'))} KB (minified)`);
  console.log(`  assets     : ${copied} copied${missing ? `, ${missing} MISSING` : ''}`);
}

build().catch((err) => { console.error(err); process.exit(1); });
