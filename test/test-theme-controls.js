import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import puppeteer from 'puppeteer';

// Real shared styles, including their cascade and system-appearance overrides.
// This fixture has no account, API, browser storage or production data.
const styles = [...readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  .matchAll(/<link rel="stylesheet" href="[^"]+"\s*\/>/g)].map(([tag]) => tag).join('');
const app = express();
app.get('/fixture', (_req, res) => res.send(`<!doctype html><html lang="en"><head>
  <meta name="viewport" content="width=device-width, initial-scale=1">${styles}</head><body>
  <nav class="nav-sidebar"><a class="nav-item" aria-current="page" href="#"><span class="nav-item__icon">◆</span><span class="nav-item__label">Kitchen</span></a></nav>
  <main style="margin:24px 24px 24px 300px"><button id="primary" class="btn btn--primary">New recipe</button>
  <button id="selected" class="rrule-day rrule-day--active">M</button>
  <button id="disabled" class="btn btn--primary" disabled>Save</button>
  <input id="field" class="input" aria-label="Recipe title"></main></body></html>`));
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
let server, browser, base;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || (process.platform === 'win32' && existsSync(edge) ? edge : undefined), args: ['--no-sandbox'] });
});
test.after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve) || resolve()); });
const expected = {
  neutral: { light: '#4b5357', dark: '#b7c1c7' },
  warm: { light: '#805632', dark: '#d2ab80' },
  cool: { light: '#3d617e', dark: '#9bbad1' },
};
async function sample(page) {
  return page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d');
    function rgba(color) { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data]; }
    function luminance(color) { const c = color.slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return c[0] * .2126 + c[1] * .7152 + c[2] * .0722; }
    function contrast(a, b) { const hi = Math.max(luminance(a), luminance(b)), lo = Math.min(luminance(a), luminance(b)); return (hi + .05) / (lo + .05); }
    const accent = root.getPropertyValue('--color-accent').trim();
    const controls = ['primary', 'selected'].map(id => { const css = getComputedStyle(document.getElementById(id)); return { id, contrast: contrast(rgba(css.color), rgba(css.backgroundColor)) }; });
    const focus = contrast(rgba(root.getPropertyValue('--focus-ring-color')), rgba(root.getPropertyValue('--color-surface-raised')));
    const nav = getComputedStyle(document.querySelector('.nav-item'));
    const navBase = rgba(root.getPropertyValue('--sidebar-bg'));
    const tint = rgba(nav.backgroundColor); const alpha = tint[3] / 255;
    const navFill = tint.slice(0, 3).map((v, i) => v * alpha + navBase[i] * (1 - alpha));
    const navContrast = contrast(rgba(getComputedStyle(document.querySelector('.nav-item__label')).color), navFill);
    return { accent, controls, focus, navContrast, disabled: document.querySelector('#disabled').disabled, disabledOpacity: Number(getComputedStyle(document.querySelector('#disabled')).opacity) };
  });
}
for (const color of Object.keys(expected)) for (const mode of ['light', 'dark']) {
  test(`${color}/${mode}: real selected controls, action labels, focus and system appearance`, async () => {
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: 1366, height: 900 });
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: mode }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
      await page.goto(base + '/fixture');
      await page.evaluate(({ color, mode }) => { Object.assign(document.documentElement.dataset, { colorTheme: color, theme: mode, typography: 'serif' }); }, { color, mode });
      const explicit = await sample(page);
      assert.equal(explicit.accent.toLowerCase(), expected[color][mode]);
      for (const control of explicit.controls) assert.ok(control.contrast >= 4.5, `${control.id}: ${control.contrast}`);
      assert.ok(explicit.focus >= 3, `focus: ${explicit.focus}`);
      assert.ok(explicit.navContrast >= 4.5, `selected navigation: ${explicit.navContrast}`);
      assert.ok(explicit.disabled && explicit.disabledOpacity < 1, 'disabled action remains visibly disabled');
      await page.hover('#primary');
      const hovered = await sample(page);
      assert.ok(hovered.controls[0].contrast >= 4.5, `hovered action: ${hovered.controls[0].contrast}`);
      await page.evaluate(() => delete document.documentElement.dataset.theme);
      assert.equal((await sample(page)).accent, explicit.accent, 'system appearance inherits the same palette');
    } finally { await page.close(); }
  });
}
