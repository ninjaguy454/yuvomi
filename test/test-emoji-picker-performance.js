// Repeatable render benchmark: a fresh browser per sample keeps glyph caches cold.
// Uses the same local CSS, WebView-shaped UA and 4x CPU model as Rewards browser QA.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import puppeteer from 'puppeteer';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const styles = [...readFileSync(`${publicDir}/index.html`, 'utf8').matchAll(/<link rel="stylesheet" href="([^\"]+)"\s*\/>/g)].map(match => match[0]).join('\n');
const app = express(); app.use(express.static(publicDir));
app.get('/emoji-performance', (_req, res) => res.send(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">${styles}<link rel="stylesheet" href="/styles/emoji-picker.css"><style>*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}html,body{margin:0}</style></head><body><button id="open">Choose icon</button></body></html>`));

test('cold browser emoji rendering benchmark at 1920x1080 and 4x CPU', async t => {
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.on('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`, samples = [];
  try {
    for (let sample = 0; sample < Number(process.env.EMOJI_PERF_SAMPLES || 3); sample++) {
      const browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
      try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
        await page.setUserAgent('Mozilla/5.0 (Linux; Android 16; Apolosign Build/BP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.7339.155 Safari/537.36 FullyKiosk/1.59');
        await page.goto(`${base}/emoji-performance`);
        const cdp = await page.createCDPSession(); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        await page.evaluate(async () => {
          localStorage.clear(); localStorage.setItem('yuvomi-locale', 'en');
          document.documentElement.dataset.theme = 'dark'; document.documentElement.dataset.colorTheme = 'warm';
          await (await import('/i18n.js')).initI18n();
          const { openEmojiPicker } = await import('/components/emoji-picker.js');
          document.querySelector('#open').onclick = () => openEmojiPicker({ userId: 1, locale: 'en' });
        });
        if (process.env.EMOJI_PERF_TRACE) { mkdirSync(process.env.EMOJI_PERF_TRACE, { recursive: true }); await page.tracing.start({ path: `${process.env.EMOJI_PERF_TRACE}/sample-${sample + 1}.json`, categories: ['devtools.timeline', 'blink.user_timing', 'v8', 'disabled-by-default-devtools.timeline'] }); }
        const result = await page.evaluate(async () => {
          const painted = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
          const waitFor = async predicate => { const start = performance.now(); while (!predicate()) { if (performance.now() - start > 10000) throw new Error('Picker did not render'); await new Promise(requestAnimationFrame); } };
          const tiles = () => [...document.querySelectorAll('.emoji-picker__grid button')];
          const glyphCount = () => tiles().filter(tile => tile.textContent).length;
          const rendered = () => document.querySelector('.emoji-picker__grid button')?.textContent;
          const tasks = []; new PerformanceObserver(list => tasks.push(...list.getEntries().map(entry => ({ start: entry.startTime, duration: entry.duration })))).observe({ type: 'longtask', buffered: true });
          const start = performance.now(); document.querySelector('#open').click(); await painted(); const shell = performance.now() - start;
          await waitFor(rendered); await painted(); const open = performance.now() - start, openGlyphs = glyphCount();
          await delay(1000);
          const categoryStart = performance.now(); document.querySelector('[data-category="1"]').click(); await painted();
          const category = performance.now() - categoryStart, categoryGlyphs = glyphCount();
          await delay(1000);
          const viewport = document.querySelector('.emoji-picker__viewport');
          const coldStart = performance.now(); viewport.scrollTop = 120; await painted(); const coldScroll = performance.now() - coldStart;
          await delay(500); viewport.scrollTop = 0; await painted(); await delay(100);
          performance.mark('warm-scroll-start'); const warmStart = performance.now(); viewport.scrollTop = 120; await painted(); const warmScroll = performance.now() - warmStart; performance.mark('warm-scroll-end');
          await delay(500);
          const input = document.querySelector('.emoji-picker input');
          const search = [];
          for (const query of ['movie', 'money', 'ice cream', 'birthday']) {
            const at = performance.now(); input.value = query; input.dispatchEvent(new Event('input', { bubbles: true })); await painted(); search.push(performance.now() - at); await delay(80);
          }
          const typing = [];
          for (const query of ['b', 'bi', 'bir', 'birt', 'birth', 'birthd', 'birthda', 'birthday']) {
            const at = performance.now(); input.value = query; input.dispatchEvent(new Event('input', { bubbles: true })); await painted(); typing.push(performance.now() - at); await delay(80);
          }
          return { shell, open, openGlyphs, category, categoryGlyphs, coldScroll, warmScroll, search, typing, peakLongTask: Math.max(0, ...tasks.filter(task => task.start >= start).map(task => task.duration)), dom: tiles().length };
        });
        if (process.env.EMOJI_PERF_TRACE) await page.tracing.stop();
        samples.push(result); t.diagnostic(JSON.stringify({ sample: sample + 1, ...result }));
        assert.ok(result.open < 10000); assert.ok(result.dom <= 196);
      } finally { await browser.close(); }
    }
    if (process.env.EMOJI_PERF_OUTPUT) {
      mkdirSync(path.dirname(process.env.EMOJI_PERF_OUTPUT), { recursive: true });
      writeFileSync(process.env.EMOJI_PERF_OUTPUT, JSON.stringify({ browser: 'Chrome Headless Shell 146.0.7680.31', viewport: '1920x1080', cpuRate: 4, samples }, null, 2));
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
