import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import puppeteer from 'puppeteer';

// Real modal, dirty guard, child suspension, CSS, and browser history. Only the
// fixture content is synthetic; dismissal is driven by actual browser input.
const styles = [...readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  .matchAll(/<link rel="stylesheet" href="[^"]+"\s*\/>/g)].map(([tag]) => tag).join('');
const app = express();
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
app.get('/modal-dismissal-fixture', (_req, res) => res.send(`<!doctype html>
  <html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">${styles}</head>
  <body><main><button id="outside">Open editor</button></main></body></html>`));
let server, browser, base;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  browser = await puppeteer.launch({ headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || (process.platform === 'win32' && existsSync(edge) ? edge : undefined),
    args: ['--no-sandbox'] });
});
test.after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve) || resolve()); });

async function openPage({ mobile = false, dirty = true, long = true } = {}) {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewport({ width: mobile ? 390 : 1366, height: mobile ? 844 : 900, isMobile: mobile, hasTouch: mobile });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(`${base}/modal-dismissal-fixture`);
  await page.evaluate(async ({ dirty, long }) => {
    await (await import('/i18n.js')).initI18n(); await (await import('/i18n.js')).setLocale('en');
    Object.assign(document.documentElement.dataset, { theme: 'dark', colorTheme: 'warm', typography: 'serif' });
    window.modal = await import('/components/modal.js');
    const overlays = await import('/utils/overlay-history.js');
    window.routingAttempts = 0;
    window.addEventListener('popstate', async () => { if (!await overlays.handleBackNavigation()) window.routingAttempts++; });
    window.clickTargets = [];
    document.addEventListener('click', event => window.clickTargets.push(event.target.className), true);
    window.openFixture = ({ child = false, long = true } = {}) => {
      const options = { title: child ? 'Child editor' : 'Long editor', initialFocus: 'none',
        content: `<form><label>Draft<textarea name="draft">Saved draft</textarea></label>
          <p class="fixture-text">Select this ordinary paragraph quickly. Dragging its words outside the panel must never ask to discard an edited form.</p>
          <div class="fixture-box" style="user-select:none;min-height:40px">Drag here without selecting text.</div>
          <label>Choice<select name="choice"><option>First option</option><option>Second option</option></select></label>
          <button type="button" class="fixture-child">Open child editor</button>
          ${long ? Array.from({length:45}, (_, index) => `<p>Scrollable paragraph ${index + 1}. Keep this draft while reading and scrolling through the household instructions.</p>`).join('') : ''}
          <div class="modal-actions"><button type="button" data-action="close-modal" class="fixture-cancel btn btn--secondary">Cancel</button></div></form>`,
        onSave(panel) {
          panel.querySelector('.fixture-child').addEventListener('click', () => window.openFixture({ child: true, long: false }));
          window.modal.refreshDirtySnapshot({ defer: false });
        } };
      if (child) window.childSession = window.modal.openChildModal(options);
      else window.modal.openModal(options);
    };
    document.querySelector('#outside').focus(); window.openFixture({ long });
    if (dirty) document.querySelector('[name="draft"]').value = 'Unsaved household instructions';
  }, { dirty, long });
  await page.waitForFunction(() => history.state?.overlay === true);
  return { page, errors };
}
async function assertEditor(page, title = 'Long editor') {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.$('#confirm-modal-ok'), null, 'ordinary interaction must not open discard confirmation');
  assert.equal(await page.$eval('#shared-modal-title', node => node.textContent), title);
  assert.equal(await page.$eval('#shared-modal-overlay [name="draft"]', node => node.value), 'Unsaved household instructions');
  assert.equal(await page.evaluate(() => window.routingAttempts), 0);
}
async function waitPrompt(page) { await page.waitForSelector('#confirm-modal-ok'); }
async function keepDraft(page) {
  await page.click('#confirm-modal-cancel');
  await page.waitForFunction(() => !document.querySelector('#confirm-modal-ok') && document.querySelector('#shared-modal-overlay [name="draft"]'));
  await assertEditor(page);
}
async function point(page, selector) {
  return page.$eval(selector, node => { const rect = node.getBoundingClientRect(); return { x: rect.left + Math.min(24, rect.width / 2), y: rect.top + Math.min(20, rect.height / 2) }; });
}
async function backdropPoint(page) {
  return page.$eval('.modal-panel', node => { const rect = node.getBoundingClientRect(); return { x: 4, y: Math.max(4, rect.top / 2) }; });
}
async function mouseDrag(page, from, to, steps = 8) {
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps }); await page.mouse.up();
}
async function swipe(page, from, to, interval = 0) {
  const cdp = await page.createCDPSession();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...from, id: 1 }] });
  for (let step = 1; step <= 6; step++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (to.x - from.x) * step / 6, y: from.y + (to.y - from.y) * step / 6, id: 1 }] });
    if (interval) await new Promise(resolve => setTimeout(resolve, interval));
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

test('dirty desktop modal: native text-selection drag ending on the backdrop never dismisses', async () => {
  const { page, errors } = await openPage();
  try {
    const from = await point(page, '.fixture-text');
    await mouseDrag(page, from, { x: 1360, y: from.y + 20 });
    assert.ok(await page.evaluate(() => String(getSelection()).length > 0), 'the browser really selected text');
    assert.ok(await page.evaluate(() => clickTargets.includes('modal-overlay')), 'the browser retargeted click to the common ancestor');
    await assertEditor(page); assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('dirty desktop modal: pointer down inside and up outside does not dismiss', async () => {
  const { page, errors } = await openPage();
  try {
    const from = await point(page, '.fixture-box');
    await mouseDrag(page, from, { x: 8, y: from.y });
    assert.ok(await page.evaluate(() => clickTargets.includes('modal-overlay')));
    await assertEditor(page); assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('backdrop drag returning to its start is not a click, but the next real click still prompts', async () => {
  const { page, errors } = await openPage();
  try {
    const start = await backdropPoint(page);
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.mouse.move(start.x + 60, start.y + 30, { steps: 4 });
    await page.mouse.move(start.x, start.y, { steps: 4 }); await page.mouse.up();
    await assertEditor(page);
    await page.mouse.click(start.x, start.y); await waitPrompt(page); await keepDraft(page);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('dirty mobile modal: fast downward scrolling at the top is not an implicit sheet dismiss', async () => {
  const { page, errors } = await openPage({ mobile: true });
  try {
    const from = await point(page, '.fixture-text');
    await swipe(page, from, { x: from.x + 2, y: Math.min(780, from.y + 210) });
    await assertEditor(page);
    const panel = await page.$eval('.modal-panel', node => node.style.transform);
    assert.equal(panel, '', 'ordinary scrolling must not translate the entire sheet');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('dirty mobile modal: fast touch scroll and simulated momentum after release retain the draft', async () => {
  const { page, errors } = await openPage({ mobile: true });
  try {
    await page.evaluate(() => {
      window.scrollEvents = []; window.touchReleasedAt = null;
      document.querySelector('.modal-panel__body').addEventListener('scroll', event => scrollEvents.push({ top: event.target.scrollTop, time: performance.now() }));
      document.addEventListener('touchend', () => window.touchReleasedAt = performance.now(), { once: true });
    });
    await swipe(page, { x:210, y:630 }, { x:210, y:240 }, 12);
    await page.waitForFunction(() => document.querySelector('.modal-panel__body').scrollTop > 100, { timeout: 3000 });
    // CDP does not consistently generate platform inertial scrolling. Drive
    // the same post-release scrolling phase with the browser's scroll animator
    // instead of treating synthetic touch events as a physical-device test.
    await page.$eval('.modal-panel__body', node => node.scrollBy({ top:250, behavior:'smooth' }));
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 350)));
    assert.ok(await page.evaluate(() => scrollEvents.length > 2), 'the real scroll container moved through successive frames');
    assert.ok(await page.evaluate(() => touchReleasedAt !== null && scrollEvents.some(event => event.time > touchReleasedAt + 20)), 'scrolling continued after the finger was released');
    await assertEditor(page); assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('dirty mobile modal: a downward scroll from the middle retains the draft and scrolls the body', async () => {
  const { page, errors } = await openPage({ mobile: true });
  try {
    await page.$eval('.modal-panel__body', node => { node.scrollTop = 650; });
    await swipe(page, { x: 180, y: 350 }, { x: 180, y: 630 });
    await page.waitForFunction(() => document.querySelector('.modal-panel__body').scrollTop < 600);
    await assertEditor(page); assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('mobile backdrop touch drag is ignored and a deliberate backdrop tap still prompts', async () => {
  const { page, errors } = await openPage({ mobile: true });
  try {
    const start = await backdropPoint(page);
    await swipe(page, { x: 90, y: start.y }, { x: 250, y: start.y });
    await assertEditor(page);
    await page.touchscreen.tap(190, start.y); await waitPrompt(page); await keepDraft(page);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const mobile of [false, true]) {
  test(`intentional backdrop ${mobile ? 'tap' : 'click'} preserves dirty confirmation and clean dismissal`, async () => {
    const { page, errors } = await openPage({ mobile });
    try {
      const pos = await backdropPoint(page);
      if (mobile) await page.touchscreen.tap(pos.x, pos.y); else await page.mouse.click(pos.x, pos.y);
      await waitPrompt(page); await keepDraft(page);
      await page.$eval('[name="draft"]', node => { node.value = 'Saved draft'; });
      if (mobile) await page.touchscreen.tap(pos.x, pos.y); else await page.mouse.click(pos.x, pos.y);
      await page.waitForFunction(() => !document.querySelector('.modal-overlay'));
      assert.equal(await page.$('#confirm-modal-ok'), null); assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

for (const action of ['Cancel', 'Close', 'Escape', 'Back']) test(`intentional ${action} keeps the dirty guard and supports keeping or discarding edits`, async () => {
  const { page, errors } = await openPage({ long: false });
  try {
    const close = async () => {
      if (action === 'Cancel') await page.click('.fixture-cancel');
      else if (action === 'Close') await page.click('.modal-panel__close');
      else if (action === 'Escape') await page.keyboard.press('Escape');
      else await page.evaluate(() => history.back());
    };
    await close(); await waitPrompt(page); await keepDraft(page);
    await page.waitForFunction(() => history.state?.overlay === true);
    await close(); await waitPrompt(page); await page.click('#confirm-modal-ok');
    await page.waitForFunction(() => !document.querySelector('.modal-overlay'));
    assert.equal(await page.evaluate(() => routingAttempts), 0);
    assert.equal(new URL(page.url()).pathname, '/modal-dismissal-fixture'); assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('nested popup consumes only its own backdrop clicks and returns the unchanged dirty parent', async () => {
  const { page, errors } = await openPage({ long: false });
  try {
    await page.click('.fixture-child'); await page.waitForFunction(() => document.querySelector('#shared-modal-title').textContent === 'Child editor');
    await page.$eval('#shared-modal-overlay [name="draft"]', node => { node.value = 'Unsaved household instructions'; });
    await mouseDrag(page, await point(page, '#shared-modal-overlay .fixture-box'), { x: 8, y: 300 });
    await assertEditor(page, 'Child editor');
    assert.equal(await page.$$eval('.modal-overlay[inert]', nodes => nodes.length), 1);
    await page.keyboard.press('Escape'); await waitPrompt(page); await page.click('#confirm-modal-ok');
    await page.waitForFunction(() => document.querySelector('#shared-modal-title')?.textContent === 'Long editor');
    await assertEditor(page);
    await page.mouse.click(4, 4); await waitPrompt(page); await keepDraft(page);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('dropdown interaction, wheel scrolling, and native scrollbar dragging never request dismissal', async () => {
  const { page, errors } = await openPage();
  try {
    await page.select('[name="choice"]', 'Second option');
    const rect = await page.$eval('.modal-panel__body', node => { const r = node.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom }; });
    await page.mouse.move(rect.left + 40, rect.top + 100); await page.mouse.wheel({ deltaY: 500 });
    await page.waitForFunction(() => document.querySelector('.modal-panel__body').scrollTop > 100);
    await mouseDrag(page, { x:rect.right - 3, y:rect.top + 50 }, { x:rect.right - 3, y:rect.bottom - 30 });
    await assertEditor(page); assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('drag-and-drop from modal content onto the backdrop does not become a close attempt', async () => {
  const { page, errors } = await openPage({ long: false });
  try {
    await page.evaluate(() => {
      window.drops = 0; window.drags = 0;
      const source = document.querySelector('.fixture-box'); source.draggable = true;
      source.addEventListener('dragstart', event => { drags++; event.dataTransfer.setData('text/plain', 'Household step'); });
      const overlay = document.querySelector('.modal-overlay');
      overlay.addEventListener('dragover', event => event.preventDefault());
      overlay.addEventListener('drop', event => { event.preventDefault(); if (event.dataTransfer.getData('text/plain') === 'Household step') drops++; });
    });
    await page.setDragInterception(true);
    await page.mouse.dragAndDrop(await point(page, '.fixture-box'), { x:10, y:300 });
    assert.deepEqual(await page.evaluate(() => ({ drags, drops })), { drags:1, drops:1 }, 'native drag-and-drop reached the outside target');
    await assertEditor(page); assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('a wheel gesture while the backdrop is pressed cancels dismissal eligibility', async () => {
  const { page, errors } = await openPage();
  try {
    const pos = await backdropPoint(page);
    await page.mouse.move(pos.x, pos.y); await page.mouse.down();
    await page.mouse.wheel({ deltaY:200 }); await page.mouse.up();
    await assertEditor(page);
    await page.mouse.click(pos.x, pos.y); await waitPrompt(page); await keepDraft(page);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
