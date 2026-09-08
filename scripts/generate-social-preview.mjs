/**
 * Generates docs/social-preview.png (1280×640), docs/og-image.png (1200×630)
 * and docs/twitter-image.png (1200×675) from one shared design, so the three
 * assets can never drift apart again.
 *
 * The current Vidamia identity uses the canonical geometric mark.
 * No historical upstream screenshot is presented as the current application.
 *
 * The typeface does NOT follow. Plus Jakarta Sans stays embedded as base64
 * because this file produces a COMMITTED artifact: an embedded font renders the
 * same on every machine, while the app's system stack would resolve to whatever
 * the generating host happens to have — and this generator has already shipped
 * tofu glyphs once (see the twitter-image fix). A poster may wear a display face
 * the product does not; a poster that renders differently per machine may not.
 *
 * Shared layout: brand, household message and features alongside the mark.
 *
 * Rendered via headless Chromium (puppeteer, devDependency) for pixel-perfect
 * text/gradients/shadows, with the brand font (Plus Jakarta Sans) embedded as
 * base64, then resized with sharp.
 *
 * Usage:  node scripts/generate-social-preview.mjs
 */

import puppeteer from 'puppeteer';
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const brandSvg = readFileSync(resolve(ROOT, 'public/icons/vidamia-mark.svg'), 'utf8');
const FONT_SRC       = resolve(ROOT, 'docs/fonts/plus-jakarta-sans-variable.woff2');
const OUT_SOCIAL     = resolve(ROOT, 'docs/social-preview.png');
const OUT_OG         = resolve(ROOT, 'docs/og-image.png');
const OUT_TWITTER    = resolve(ROOT, 'docs/twitter-image.png');

const fontB64 = readFileSync(FONT_SRC).toString('base64');

// ── Inline Lucide stroke icons (24×24, currentColor) ───────────────────────
const ICON = {
  tasks:    '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 12 2 2 4-4"/>',
  calendar: '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
  meals:    '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>',
  budget:   '<rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/>',
};

const chip = (icon, label) => `
  <div class="chip">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round">${ICON[icon]}</svg>
    <span>${label}</span>
  </div>`;

// ── HTML template (rendered at 2× for crisp output) ────────────────────────
const html = () => `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
@font-face {
  font-family: 'Jakarta';
  src: url(data:font/woff2;base64,${fontB64}) format('woff2');
  font-weight: 200 800;
  font-display: block;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body {
  width: 1280px; height: 640px; overflow: hidden;
  -webkit-font-smoothing: antialiased;
  font-family: 'Jakarta', -apple-system, 'Segoe UI', sans-serif;
}
body {
  position: relative;
  background-color: #f7f3e9;
  background-image:
    radial-gradient(ellipse 78% 95% at 74% 52%, rgba(174,141,101,.45) 0%, transparent 58%),
    radial-gradient(ellipse 50% 50% at 6% 8%,   rgba(174,141,101,.14) 0%, transparent 55%),
    radial-gradient(ellipse 40% 40% at 96% 96%, rgba(147,154,123,.06) 0%, transparent 50%);
}
/* fine tech grid overlay, faded toward edges */
body::before {
  content: '';
  position: absolute; inset: 0;
  background-image:
    linear-gradient(rgba(255,255,255,.030) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,.030) 1px, transparent 1px);
  background-size: 46px 46px;
  -webkit-mask-image: radial-gradient(ellipse 75% 75% at 40% 50%, #000 30%, transparent 80%);
          mask-image: radial-gradient(ellipse 75% 75% at 40% 50%, #000 30%, transparent 80%);
  pointer-events: none;
}
/* thin top accent line */
body::after {
  content: '';
  position: absolute; top: 0; left: 0; right: 0; height: 3px;
  background: linear-gradient(90deg, transparent 0%, #815f3d 30%, #ad815a 55%, transparent 100%);
  opacity: .85;
}

/* ── Left content column ── */
.left {
  position: absolute;
  top: 0; left: 0; bottom: 0;
  width: 600px;
  padding: 0 0 0 72px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  z-index: 2;
}

.brand {
  display: flex; align-items: center; gap: 13px;
  margin-bottom: 30px;
}
.brand .name {
  display: flex; align-items: center; gap: 10px;
  font-size: 30px; font-weight: 800; color: #302a24; letter-spacing: -.035em; line-height: 1;
}
.brand .name svg { display: block; width: 33px; height: 33px; margin-right: 0; }

.kicker {
  display: inline-flex; align-items: center; align-self: flex-start; gap: 8px;
  padding: 7px 14px; margin-bottom: 22px;
  border: 1px solid rgba(174,141,101,.35);
  border-radius: 999px;
  background: rgba(174,141,101,.10);
  font-size: 11.5px; font-weight: 700; letter-spacing: .14em;
  text-transform: uppercase; color: #815f3d; line-height: 1;
}
.kicker .dot {
  width: 6px; height: 6px; border-radius: 50%; background: #67745d;
  box-shadow: 0 0 8px rgba(103,116,93,.9);
}

.headline {
  font-size: 50px; font-weight: 800; line-height: 1.04; letter-spacing: -.032em;
  color: #302a24; margin-bottom: 20px;
}
.headline .grad {
  background: linear-gradient(100deg, #504238 0%, #815f3d 55%, #6b5a47 100%);
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
}

.sub {
  font-size: 16.5px; font-weight: 400; line-height: 1.55; letter-spacing: -.005em;
  color: #655d53; max-width: 430px; margin-bottom: 30px;
}

.chips { display: flex; flex-wrap: wrap; gap: 9px; margin-bottom: 30px; }
.chip {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 9px 15px 9px 13px;
  border: 1px solid rgba(255,255,255,.09);
  border-radius: 11px;
  background: rgba(255,255,255,.035);
  color: #51483e; font-size: 13.5px; font-weight: 600; letter-spacing: -.01em;
}
.chip svg { width: 16px; height: 16px; color: #815f3d; flex-shrink: 0; }

.meta {
  display: flex; align-items: center; gap: 11px;
  font-size: 12.5px; font-weight: 500; color: #655d53; letter-spacing: .01em;
}
.meta .sep { width: 3px; height: 3px; border-radius: 50%; background: #48484A; }

/* ── Right product window ── */
.brand-display {
  position: absolute; right: 82px; top: 154px;
  width: 330px; height: 330px; border-radius: 68px;
  background: #504238; color: #f7f3e9;
  box-shadow: 0 32px 100px rgba(0,0,0,.25);
}
.brand-display svg { width: 100%; height: 100%; }
</style>
</head>
<body>

<div class="left">
  <div class="brand">
    <div class="name" aria-label="Vidamia"><span aria-hidden="true">${brandSvg}</span><span aria-hidden="true">Vidamia</span></div>
  </div>

  <div class="kicker"><span class="dot"></span>Self-hosted · Open Source</div>

  <h1 class="headline">Life,<br><span class="grad">together.</span></h1>

  <p class="sub">Tasks, calendar, meals, shopping and budget — private by design, beautifully organized on your own server.</p>

  <div class="chips">
    ${chip('tasks', 'Tasks')}
    ${chip('calendar', 'Calendar')}
    ${chip('meals', 'Meals')}
    ${chip('budget', 'Budget')}
  </div>

  <div class="meta">
    <span>Docker</span><span class="sep"></span>
    <span>PWA</span><span class="sep"></span>
    <span>No tracking</span><span class="sep"></span>
    <span>MIT License</span>
  </div>
</div>

<div class="brand-display" aria-hidden="true">
  ${brandSvg}
</div>

</body>
</html>`;

// ── Render & export ─────────────────────────────────────────────────────────

async function render(outPath, finalW, finalH) {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 640, deviceScaleFactor: 2 });
  await page.setContent(html(), { waitUntil: 'load', timeout: 120_000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  const raw = await page.screenshot({ type: 'png' });
  await browser.close();

  // Preserve the complete mark, headline and margins at every social ratio.
  await sharp(raw)
    .resize(finalW, finalH, { fit: 'contain', background: '#f7f3e9' })
    .png({ compressionLevel: 9 })
    .toFile(outPath);

  console.log(`✓  ${outPath}  (${finalW}×${finalH})`);
}

console.log('Generating social previews…');
await render(OUT_SOCIAL,  1280, 640);
await render(OUT_OG,      1200, 630);
await render(OUT_TWITTER, 1200, 675);
console.log('Done.');
