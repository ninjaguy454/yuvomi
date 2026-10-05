import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'node:url';

const app = express(); let browser, server, base;
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
app.get('/overview-test', (_req, res) => res.send(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles/note-groups.css"><style>body{margin:0}#host{min-height:100vh}button{min-height:44px}#opener{margin:16px}</style></head><body><main id="host"><button id="opener">Overview</button></main></body></html>`));
test.before(async () => {
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
});
test.after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });

async function mount({ width = 1000, canManage = true, selected = [] } = {}) {
  const page = await browser.newPage(); page.setDefaultTimeout(5000); await page.setViewport({ width, height: 800 }); await page.goto(base + '/overview-test');
  const loaded = await page.evaluate(async ({ canManage, selected }) => {
    localStorage.setItem('yuvomi-locale', 'en'); await (await import('/i18n.js')).initI18n();
    const component = await import('/components/note-group-overview.js').catch(() => ({}));
    if (typeof component.openNoteGroupOverview !== 'function') return false;
    window.commands = []; window.activations = []; window.exits = []; window.abort = new AbortController();
    window.notes = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, title: `Page ${i + 1}`, content: `Authorized preview ${i + 1}`, revision: 1, permissions: { edit: true }, layout: { x: i * 4, y: 30, width: 4, height: 6, revision: 1 } }));
    window.group = { id: 10, revision: 4, can_manage: canManage, member_ids: [1,2,3,4,5,6,7,8,9,10], layout: { x: 0, y: 0, width: 4, height: 6, position_locked: true, always_on_top: true } };
    window.destination = { id: 20, revision: 2, can_manage: true, member_ids: [11,12], layout: { x: 8, y: 0, width: 4, height: 6 } };
    document.getElementById('opener').focus();
    window.openOverview = () => component.openNoteGroupOverview({ host: document.getElementById('host'), group: window.group, notes: window.notes, board: { notes: window.notes, groups: [window.group, window.destination] }, activeId: 1, selectedIds: selected, onActivate: id => window.activations.push(id), onCommand: command => { window.commands.push(command); return Promise.resolve({}); }, onExitDrag: session => window.exits.push(session), authentication: { signal: window.abort.signal, isCurrent: () => !window.abort.signal.aborted }, clientToWorld: (x, y) => ({ x: x / 100, y: y / 48 }) });
    window.overview = window.openOverview(); return true;
  }, { canManage, selected });
  assert.equal(loaded, true, 'group overview component exists'); return page;
}
async function select(page, ids) { for (const id of ids) await page.click(`[data-group-select="${id}"]`); }

test('overview presents authorized pages in canonical row-major order with accessible selection icons', async () => {
  const page = await mount(); try {
    const result = await page.evaluate(() => ({ ids: [...document.querySelectorAll('[data-group-page]')].map(el => Number(el.dataset.groupPage)), labels: [...document.querySelectorAll('[data-group-select]')].map(el => ({ label: el.getAttribute('aria-label'), selected: el.getAttribute('aria-pressed'), text: el.textContent.trim() })), geometry: [...document.querySelectorAll('[data-group-page]')].map(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y }; }), dialog: document.querySelector('[role="dialog"]').getAttribute('aria-modal') }));
    assert.deepEqual(result.ids, [1,2,3,4,5,6,7,8,9,10]); assert.equal(result.dialog, 'true');
    assert.ok(result.labels.every(item => item.label && item.selected === 'false' && !item.text.includes('Select')));
    assert.ok(result.geometry[1].x > result.geometry[0].x && result.geometry[1].y === result.geometry[0].y);
    assert.equal(await page.evaluate(() => window.commands.length), 0);
  } finally { await page.close(); }
});

test('selecting 2/5/7/9 and keyboard order position 3 preserves canonical block order', async () => {
  const page = await mount(); try {
    await select(page, [9,2,7,5]); await page.focus('[data-group-action="order"]'); await page.keyboard.press('Enter');
    await page.select('[data-group-before]', '4'); await page.focus('[data-group-confirm]'); await page.keyboard.press('Enter');
    const command = await page.evaluate(() => window.commands[0]);
    assert.equal(command.kind, 'reorder'); assert.deepEqual(command.selected_ids, [2,5,7,9]); assert.equal(command.before_note_id, 4);
    const remaining = [1,2,3,4,5,6,7,8,9,10].filter(id => !command.selected_ids.includes(id));
    const at = remaining.indexOf(command.before_note_id); remaining.splice(at, 0, ...command.selected_ids);
    assert.deepEqual(remaining, [1,3,2,5,7,9,4,6,8,10]); assert.equal(command.expected.notes.length, 10);
  } finally { await page.close(); }
});

test('tap activation closes the overview, restores focus and performs no mutation', async () => {
  const page = await mount(); try {
    await page.click('[data-group-activate="5"]');
    assert.deepEqual(await page.evaluate(() => window.activations), [5]);
    assert.equal(await page.$('.note-group-overview'), null); assert.equal(await page.evaluate(() => document.activeElement.id), 'opener');
    assert.equal(await page.evaluate(() => window.commands.length), 0);
  } finally { await page.close(); }
});

test('outside click and Escape discard local selection, and rapid reopen does not leave focus handlers', async () => {
  const page = await mount(); try {
    await select(page, [2]); await page.click('.note-group-overview', { offset: { x: 2, y: 2 } });
    assert.equal(await page.$('.note-group-overview'), null);
    for (let i = 0; i < 3; i++) { await page.evaluate(() => { window.overview = window.openOverview(); }); await page.keyboard.press('Escape'); }
    assert.equal(await page.$('.note-group-overview'), null); assert.equal(await page.evaluate(() => window.commands.length), 0);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'opener');
  } finally { await page.close(); }
});

test('focus stays in the overview for both keyboard directions', async () => {
  const page = await mount(); try {
    await page.focus('[data-group-close]'); await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
    assert.equal(await page.evaluate(() => !!document.activeElement.closest('.note-group-overview')), true);
    await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.hasAttribute('data-group-close')), true);
  } finally { await page.close(); }
});

test('browse-only projections can activate pages but expose no structural controls', async () => {
  const page = await mount({ canManage: false }); try {
    assert.equal(await page.$('[data-group-select]'), null); assert.equal(await page.$('[data-group-action]'), null);
    await page.click('[data-group-activate="3"]'); assert.deepEqual(await page.evaluate(() => window.activations), [3]);
    assert.equal(await page.evaluate(() => window.commands.length), 0);
  } finally { await page.close(); }
});

test('keyboard destination and insertion controls create one atomic transfer command', async () => {
  const page = await mount(); try {
    await select(page, [5,2]); await page.click('[data-group-action="move"]');
    await page.select('[data-group-destination]', '20'); await page.select('[data-group-before]', '12'); await page.click('[data-group-confirm]');
    const commands = await page.evaluate(() => window.commands); assert.equal(commands.length, 1);
    assert.equal(commands[0].kind, 'transfer'); assert.deepEqual(commands[0].selected_ids, [2,5]);
    assert.equal(commands[0].source_group_id, 10); assert.equal(commands[0].target_group_id, 20); assert.equal(commands[0].before_note_id, 12);
  } finally { await page.close(); }
});

test('multiple extraction offers exact bounded preview and Cancel writes nothing', async () => {
  const page = await mount(); try {
    await select(page, [5,2]); await page.click('[data-group-action="remove"]');
    assert.deepEqual(await page.$$eval('[data-group-extract-choice]', buttons => buttons.map(button => button.textContent.trim())), ['New group', 'Individual notes', 'Cancel']);
    await page.click('[data-group-extract-choice="individual"]');
    assert.equal(await page.$$eval('[data-group-placement]', rects => rects.length), 2);
    assert.equal(await page.evaluate(() => window.commands.length), 0); await page.click('[data-group-cancel]');
    assert.equal(await page.evaluate(() => window.commands.length), 0); assert.equal(await page.$$eval('[data-group-select][aria-pressed="true"]', buttons => buttons.length), 2);
  } finally { await page.close(); }
});

test('final Place saves exactly previewed unpinned rectangles in canonical selected order', async () => {
  const page = await mount(); try {
    await select(page, [5,2]); await page.click('[data-group-action="remove"]'); await page.click('[data-group-extract-choice="individual"]');
    const preview = await page.$$eval('[data-group-placement]', els => els.map(el => JSON.parse(el.dataset.groupPlacement)));
    await page.click('[data-group-confirm]'); const command = await page.evaluate(() => window.commands[0]);
    assert.equal(command.kind, 'extract'); assert.deepEqual(command.selected_ids, [2,5]); assert.deepEqual(command.placements, preview);
    assert.ok(preview.every(rect => !rect.position_locked && rect.always_on_top && rect.width === 4 && rect.height === 6 && rect.x >= 0 && rect.x <= 10000 && rect.y >= 0 && rect.y <= 10000));
    const [a,b] = preview; assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
  } finally { await page.close(); }
});

test('authentication abort immediately removes private previews and queued gestures', async () => {
  const page = await mount(); try {
    await select(page, [2,5]); await page.click('[data-group-action="remove"]'); await page.click('[data-group-extract-choice="group"]');
    await page.evaluate(() => window.abort.abort()); assert.equal(await page.$('.note-group-overview'), null);
    assert.equal(await page.evaluate(() => document.body.textContent.includes('Authorized preview')), false);
    assert.equal(await page.evaluate(() => window.commands.length), 0);
  } finally { await page.close(); }
});

test('narrow overview keeps exit and close reachable and honours reduced motion', async () => {
  const page = await mount({ width: 360 }); try {
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    const result = await page.evaluate(() => { const exit = document.querySelector('[data-group-exit]').getBoundingClientRect(), close = document.querySelector('[data-group-close]').getBoundingClientRect(), overlay = getComputedStyle(document.querySelector('.note-group-overview')); return { exit: exit.toJSON(), close: close.toJSON(), animation: overlay.animationDuration, background: overlay.backgroundColor }; });
    assert.ok(result.exit.height >= 44 && result.exit.top >= 0 && result.exit.bottom <= 800);
    assert.ok(result.close.left >= 0 && result.close.right <= 360); assert.equal(result.animation, '0s'); assert.notEqual(result.background, 'rgba(0, 0, 0, 0)');
  } finally { await page.close(); }
});

test('a second pointer during the initial hold cancels without activation or mutation', async () => {
  const page = await mount(); try {
    await page.evaluate(() => {
      const page = document.querySelector('[data-group-activate="2"]'), host = document.getElementById('host');
      page.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 11, pointerType: 'touch', isPrimary: true, clientX: 100, clientY: 200, button: 0 }));
      host.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 12, pointerType: 'touch', isPrimary: false, clientX: 300, clientY: 300, button: 0 }));
    });
    assert.equal(await page.$eval('.note-group-overview', el => el.dataset.gestureState), 'idle');
    assert.equal(await page.evaluate(() => window.commands.length), 0); assert.equal(await page.evaluate(() => window.activations.length), 0);
  } finally { await page.close(); }
});

test('real pointer extraction stays alive through exit and only its final drop creates one command', async () => {
  const page = await mount(); try {
    const start = await page.$eval('[data-group-activate="2"]', el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.waitForFunction(() => document.querySelector('.note-group-overview').dataset.gestureState === 'dragging');
    const exit = await page.$eval('[data-group-exit]', el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await page.mouse.move(exit.x, exit.y); await page.waitForFunction(() => window.exits.length === 1);
    assert.equal(await page.evaluate(() => window.commands.length), 0);
    const pointer = await page.evaluate(() => window.exits[0]); assert.deepEqual(pointer.selected_ids, [2]);
    await page.mouse.move(100, 700); await page.mouse.up();
    const commands = await page.evaluate(() => window.commands); assert.equal(commands.length, 1);
    assert.equal(commands[0].kind, 'extract'); assert.deepEqual(commands[0].selected_ids, [2]); assert.equal(commands[0].placements[0].position_locked, false);
    assert.deepEqual(await page.evaluate(() => window.activations), []);
  } finally { await page.close(); }
});

test('capture loss after a real hold consumes release without activating a page', async () => {
  const page = await mount(); try {
    const start = await page.$eval('[data-group-activate="2"]', el => { const r = el.getBoundingClientRect(); return { x: r.x + 20, y: r.y + 20 }; });
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.waitForFunction(() => document.querySelector('.note-group-overview').dataset.gestureState === 'dragging');
    await page.evaluate(() => document.getElementById('host').releasePointerCapture(1)); await page.mouse.up();
    assert.equal(await page.evaluate(() => window.commands.length), 0); assert.equal(await page.evaluate(() => window.activations.length), 0);
  } finally { await page.close(); }
});
