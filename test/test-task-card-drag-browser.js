import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import puppeteer from 'puppeteer';

// Real Chromium touch input and scrolling against the production gesture helper
// and styles. This is device-size emulation, not physical iOS/Android testing.
const app = express();
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
app.get('/task-gesture-fixture', (_req, res) => res.send(`<!doctype html><html lang="en"><head>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/styles/tokens.css"><link rel="stylesheet" href="/styles/layout.css">
  <link rel="stylesheet" href="/styles/tasks.css">
  <style>
    html, body { height:auto; min-height:100%; overflow-y:auto; margin:0; }
    .fixture-board { display:flex; align-items:flex-start; gap:16px; overflow-x:auto; width:100%; padding:12px; box-sizing:border-box; }
    .fixture-bucket { flex:0 0 340px; min-width:340px; }
    .fixture-card { min-height:180px; margin-bottom:12px; }
    .fixture-text { min-height:100px; margin:0; padding:8px; }
    .fixture-target { min-height:190px; border:2px dashed currentColor; }
    .fixture-target-label { margin:0; padding:12px; }
  </style></head><body><main></main></body></html>`));
let server, browser, base;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  browser = await puppeteer.launch({ headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || (process.platform === 'win32' && existsSync(edge) ? edge : undefined),
    args: ['--no-sandbox', '--disable-dev-shm-usage'] });
});
test.after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve) || resolve()); });

async function mounted(width, height) {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewport({ width, height, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  await page.goto(`${base}/task-gesture-fixture`);
  await page.evaluate(async () => {
    const { bindTaskCardTouchDrag } = await import('/utils/task-card-drag.js');
    const card = (id, title) => `<article class="kanban-card activity-card fixture-card" data-task-id="${id}">
      <button class="task-card__drag-handle" data-task-drag-handle data-action="open-task" data-id="${id}"
        draggable="true" aria-label="Move Task: ${title}" title="Drag to move; tap for Task status">⠿</button>
      <div class="fixture-text">${title} — normal card text and scroll surface.</div>
    </article>`;
    document.querySelector('main').innerHTML = `<div class="kanban-board fixture-board">
      <section class="fixture-bucket" data-bucket-key="Eleanor">
        <div class="kanban-col__body" data-drop-zone="open">${card(72, 'Laundry')}</div>
        <div class="kanban-col__body fixture-target" data-drop-zone="in_progress"><p class="fixture-target-label">In Progress</p></div>
        <div class="kanban-col__body long-list" data-drop-zone="done">${Array.from({ length: 20 }, (_, i) => card(100 + i, `Household Task ${i + 1}`)).join('')}</div>
      </section>
      <section class="fixture-bucket" data-bucket-key="Frank"><div class="kanban-col__body" data-drop-zone="open">${card(90, 'Frank laundry')}</div></section>
      <section class="fixture-bucket" data-bucket-key="Duane"><div class="kanban-col__body" data-drop-zone="open">${card(91, 'Kitchen')}</div></section>
    </div>`;
    window.gestureDrops = []; window.gestureStates = []; window.handleOpens = [];
    window.moveEvents = []; window.touchStarts = []; window.nativeStarts = 0;
    const board = document.querySelector('.kanban-board');
    board.addEventListener('touchstart', event => window.touchStarts.push(event.target.closest('[data-task-id]')?.dataset.taskId), { passive: true });
    window.disposeGesture = bindTaskCardTouchDrag(board, {
      canDrag: card => card.dataset.taskId !== '91',
      onDrop: ({ taskId, sourceBucketKey, zone }) => window.gestureDrops.push({ taskId, sourceBucketKey, status: zone.dataset.dropZone }),
      onDragStateChange: active => window.gestureStates.push(active),
    });
    board.addEventListener('touchmove', event => window.moveEvents.push({ prevented: event.defaultPrevented, cancelable: event.cancelable }), { passive: true });
    board.addEventListener('click', event => {
      const handle = event.target.closest('[data-task-drag-handle]');
      if (handle) window.handleOpens.push(handle.dataset.id);
    });
    board.addEventListener('dragstart', () => window.nativeStarts++);
  });
  return { page, errors };
}

async function point(page, selector, { x = .5, y = .5 } = {}) {
  return page.$eval(selector, (element, relative) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width * relative.x, y: rect.top + rect.height * relative.y };
  }, { x, y });
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function gesture(page, from, to, { hold = 0, steps = 7, interval = 0 } = {}) {
  const cdp = await page.createCDPSession();
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...from, id: 1 }] });
    if (hold) await wait(hold);
    for (let step = 1; step <= steps; step++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{
        x: from.x + (to.x - from.x) * step / steps,
        y: from.y + (to.y - from.y) * step / steps, id: 1,
      }] });
      if (interval) await wait(interval);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally { await cdp.detach(); }
}
async function outcome(page) {
  return page.evaluate(() => ({
    drops: window.gestureDrops, states: window.gestureStates, clicks: window.handleOpens,
    scrollY, scrollX: document.querySelector('.kanban-board').scrollLeft,
    prevented: window.moveEvents.filter(event => event.prevented).length,
    moves: window.moveEvents.length,
    dragging: !!document.querySelector('.kanban-board--dragging, .kanban-card--ghost'),
    nativeStarts: window.nativeStarts,
  }));
}

for (const [device, width, height] of [['iPhone size', 390, 844], ['Android size', 412, 915]]) {
  test(`${device}: normal vertical swipe touching card text scrolls without a drag`, async () => {
    const { page, errors } = await mounted(width, height);
    try {
      const from = await point(page, '[data-task-id="72"] .fixture-text', { y: .8 });
      await gesture(page, from, { x: from.x + 3, y: 18 }, { interval: 15 });
      await page.waitForFunction(() => scrollY > 50);
      const result = await outcome(page);
      assert.deepEqual(result.drops, []); assert.deepEqual(result.states, []);
      assert.equal(result.prevented, 0); assert.ok(result.moves > 0);
      assert.equal(result.dragging, false); assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  test(`${device}: rapid flick through a long Task list preserves native momentum`, async () => {
    const { page, errors } = await mounted(width, height);
    try {
      const from = await point(page, '[data-task-id="100"] .fixture-text');
      await gesture(page, from, { x: from.x + 8, y: 70 }, { steps: 3 });
      await page.waitForFunction(() => scrollY > 250);
      const result = await outcome(page);
      assert.deepEqual(result.drops, []); assert.deepEqual(result.states, []);
      assert.equal(result.prevented, 0); assert.equal(result.dragging, false);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  test(`${device}: swiping from the handle before its hold cancels drag and scrolls`, async () => {
    const { page, errors } = await mounted(width, height);
    try {
      const from = await point(page, '[data-task-id="100"] [data-task-drag-handle]');
      await gesture(page, from, { x: from.x + 2, y: from.y - 180 }, { steps: 4 });
      await page.waitForFunction(() => scrollY > 80);
      const result = await outcome(page);
      assert.deepEqual(result.drops, []); assert.deepEqual(result.states, []);
      assert.deepEqual(result.clicks, []); assert.equal(result.prevented, 0);
      assert.equal(result.nativeStarts, 0); assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  test(`${device}: intentional held handle drag drops exactly once without native scroll or a click`, async () => {
    const { page, errors } = await mounted(width, height);
    try {
      const from = await point(page, '[data-task-id="72"] [data-task-drag-handle]');
      const to = await point(page, '.fixture-target');
      await gesture(page, from, to, { hold: 220, interval: 10 });
      await page.waitForFunction(() => window.gestureDrops.length === 1);
      const result = await outcome(page);
      assert.deepEqual(result.drops, [{ taskId: '72', sourceBucketKey: 'Eleanor', status: 'in_progress' }]);
      assert.deepEqual(result.states, [true, false]); assert.deepEqual(result.clicks, []);
      assert.equal(result.scrollY, 0); assert.equal(result.scrollX, 0);
      assert.ok(result.prevented > 0); assert.equal(result.dragging, false);
      assert.equal(result.nativeStarts, 0); assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  test(`${device}: horizontal Kanban swipe on a card moves the board without dragging a Task`, async () => {
    const { page, errors } = await mounted(width, height);
    try {
      const from = await point(page, '[data-task-id="72"] .fixture-text', { x: .8 });
      await gesture(page, from, { x: 24, y: from.y + 3 }, { interval: 15 });
      await page.waitForFunction(() => document.querySelector('.kanban-board').scrollLeft > 100);
      const result = await outcome(page);
      assert.deepEqual(result.drops, []); assert.deepEqual(result.states, []);
      assert.equal(result.prevented, 0); assert.equal(result.scrollY, 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  test(`${device}: tiny tap movement and keyboard activation keep the labelled 44px status alternative`, async () => {
    const { page, errors } = await mounted(width, height);
    try {
      const selector = '[data-task-id="72"] [data-task-drag-handle]';
      const from = await point(page, selector);
      await gesture(page, from, { x: from.x + 2, y: from.y + 2 }, { steps: 1 });
      await page.waitForFunction(() => window.handleOpens.length === 1);
      await page.focus(selector);
      await page.keyboard.press('Enter');
      await page.keyboard.press('Space');
      const result = await outcome(page);
      assert.deepEqual(result.clicks, ['72', '72', '72']);
      assert.deepEqual(result.drops, []); assert.deepEqual(result.states, []);
      const control = await page.$eval(selector, element => {
        const rect = element.getBoundingClientRect();
        return { label: element.getAttribute('aria-label'), tag: element.tagName, width: rect.width, height: rect.height, touchAction: getComputedStyle(element).touchAction };
      });
      assert.equal(control.label, 'Move Task: Laundry'); assert.equal(control.tag, 'BUTTON');
      assert.ok(control.width >= 44 && control.height >= 44); assert.equal(control.touchAction, 'auto');
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}
