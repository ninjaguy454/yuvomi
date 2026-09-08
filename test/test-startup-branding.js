import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import puppeteer from 'puppeteer';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const index = read('public/index.html');
const loading = index.match(/<div id="app-loading"[\s\S]*?\n    <\/div>/)?.[0];
const styles = ['tokens', 'reset', 'layout'].map(name => read(`public/styles/${name}.css`)).join('\n');
let browser;

before(async () => {
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  browser = await puppeteer.launch({ headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || (process.platform === 'win32' && existsSync(edge) ? edge : undefined),
    args: ['--no-sandbox'],
  });
});
after(async () => { await browser?.close(); });

async function pageFor({ reduced = false, wall = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }]);
  await page.setContent(`<!doctype html><html${wall ? ' data-wall-mode' : ''}><head><style>${styles}</style></head><body>${loading}</body></html>`);
  return page;
}

test('launch mark uses canonical oval geometry and keeps its accessible loading identity', async () => {
  assert.ok(loading, 'the initial document must contain the loading surface');
  const page = await pageFor({ reduced: true });
  try {
    const actual = await page.evaluate(() => {
      const svg = document.querySelector('.app-loading__mark');
      return {
        label: document.querySelector('#app-loading').getAttribute('aria-label'),
        hidden: svg.getAttribute('aria-hidden'), focusable: svg.getAttribute('focusable'),
        viewBox: svg.getAttribute('viewBox'),
        ellipses: [...svg.querySelectorAll('ellipse')].map(ellipse => ellipse.outerHTML),
        name: document.querySelector('.app-loading__wordmark').textContent,
      };
    });
    assert.match(actual.label, /Vidamia/);
    assert.equal(actual.hidden, 'true'); assert.equal(actual.focusable, 'false');
    assert.equal(actual.viewBox, '0 0 160 160'); assert.equal(actual.name, 'Vidamia');
    const canonical = read('public/icons/vidamia-mark.svg');
    const canonicalEllipses = [...canonical.matchAll(/<ellipse\b[^>]*\/>/g)].map(([ellipse]) => ellipse.replace('/>', '></ellipse>'));
    assert.deepEqual(actual.ellipses, canonicalEllipses, 'generated startup geometry must match the static identity');
  } finally { await page.close(); }
});

test('the login introduction uses the approved localized copy', () => {
  const english = JSON.parse(read('public/locales/en.json'));
  assert.equal(english.login.tagline, 'Your life, together.');
  assert.match(read('public/pages/login.js'), /esc\(t\('login\.tagline'\)\)/);
  assert.doesNotMatch(read('public/pages/login.js'), /Your life, together\./);
});

test('launch turns one oval, converges into the final mark and finishes exactly once within 1.4 seconds', async () => {
  const page = await pageFor();
  try {
    const result = await page.evaluate(() => {
      const surface = document.querySelector('#app-loading');
      const animations = surface.getAnimations({ subtree: true });
      const style = selector => {
        const computed = getComputedStyle(document.querySelector(selector));
        return { opacity: computed.opacity, transform: computed.transform };
      };
      for (const animation of animations) { animation.pause(); animation.currentTime = 0; }
      const start = { first: style('.app-loading__oval--first'), second: style('.app-loading__oval--second'), name: style('.app-loading__wordmark') };
      const timings = animations.map(animation => ({
        target: animation.effect.target.classList.contains('app-loading__wordmark') ? 'name' : 'mark',
        delay: animation.effect.getTiming().delay,
        iterations: animation.effect.getTiming().iterations,
        endTime: animation.effect.getComputedTiming().endTime,
      }));
      for (const animation of animations) animation.finish();
      const end = { first: style('.app-loading__oval--first'), second: style('.app-loading__oval--second'), name: style('.app-loading__wordmark') };
      for (const animation of animations) animation.currentTime = 4000;
      const longLoad = { first: style('.app-loading__oval--first'), second: style('.app-loading__oval--second'), name: style('.app-loading__wordmark') };
      return { start, end, longLoad, timings, states: animations.map(animation => animation.playState) };
    });
    assert.equal(result.timings.length, 4);
    assert.equal(result.start.first.opacity, '1'); assert.equal(result.start.second.opacity, '0');
    assert.equal(result.start.name.opacity, '0');
    assert.notEqual(result.start.first.transform, 'none');
    for (const value of Object.values(result.end)) {
      assert.equal(value.opacity, '1');
      assert.ok(['none', 'matrix(1, 0, 0, 1, 0, 0)'].includes(value.transform), 'final identity must be static');
    }
    assert.ok(result.timings.every(timing => timing.iterations === 1));
    assert.ok(result.timings.find(timing => timing.target === 'name').delay >=
      Math.max(...result.timings.filter(timing => timing.target === 'mark').map(timing => timing.endTime)),
    'the wordmark reveals only after the final oval composition has settled');
    assert.ok(Math.max(...result.timings.map(timing => timing.endTime)) >= 900);
    assert.ok(Math.max(...result.timings.map(timing => timing.endTime)) <= 1400);
    assert.ok(result.states.every(state => state === 'finished'));
    assert.deepEqual(result.longLoad, result.end, 'a slow load must retain the static final identity after four seconds');
  } finally { await page.close(); }
});

test('reduced motion shows the final lockup immediately, including shared display startup', async () => {
  for (const wall of [false, true]) {
    const page = await pageFor({ reduced: true, wall });
    try {
      const result = await page.evaluate(() => ({
        count: document.querySelector('#app-loading').getAnimations({ subtree: true }).length,
        styles: [...document.querySelectorAll('.app-loading__spin, .app-loading__oval, .app-loading__wordmark')]
          .map(element => ({ transform: getComputedStyle(element).transform, opacity: getComputedStyle(element).opacity })),
      }));
      assert.equal(result.count, 0);
      assert.ok(result.styles.every(style => style.transform === 'none' && style.opacity === '1'));
    } finally { await page.close(); }
  }
});

test('page readiness hides startup immediately without waiting for its animation', async () => {
  const router = read('public/router.js');
  const start = router.indexOf('async function renderPage(');
  assert.notEqual(start, -1);
  const prefix = router.slice(router.indexOf('{', start) + 1, router.indexOf('\n  try {', start));
  const surface = { hidden: false };
  const document = { getElementById: id => id === 'app-loading' ? surface : {} };
  // Run the actual readiness path with no timers, events or animation API available.
  new Function('document', prefix)(document);
  assert.equal(surface.hidden, true);
  assert.doesNotMatch(prefix, /\bawait\b|setTimeout|animationend|animationiteration/);
  const page = await pageFor();
  try {
    const result = await page.evaluate(prefix => {
      const loading = document.querySelector('#app-loading');
      for (const animation of loading.getAnimations({ subtree: true })) {
        animation.pause(); animation.currentTime = 100;
      }
      const activeBeforeReady = loading.getAnimations({ subtree: true }).length;
      new Function('document', prefix)(document);
      return { hidden: loading.hidden, display: getComputedStyle(loading).display,
        animations: loading.getAnimations({ subtree: true }).length,
        rectangles: loading.getClientRects().length, activeBeforeReady };
    }, prefix);
    assert.equal(result.activeBeforeReady, 4, 'fast readiness occurs during the launch gesture');
    assert.equal(result.hidden, true); assert.equal(result.display, 'none');
    assert.equal(result.rectangles, 0);
    assert.equal(result.animations, 0, 'hidden startup must stop animating when the app is ready');
  } finally { await page.close(); }
});
