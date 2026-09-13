import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import puppeteer from 'puppeteer';

const app = express();
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
app.get('/selection-fixture', (_req, res) => res.send(`<!doctype html><html lang="en"><head>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>body{margin:0;font:16px sans-serif}.task-card{margin:12px;padding:16px;border:1px solid;min-height:300px}
  button{padding:14px;font:inherit}.body{height:120px;padding:10px}.swipe-reveal{display:none}input{width:20px;height:20px}
  .activity-card__open{display:block;width:100%;text-align:left}</style></head><body><main></main></body></html>`));
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

async function mount({ mobile = false, width = 1024, height = 768 } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
  await page.goto(`${base}/selection-fixture`);
  await page.evaluate(async () => {
    const { bindTaskCardSelection } = await import('/utils/task-card-selection.js');
    const { wireSwipeRows } = await import('/utils/swipe-row.js');
    const root = document.querySelector('main');
    root.innerHTML = Array.from({ length: 18 }, (_, index) => `<div class="swipe-row" data-swipe-id="${72 + index}">
      <div class="swipe-reveal leading"></div><div class="swipe-reveal trailing"></div>
      <article class="task-card activity-card" data-task-id="${72 + index}">
        <button class="activity-card__open" data-action="open-task" data-id="${72 + index}" aria-keyshortcuts="Shift+Space"><span>Laundry ${index + 1}</span></button>
        <div class="body">Household Task instructions — this text remains a normal scrolling surface.</div>
        <input type="checkbox" aria-label="Existing selection"><button data-action="toggle-status">Status</button>
        <div class="subtask-item" data-subtask-id="900"><button data-action="open-task" data-id="900">Child action</button></div>
      </article></div>`).join('');
    window.selections = []; window.opens = []; window.swipes = []; window.preventedMoves = 0;
    window.disposeSelection = bindTaskCardSelection(root, {
      canSelect: () => true,
      onSelect: card => {
        window.selections.push(card.dataset.taskId);
        let checkbox = card.querySelector('[data-bulk]');
        if (!checkbox) {
          checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.dataset.bulk = '';
          checkbox.setAttribute('aria-label', 'Select Task'); card.append(checkbox);
        }
        checkbox.checked = true; checkbox.focus({ preventScroll: true });
      },
    });
    wireSwipeRows(root, { card: '.task-card',
      leading: { reveal: '.leading', run: row => window.swipes.push({ id: row.dataset.swipeId, action: 'complete' }) },
      trailing: { reveal: '.trailing', run: row => window.swipes.push({ id: row.dataset.swipeId, action: 'edit' }) },
    });
    root.addEventListener('click', event => { const action = event.target.closest('[data-action]'); if (action) window.opens.push(action.dataset.id || action.dataset.action); });
    root.addEventListener('touchmove', event => { if (event.defaultPrevented) window.preventedMoves++; }, { passive: true });
  });
  return page;
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function position(page, selector) {
  return page.$eval(selector, element => { const r = element.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
}
async function touch(page, from, { to = from, hold = 0, steps = 1 } = {}) {
  const cdp = await page.createCDPSession();
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...from, id: 1 }] });
    if (hold) await wait(hold);
    if (to !== from) for (let step = 1; step <= steps; step++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{
        x: from.x + (to.x - from.x) * step / steps,
        y: from.y + (to.y - from.y) * step / steps, id: 1,
      }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally { await cdp.detach(); }
}
const state = page => page.evaluate(() => ({ selections: window.selections, opens: window.opens, swipes: window.swipes,
  scrollY, prevented: window.preventedMoves, checked: document.querySelector('[data-bulk]')?.checked,
  armed: !!document.querySelector('.swipe-row--armed, .swipe-row--swiping') }));

test('mouse click opens normally; stationary hold selects once and does not open details', async () => {
  const page = await mount();
  try {
    await page.click('.activity-card__open');
    assert.deepEqual((await state(page)).opens, ['72']);
    const point = await position(page, '.activity-card__open');
    await page.mouse.move(point.x, point.y); await page.mouse.down(); await wait(1100); await page.mouse.up();
    const result = await state(page);
    assert.deepEqual(result.selections, ['72']); assert.deepEqual(result.opens, ['72']); assert.equal(result.checked, true);
    await page.click('.activity-card__open'); assert.deepEqual((await state(page)).opens, ['72', '72']);
  } finally { await page.close(); }
});

test('Shift+Space selects without toggling the new checkbox or opening; ordinary keyboard activation still opens', async () => {
  const page = await mount();
  try {
    await page.focus('.activity-card__open'); await page.keyboard.down('Shift'); await page.keyboard.press('Space'); await page.keyboard.up('Shift');
    const selected = await state(page);
    assert.deepEqual(selected.selections, ['72']); assert.deepEqual(selected.opens, []); assert.equal(selected.checked, true);
    await page.focus('.activity-card__open'); await page.keyboard.press('Enter');
    assert.deepEqual((await state(page)).opens, ['72']);
  } finally { await page.close(); }
});

for (const [device, width, height] of [['iPhone size', 390, 844], ['Android size', 412, 915]]) {
  test(`${device}: one-second touch hold selects without opening the title`, async () => {
    const page = await mount({ mobile: true, width, height });
    try {
      await touch(page, await position(page, '.activity-card__open'), { hold: 1100 });
      const result = await state(page);
      assert.deepEqual(result.selections, ['72']); assert.deepEqual(result.opens, []); assert.deepEqual(result.swipes, []);
      assert.equal(result.checked, true); assert.equal(result.scrollY, 0);
    } finally { await page.close(); }
  });
  test(`${device}: vertical card flick scrolls without selection or preventing native movement`, async () => {
    const page = await mount({ mobile: true, width, height });
    try {
      const from = await position(page, '.body');
      await touch(page, from, { to: { x: from.x + 2, y: 10 }, steps: 3 });
      await page.waitForFunction(() => scrollY > 60); await wait(1100);
      const result = await state(page);
      assert.deepEqual(result.selections, []); assert.deepEqual(result.swipes, []); assert.equal(result.prevented, 0);
    } finally { await page.close(); }
  });
  test(`${device}: held selection followed by horizontal movement cannot also complete or edit through legacy swipe`, async () => {
    const page = await mount({ mobile: true, width, height });
    try {
      const from = await position(page, '.body');
      await touch(page, from, { hold: 1100, to: { x: from.x + 140, y: from.y + 1 }, steps: 4 });
      const result = await state(page);
      assert.deepEqual(result.selections, ['72']); assert.deepEqual(result.swipes, []); assert.deepEqual(result.opens, []);
      assert.equal(result.armed, false);
    } finally { await page.close(); }
  });
  test(`${device}: checkbox and child action holds do not select the parent`, async () => {
    const page = await mount({ mobile: true, width, height });
    try {
      await touch(page, await position(page, 'input'), { hold: 1100 });
      await touch(page, await position(page, '.subtask-item button'), { hold: 1100 });
      assert.deepEqual((await state(page)).selections, []);
    } finally { await page.close(); }
  });
}
