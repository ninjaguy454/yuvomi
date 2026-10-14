import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import puppeteer from 'puppeteer';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const styles = [...readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  .matchAll(/<link rel="stylesheet" href="([^"]+)"\s*\/>/g)]
  .map(([, href]) => `<link rel="stylesheet" href="${href}">`).join('');
const app = express();
app.get('/subtask-people-fixture', (_req, res) => res.send(`<!doctype html><html lang="en"><head>
  <meta name="viewport" content="width=device-width,initial-scale=1">${styles}<link rel="stylesheet" href="/styles/tasks.css">
  <style>*,*::before,*::after{animation:none!important;transition:none!important}
  body{padding:16px}main{max-width:800px;margin:auto}#fixture{position:relative}
  #save,#reopen{margin-top:20px}</style></head><body><main><h1>Task subtasks</h1>
  <div id="fixture"></div><button id="save">Save fixture</button><button id="reopen">Reopen fixture</button></main></body></html>`));
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
app.use('/api/v1', (_req, res) => res.json({ data: [] }));
let browser, server, origin;
const artifacts = fileURLToPath(new URL('../test-artifacts/task-people-picker/', import.meta.url));
const row = id => `[data-subtask-id="${id}"]`;
const target = id => `${row(id)} [data-task-subtask-target]`;
const source = id => `[data-task-subtask-person="${id}"]`;

test.before(async () => {
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  mkdirSync(artifacts, { recursive: true });
});
test.after(async () => { await browser?.close(); await new Promise(resolve => server.close(resolve)); });

async function fixture({ width = 1280, touch = false, template = false, canAssign = true, readOnly = false } = {}) {
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  await page.setViewport({ width, height: 1000, isMobile: touch, hasTouch: touch });
  const requests = [], errors = [];
  page.on('request', request => requests.push({ method: request.method(), url: request.url() }));
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/subtask-people-fixture');
  await page.evaluate(async ({ template, canAssign, readOnly }) => {
    localStorage.setItem('yuvomi-locale', 'en'); await (await import('/i18n.js')).initI18n();
    window.components = await import('/components/task-requirements.js');
    window.users = [
      { id: 1, display_name: 'Alex', age: 12, username: 'alex.child', color: '#986431' },
      { id: 2, display_name: 'Alex', username: 'alex.parent', color: '#466b8b' },
      { id: 3, display_name: 'Riley Lee', color: '#765b93' },
    ];
    (await import('/utils/member-label.js')).setMemberLabels(users);
    window.yuvomi = { users: [...users, { id: 99, display_name: 'Hidden member' }] };
    window.saved = [
      { id: 21, title: 'Water the garden', points: 2, assigned_user_ids: [] },
      { id: 22, title: 'Plant seedlings', points: 3, assigned_user_ids: [2] },
      { id: 23, title: 'Protected responsibility', points: 1, assigned_user_ids: [1], permissions: { change_assignment: false } },
      { id: 24, title: 'Eligible child only', points: 1, assigned_user_ids: [], eligible_assignee_ids: [1] },
    ];
    window.changes = 0;
    window.renderEditor = () => {
      window.editor?.dispose();
      document.querySelector('#fixture').innerHTML = components.renderSubtaskEditor({ subtasks: saved, users, template });
      window.editor = components.bindSubtaskEditor(document.querySelector('#fixture'), { users, template, assignmentsEnabled: true,
        canAssign, onChange: () => changes++ });
      editor.setReadOnly(readOnly);
    };
    document.querySelector('#save').onclick = () => { window.saved = editor.getValue(); };
    document.querySelector('#reopen').onclick = renderEditor;
    renderEditor(); await editor.ready;
  }, { template, canAssign, readOnly });
  return { page, requests, errors };
}
async function open(page, id) {
  await page.click(target(id)); await page.waitForSelector('[data-acceptance-picker]');
}
async function choose(page, id) { await page.click(`[data-acceptance-choice="${id ?? ''}"]`); }
async function values(page) { return page.evaluate(() => editor.getValue().map(child => [child.id, child.assigned_user_ids])); }

test('unassigned and current-assignee icons both open the shared bounty chooser', async () => {
  const { page, requests, errors } = await fixture();
  try {
    assert.ok(await page.$(target(21)), 'empty child exposes the avatar assignment target');
    assert.equal(await page.$eval(target(21), node => node.classList.contains('task-allocation__target--empty')), true);
    assert.equal(await page.$eval(target(21), node => node.textContent.trim()), '?');
    assert.equal(await page.$eval(target(22), node => node.dataset.assignee), '2');
    assert.deepEqual(await page.$$eval('[data-task-subtask-person]', nodes => nodes.map(node => node.dataset.taskSubtaskPerson)), ['1', '2', '3']);
    assert.equal(await page.$(source(99)), null);
    await open(page, 21);
    assert.deepEqual(await page.$$eval('[data-acceptance-choice]', nodes => nodes.map(node => node.dataset.acceptanceChoice)), ['', '1', '2', '3']);
    assert.deepEqual(await page.$$eval('[data-acceptance-choice]', nodes => nodes.map(node => node.getAttribute('aria-label'))), ['Unassigned', 'Alex (12)', 'Alex (alex.parent)', 'Riley L.']);
    await page.keyboard.press('Escape');
    assert.equal(await page.$eval(target(21), node => document.activeElement === node), true);
    await open(page, 22);
    assert.equal(await page.$eval('[data-acceptance-choice="2"]', node => node.getAttribute('aria-pressed')), 'true');
    await page.keyboard.press('Escape');
    assert.deepEqual(await values(page), [[21, []], [22, [2]], [23, [1]], [24, []]]);
    assert.ok(!requests.some(request => !['GET', 'HEAD'].includes(request.method) || /profile|auth\/users/.test(request.url)));
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('replacement and empty inheritance save and reopen as one recipient per child', async () => {
  const { page } = await fixture();
  try {
    assert.ok(await page.$(target(22)));
    await open(page, 22); await choose(page, 3);
    assert.equal(await page.$eval(target(22), node => node.dataset.assignee), '3');
    assert.equal(await page.$eval(`${row(22)} [data-task-subtask-assignee]`, node => node.value), '3');
    assert.deepEqual((await values(page))[1], [22, [3]]);
    await page.click('#save'); await page.click('#reopen');
    assert.equal(await page.$eval(target(22), node => node.dataset.assignee), '3');
    await open(page, 22); await choose(page, null);
    assert.equal(await page.$eval(target(22), node => node.classList.contains('task-allocation__target--empty')), true);
    assert.deepEqual((await values(page))[1], [22, []]);
    await page.click('#save'); await page.click('#reopen');
    assert.deepEqual((await values(page))[1], [22, []]);
    assert.equal(await page.evaluate(() => changes), 2, 'each explicit assignment change invalidates the draft once');
  } finally { await page.close(); }
});

test('row eligibility, capability denial, read-only state, and reusable templates retain assignment boundaries', async () => {
  const { page } = await fixture();
  try {
    assert.ok(await page.$(target(24)));
    await open(page, 24);
    assert.deepEqual(await page.$$eval('[data-acceptance-choice]', nodes => nodes.map(node => node.dataset.acceptanceChoice)), ['', '1']);
    await page.keyboard.press('Escape');
    assert.equal(await page.$eval(target(23), node => node.disabled), true);
    await page.click(target(23)); assert.equal(await page.$('[data-acceptance-picker]'), null);
    await page.evaluate(() => editor.setAssignmentsEnabled(false));
    assert.equal(await page.$eval('[data-task-subtask-people]', node => node.hidden), true);
    await page.evaluate(() => editor.setAssignmentsEnabled(true, { allowed: false }));
    assert.equal(await page.$$eval('[data-task-subtask-target]', nodes => nodes.every(node => node.disabled)), true);
    await page.evaluate(() => editor.setAssignmentsEnabled(true, { allowed: true }));
    await page.evaluate(() => editor.setReadOnly(true));
    assert.equal(await page.$$eval('[data-task-subtask-target]', nodes => nodes.every(node => node.disabled)), true);
    assert.deepEqual(await values(page), [[21, []], [22, [2]], [23, [1]], [24, []]]);
  } finally { await page.close(); }
  const { page: reusable } = await fixture({ template: true });
  try {
    assert.equal(await reusable.$('[data-task-subtask-target], [data-task-subtask-person], [data-task-subtask-assignee]'), null);
  } finally { await reusable.close(); }
});

test('keyboard and touch can choose the same single child recipient', async () => {
  const { page } = await fixture({ width: 390, touch: true });
  try {
    assert.ok(await page.$(target(21)));
    await page.focus(target(21)); await page.keyboard.press('Enter'); await page.waitForSelector('[data-acceptance-picker]');
    await page.focus('[data-acceptance-choice="2"]'); await page.keyboard.press('Space');
    assert.deepEqual((await values(page))[0], [21, [2]]);
    await page.tap(target(21)); await page.waitForSelector('[data-acceptance-picker]'); await page.tap('[data-acceptance-choice="3"]');
    assert.deepEqual((await values(page))[0], [21, [3]]);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `${artifacts}/subtask-people-390.png`, fullPage: true });
  } finally { await page.close(); }
});

test('whole-task scoring keeps row actions aligned when child point controls are hidden', async () => {
  const { page } = await fixture();
  try {
    await page.evaluate(() => editor.setPointsMode('whole_task'));
    const offset = await page.$eval(row(21), node => node.getBoundingClientRect().right
      - node.querySelector('.task-subtask-editor__actions').getBoundingClientRect().right);
    assert.ok(offset < 2, `row actions remain at the row edge; offset was ${offset}px`);
  } finally { await page.close(); }
});

test('tapping a pool avatar keeps bounty person-card behavior without assigning a child', async () => {
  const { page } = await fixture({ width: 390, touch: true });
  try {
    await page.tap(source(2));
    await page.waitForSelector('.task-detail-profile-preview', { timeout: 1000 });
    assert.equal(await page.$eval('.task-detail-profile-preview strong', node => node.textContent), 'Alex (alex.parent)');
    assert.deepEqual(await values(page), [[21, []], [22, [2]], [23, [1]], [24, []]]);
    await page.keyboard.press('Escape');
    assert.equal(await page.$eval(source(2), node => document.activeElement === node), true);
  } finally { await page.close(); }
});

test('an unavailable saved assignee is retained without exposing a richer cached identity', async () => {
  const { page } = await fixture();
  try {
    await page.evaluate(() => editor.setValue([{ id: 25, title: 'Keep responsibility', assigned_user_ids: [99] }]));
    assert.equal(await page.$eval(target(25), node => node.dataset.assignee), '99');
    assert.deepEqual(await values(page), [[25, [99]]]);
    assert.equal(await page.$eval('[data-task-subtask-editor]', node => node.textContent.includes('Hidden member')), false);
    await open(page, 25);
    assert.equal(await page.$('[data-acceptance-choice="99"]'), null);
    assert.equal(await page.$eval('[data-acceptance-picker]', node => node.contains(document.activeElement)), true, 'focus enters the chooser even when the saved identity is unavailable');
    await page.keyboard.press('Tab');
    assert.equal(await page.$eval('[data-acceptance-picker]', node => node.contains(document.activeElement)), true);
    await page.keyboard.down('Shift');await page.keyboard.press('Tab');await page.keyboard.up('Shift');
    assert.equal(await page.$eval('[data-acceptance-picker]', node => node.contains(document.activeElement)), true);
    await page.keyboard.press('Escape');
    assert.deepEqual(await values(page), [[25, [99]]]);
  } finally { await page.close(); }
});

test('closed current subtasks preserve responsibility while future definitions remain assignable', async () => {
  const {page}=await fixture();
  try {
    await page.evaluate(() => editor.setValue(['done','expired','skipped'].map((status,index)=>({id:31+index,title:status,status,assigned_user_ids:[2],permissions:{edit:true,change_assignment:true}}))));
    assert.deepEqual(await page.$$eval('[data-task-subtask-target]',nodes=>nodes.map(node=>node.disabled)),[true,true,true]);
    await page.evaluate(() => editor.setAssignmentsEnabled(true,{preserveHistory:false}));
    assert.deepEqual(await page.$$eval('[data-task-subtask-target]',nodes=>nodes.map(node=>node.disabled)),[false,false,false]);
    await page.evaluate(() => editor.setAssignmentsEnabled(true));
    assert.deepEqual(await values(page),[[31,[2]],[32,[2]],[33,[2]]]);
  }finally{await page.close();}
});

test('disposing or ending authentication closes chooser layers and preserves the local child values', async () => {
  const { page } = await fixture();
  try {
    await open(page, 21);
    await page.evaluate(() => window.dispatchEvent(new Event('auth:context-ending')));
    assert.equal(await page.$('[data-acceptance-picker]'), null);
    assert.deepEqual(await values(page), [[21, []], [22, [2]], [23, [1]], [24, []]]);
    await page.evaluate(() => renderEditor()); await open(page, 22);
    await page.evaluate(() => editor.dispose());
    assert.equal(await page.$('[data-acceptance-picker], .task-allocation__ghost'), null);
  } finally { await page.close(); }
});

for (const touch of [false, true]) test(`${touch ? 'touch' : 'mouse'} avatar drag replaces one child recipient and respects denied targets`, async () => {
  const { page } = await fixture({ width: touch ? 390 : 1280, touch }); let cdp;
  try {
    assert.ok(await page.$(source(3)));
    const from = await (await page.$(source(3))).boundingBox(), to = await (await page.$(target(22))).boundingBox();
    const x = from.x + from.width / 2, y = from.y + from.height / 2, endX = to.x + to.width / 2, endY = to.y + to.height / 2;
    if (touch) {
      cdp = await page.createCDPSession();
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: endX, y: endY }] });
      await page.waitForSelector('.task-allocation__ghost');
      const ghost = await page.$eval('.task-allocation__ghost', node => node.getBoundingClientRect().toJSON());
      assert.ok(ghost.y + ghost.height / 2 < endY - 24, 'touch preview remains above the finger');
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(endX, endY, { steps: 8 });
      await page.waitForSelector('.task-allocation__ghost'); await page.mouse.up();
    }
    assert.deepEqual((await values(page))[1], [22, [3]]);
    assert.equal(await page.$('.task-allocation__ghost'), null);
    assert.equal(await page.$('[data-acceptance-picker]'), null);
    await page.click('#save'); await page.click('#reopen');
    assert.deepEqual((await values(page))[1], [22, [3]]);
    if (!touch) {
      const sourceBox = await (await page.$(source(2))).boundingBox(), denied = await (await page.$(target(24))).boundingBox();
      await page.mouse.move(sourceBox.x + 24, sourceBox.y + 24); await page.mouse.down();
      await page.mouse.move(denied.x + 24, denied.y + 24, { steps: 8 }); await page.mouse.up();
      assert.deepEqual((await values(page))[3], [24, []], 'a drop cannot bypass row-specific eligibility');
    }
    await page.screenshot({ path: `${artifacts}/subtask-people-${touch ? 'touch' : 'desktop'}.png`, fullPage: true });
  } finally { await cdp?.detach(); await page.close(); }
});
