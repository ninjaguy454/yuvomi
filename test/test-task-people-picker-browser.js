import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import puppeteer from 'puppeteer';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const app = express();
const styles = [...readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  .matchAll(/<link rel="stylesheet" href="([^"]+)"\s*\/>/g)]
  .map(([, href]) => `<link rel="stylesheet" href="${href}">`).join('');
app.get('/people-picker-fixture', (_req, res) => res.send(`<!doctype html><html lang="en"><head>
  <meta name="viewport" content="width=device-width,initial-scale=1">${styles}
  <link rel="stylesheet" href="/styles/tasks.css">
  <style>*,*::before,*::after{animation:none!important;transition:none!important}
  body{padding:20px}main{width:100%;max-width:600px;margin:auto}h1{margin-bottom:24px}
  #editor{padding:16px;border:1px solid var(--color-border);border-radius:12px}
  #save,#reopen{margin-top:24px}</style></head><body><main><h1>Task People</h1>
  <div id="editor"></div><button id="save">Save fixture</button><button id="reopen">Reopen fixture</button>
  </main></body></html>`));
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
app.use('/api/v1', (_req, res) => res.json({ data: [] }));

let server, browser, origin;
const artifacts = fileURLToPath(new URL('../test-artifacts/task-people-picker/', import.meta.url));
const input = id => `[data-ms-input="task_assigned"][value="${id}"]`;
const card = id => `label:has(${input(id)})`;

test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  mkdirSync(artifacts, { recursive: true });
});
test.after(async () => { await browser?.close(); await new Promise(resolve => server.close(resolve)); });

async function fixture({ selected = [], width = 1280, disabled = false, variant = 'people', long = false } = {}) {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await page.setViewport({ width, height: 900, isMobile: width < 500, hasTouch: width < 500 });
  const requests = [], errors = [];
  page.on('request', request => requests.push(request.url()));
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/people-picker-fixture`);
  await page.evaluate(async ({ selected, disabled, variant, long }) => {
    localStorage.setItem('yuvomi-locale', 'en');
    await (await import('/i18n.js')).initI18n();
    window.picker = await import('/components/user-multi-select.js');
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
    const paint = canvas.getContext('2d'); paint.fillStyle = '#b9d4e5'; paint.fillRect(0, 0, 64, 64);
    paint.fillStyle = '#6c4b3e'; paint.beginPath(); paint.arc(32, 25, 14, 0, Math.PI * 2); paint.fill();
    paint.fillStyle = '#466b8b'; paint.beginPath(); paint.arc(32, 65, 25, 0, Math.PI * 2); paint.fill();
    window.members = [
      { id: 1, display_name: 'Alex', username: 'alex.parent', avatar_data: canvas.toDataURL(), avatar_color: '#466b8b' },
      { id: 2, display_name: 'Alex', age: 12, username: 'alex.child', avatar_color: '#986431' },
      { id: 3, display_name: long ? 'Riley VeryLongFamilyNameWithoutBreaksToExerciseNarrowLayouts' : 'Riley', avatar_color: '#765b93' },
      { id: 4, display_name: 'Jordan Lee', avatar_color: '#327563', avatar_data: 'https://forbidden.invalid/avatar.png' },
    ];
    if (!variant) delete members[3].avatar_data;
    // A hidden/ineligible member in a richer app cache must never enter the supplied roster.
    window.yuvomi = { users: [...members, { id: 99, display_name: 'Hidden member', avatar_data: canvas.toDataURL() }] };
    window.saved = selected;
    window.renderPicker = ids => {
      const editor = document.querySelector('#editor');
      editor.innerHTML = picker.renderUserMultiSelect(members, ids, 'task_assigned', 'tasks.assignedLabel', variant ? { variant } : undefined);
      picker.bindUserMultiSelect(editor, 'task_assigned');
      editor.querySelectorAll('[data-ms-input="task_assigned"]').forEach(node => { node.disabled = disabled; });
    };
    window.selectedPeople = () => picker.getSelectedUserIds(document.querySelector('#editor'), 'task_assigned');
    document.querySelector('#save').onclick = () => { window.saved = selectedPeople(); };
    document.querySelector('#reopen').onclick = () => renderPicker(saved);
    renderPicker(selected);
  }, { selected, disabled, variant, long });
  return { page, requests, errors };
}

test('People uses the bounty photo grid with disambiguated names and authorized roster only', async () => {
  const { page, requests, errors } = await fixture({ selected: [1] });
  try {
    assert.ok(await page.$('.user-ms--people .task-acceptance__choices'), 'opt-in People renders the bounty choice grid');
    assert.deepEqual(await page.$$eval('.task-acceptance__member-name', nodes => nodes.map(node => node.textContent.trim())),
      ['- No one -', 'Alex (alex.parent)', 'Alex (12)', 'Riley', 'Jordan Lee']);
    assert.ok(await page.$(`${card(1)} .task-acceptance__avatar img`));
    assert.equal(await page.$(`${card(4)} img`), null, 'untrusted remote URLs fall back to initials');
    assert.equal(await page.$(input(99)), null);
    assert.equal(await page.$eval(`${card(2)} .task-acceptance__avatar`, node => node.textContent.trim()), 'A');
    assert.equal(await page.$eval(input(1), node => node.type), 'checkbox');
    assert.equal(await page.$eval('[data-ms-name="task_assigned"]', node => node.getAttribute('role')), 'group');
    assert.ok(!requests.some(url => /forbidden|profile|auth\/users/.test(url)));
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const width of [390, 1280]) test(`create, save, reopen, edit, and deselect multiple People at ${width}px`, async () => {
  const { page, errors } = await fixture({ width });
  try {
    assert.ok(await page.$('.user-ms--people'));
    assert.deepEqual(await page.evaluate(() => selectedPeople()), []);
    const activate = selector => width < 500 ? page.tap(selector) : page.click(selector);
    await activate(card(1)); await activate(card(2));
    assert.deepEqual(await page.evaluate(() => selectedPeople()), [1, 2]);
    assert.equal(await page.$eval(`${card(1)} .task-acceptance__check`, node => getComputedStyle(node).display), 'grid');
    assert.notEqual(await page.$eval(`${card(1)} .task-acceptance__avatar-wrap`, node => getComputedStyle(node).boxShadow), 'none');
    await page.click('#save'); await page.click('#reopen');
    assert.deepEqual(await page.evaluate(() => selectedPeople()), [1, 2]);
    await activate(card(1)); await activate(card(3));
    assert.deepEqual(await page.evaluate(() => selectedPeople()), [2, 3]);
    await page.click('#save'); await page.click('#reopen');
    assert.deepEqual(await page.evaluate(() => selectedPeople()), [2, 3]);
    await activate(card(2)); await activate(card(3));
    assert.deepEqual(await page.evaluate(() => selectedPeople()), []);
    await activate(card(4)); await activate(card(''));
    assert.deepEqual(await page.evaluate(() => selectedPeople()), [], 'Nobody retains the existing clear-assignment behavior');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('People native checkboxes support Tab, Shift+Tab, Space, and a visible focus ring', async () => {
  const { page } = await fixture();
  try {
    assert.ok(await page.$('.user-ms--people'));
    await page.focus(input('')); await page.keyboard.press('Tab');
    assert.equal(await page.$eval(input(1), node => document.activeElement === node), true);
    assert.notEqual(await page.$eval(card(1), node => getComputedStyle(node).outlineStyle), 'none');
    await page.keyboard.press('Space'); await page.keyboard.press('Tab'); await page.keyboard.press('Space');
    assert.deepEqual(await page.evaluate(() => selectedPeople()), [1, 2]);
    await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
    await page.keyboard.press('Space');
    assert.deepEqual(await page.evaluate(() => selectedPeople()), [2]);
    assert.equal(await page.$eval(input(1), node => document.activeElement === node), true);
  } finally { await page.close(); }
});

test('existing disabled assignment gates retain selected People and prevent pointer or keyboard changes', async () => {
  const { page } = await fixture({ selected: [2, 3], disabled: true });
  try {
    assert.ok(await page.$('.user-ms--people'));
    await page.click(card(1)); await page.click(card(2)); await page.click(card(''));
    await page.focus('#save'); await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
    assert.equal(await page.$eval(input(4), node => document.activeElement === node), false, 'disabled inputs are skipped by Tab');
    assert.deepEqual(await page.evaluate(() => selectedPeople()), [2, 3]);
    assert.equal(await page.$$eval('[data-ms-input="task_assigned"]', nodes => nodes.every(node => node.disabled)), true);
    assert.equal(await page.$eval(`${card(2)} .task-acceptance__check`, node => getComputedStyle(node).display), 'grid');
  } finally { await page.close(); }
});

for (const width of [320, 390, 1280]) test(`People names fit beneath photos without overflow at ${width}px`, async () => {
  const { page } = await fixture({ selected: [1, 3], width, long: true });
  try {
    assert.ok(await page.$('.user-ms--people'));
    const layout = await page.$$eval('.task-acceptance__member', nodes => nodes.map(node => {
      const avatar = node.querySelector('.task-acceptance__avatar-wrap').getBoundingClientRect();
      const name = node.querySelector('.task-acceptance__member-name').getBoundingClientRect();
      return { below: name.top >= avatar.bottom, target: node.getBoundingClientRect().width >= 44,
        fits: node.scrollWidth <= node.clientWidth + 1, avatar: avatar.width };
    }));
    assert.ok(layout.every(item => item.below && item.target && item.fits && item.avatar === 64), JSON.stringify(layout));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `${artifacts}/people-${width}.png`, fullPage: true });
  } finally { await page.close(); }
});

test('default callers retain their compact selector and existing Nobody behavior', async () => {
  const { page } = await fixture({ selected: [2], variant: null });
  try {
    assert.equal(await page.$('.user-ms--people'), null);
    assert.ok(await page.$('.user-ms__option .user-ms__avatar'));
    await page.click(card(1)); assert.deepEqual(await page.evaluate(() => selectedPeople()), [1, 2]);
    await page.click(card('')); assert.deepEqual(await page.evaluate(() => selectedPeople()), []);
  } finally { await page.close(); }
});
