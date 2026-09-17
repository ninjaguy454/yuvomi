import test from 'node:test';
import net from 'node:net';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import puppeteer from 'puppeteer';

const repo = fileURLToPath(new URL('..', import.meta.url));
if (process.env.ACTIVITY_TEMPLATE_BROWSER_CHILD === '1') {
  await fullApplicationAcceptance();
} else {
  test('real application preserves template dates through desktop/mobile save, validation, switching and Task creation', { timeout: 120000 }, () => {
    const temporary = !process.env.ACTIVITY_TEMPLATE_QA_OUTPUT;
    const output = process.env.ACTIVITY_TEMPLATE_QA_OUTPUT || mkdtempSync(path.join(tmpdir(), 'activity-template-browser-'));
    mkdirSync(output, { recursive: true });
    try {
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
        encoding: 'utf8', timeout: 110000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, ACTIVITY_TEMPLATE_BROWSER_CHILD: '1', ACTIVITY_TEMPLATE_QA_OUTPUT: output },
      });
      writeFileSync(path.join(output, 'full-app-child.log'), `${child.stdout}\n${child.stderr}`);
      assert.equal(child.status, 0, `${child.error || ''}\n${child.stdout}\n${child.stderr}`);
      const results = JSON.parse(readFileSync(path.join(output, 'full-app-results.json'), 'utf8'));
      assert.deepEqual(results.map(row => row.width), [1366, 390]);
      for (const row of results) assert.ok(row.persisted && row.validationFocus && row.dropdownRefresh && row.draftPreserved);
    } finally {
      if (temporary) {
        assert.equal(path.dirname(path.resolve(output)), path.resolve(tmpdir()));
        assert.ok(path.basename(output).startsWith('activity-template-browser-'));
        rmSync(output, { recursive: true, force: true });
      }
    }
  });
}
// Runs the actual server, router, service worker, modals, API and database in a
// child process so background jobs and auth state cannot leak into other tests.
async function fullApplicationAcceptance() {
  const output = process.env.ACTIVITY_TEMPLATE_QA_OUTPUT; process.chdir(output);
  process.env.DB_PATH = path.join(output, `full-app-${Date.now()}.db`);
  delete process.env.DB_ENCRYPTION_KEY;
  process.env.SESSION_SECRET = 'isolated-template-date-acceptance-only';
  process.env.SESSION_SECURE = 'false'; process.env.BACKUP_ENABLED = 'false';
  process.env.NODE_ENV = 'development'; process.env.PORT = '0'; process.env.LOG_LEVEL = 'error';
  const { get } = await import(pathToFileURL(path.join(repo, 'server/db.js')));
  const d = get();
  const { hashPassword } = await import(pathToFileURL(path.join(repo, 'server/utils/password.js')));
  const password = 'Synthetic-Template-Schedule-Only!';
  d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role,onboarding_version) VALUES('templateqa','Template QA',?,'admin','parent',1)").run(await hashPassword(password));
  d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role,onboarding_version) VALUES('learnerqa','Eleanor QA','x','member','child',1)").run();
  d.prepare("INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','America/New_York')").run();
  let originResolve;
  const ready = new Promise(resolve => { originResolve = resolve; });
  const oldListen = net.Server.prototype.listen;
  net.Server.prototype.listen = function(...args) {
    if (args[0] === '0') { args[0] = 0; args.splice(1, 0, '127.0.0.1'); this.once('listening', () => originResolve(`http://127.0.0.1:${this.address().port}`)); }
    return oldListen.apply(this, args);
  };
  await import(pathToFileURL(path.join(repo, 'server/index.js')));
  const origin = await ready;
  const browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const results = [];
  const set = (page, selector, value) => page.$eval(selector, (el, value) => {
    el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  try {
    for (const width of [1366, 390]) {
      const context = await browser.createBrowserContext(), page = await context.newPage();
      const errors = []; page.on('pageerror', e => { errors.push(e.message); console.log('PAGEERROR', e.message); });
      page.on('response', r => { if (r.status() >= 400) console.log('RESPONSE', r.status(), r.url()); });
      page.on('framenavigated', frame => { if (frame === page.mainFrame()) console.log('NAVIGATION', width, frame.url()); });
      await page.evaluateOnNewDocument(() => {
        navigator.serviceWorker?.addEventListener('message', event => { if (event.data?.type === 'SW_UPDATED') console.log('INITIAL_SW_UPDATED'); });
      });
      page.on('console', message => { if (message.text() === 'INITIAL_SW_UPDATED') console.log(message.text(), width); });
      await page.setViewport({ width, height: 900 }); page.setDefaultTimeout(15000);
      await page.goto(`${origin}/login`, { waitUntil: 'domcontentloaded' });
      const login = await page.evaluate(async password => {
        const r = await fetch('/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'templateqa', password }) });
        return { status: r.status, body: await r.json() };
      }, password);
      assert.equal(login.status, 200, JSON.stringify(login.body));
      await page.goto(`${origin}/tasks`, { waitUntil: 'domcontentloaded' });
      // A fresh browser installs the SW and the real router reloads eight seconds
      // after SW_UPDATED. Let that initial installation complete before editing.
      await new Promise(resolve => setTimeout(resolve, 10000));
      assert.equal(await page.evaluate(() => navigator.onLine), true, 'full application QA needs an isolated network interface, not Docker --network none');
      await page.waitForSelector(width < 1024 ? '#fab-new-task' : '#btn-new-task');
      await page.click(width < 1024 ? '#fab-new-task' : '#btn-new-task'); await page.waitForSelector('#task-form');
      const title = `${width === 1366 ? 'Morning' : 'Homework'} schedule ${width}`;
      const schedule = width === 1366 ? { start_date: '2026-09-21', due_date: '2026-09-21', start_time: '07:00', due_time: '08:00' }
        : { start_date: '2026-09-21', due_date: '2026-09-25', start_time: '15:30', due_time: '07:00' };
      await set(page, '#task-title', title);
      for (const [key, value] of Object.entries(schedule)) await set(page, `#task-${key.replaceAll('_', '-')}`, value);
      await page.select('#task-rrule-freq', 'WEEKLY');
      if (width === 1366) for (const day of ['MO', 'TU', 'WE', 'TH', 'FR']) await page.click(`#task-rrule-fields [data-day="${day}"]`);
      await set(page, '#task-points', width === 1366 ? '2' : '5');
      if (width === 1366) await page.select('#task-expiration-policy', 'expire_incomplete');
      await page.click('[data-ms-input="task_assigned"][value="2"]');
      await page.click('[data-save-as-template]'); await page.waitForSelector('#automation-activity-form');
      const fields = await page.evaluate(async () => {
        const { parseDateInput, parseTimeInput } = await import('/i18n.js');
        return Object.fromEntries(['start_date', 'start_time', 'due_date', 'due_time'].map(key => {
          const value = document.querySelector(`#automation-activity-form [name="${key}"]`).value;
          return [key, key.endsWith('date') ? parseDateInput(value) : parseTimeInput(value)];
        }));
      });
      assert.deepEqual(fields, schedule);
      await new Promise(resolve => setTimeout(resolve, 500));
      await page.$eval('#activity-start-date', el => el.closest('fieldset').scrollIntoView({ block: 'start', behavior: 'instant' }));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.screenshot({ path: path.join(output, `template-schedule-${width}.png`) });
      await set(page, '#activity-due-date', '2026-09-20');
      await page.focus('#shared-modal-overlay [type="submit"]'); await page.keyboard.press('Enter');
      await page.waitForSelector('[data-activity-error]:not([hidden])');
      assert.equal(await page.evaluate(() => document.activeElement.closest('yuvomi-datepicker')?.id), 'activity-due-date');
      assert.equal(d.prepare('SELECT COUNT(*) n FROM activity_templates WHERE name=?').get(title).n, 0);
      await set(page, '#activity-due-date', schedule.due_date);
      await page.focus('#shared-modal-overlay [type="submit"]'); await page.keyboard.press('Enter');
      await page.waitForFunction(() => !document.querySelector('#automation-activity-form'));
      await page.waitForFunction(() => {
        const form = document.querySelector('#task-form');
        return !!form && !form.closest('[inert]') && !form.closest('.modal-panel').getAnimations().some(animation => animation.playState === 'running');
      });
      await new Promise(resolve => setTimeout(resolve, 250));
      const template = d.prepare('SELECT * FROM activity_templates WHERE name=?').get(title);
      assert.ok(template);
      for (const [key, value] of Object.entries(schedule)) assert.equal(template[key], value);
      assert.equal(template.recurrence_from_completion, 0);
      assert.equal(template.expiration_policy, width === 1366 ? 'expire_incomplete' : 'keep_overdue');
      if (width === 1366) assert.equal(template.recurrence_rule, 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
      await page.waitForSelector(`#task-activity-template option[value="${template.id}"]`);
      await page.select('#task-activity-template', String(template.id));
      await page.waitForSelector('#confirm-modal-ok', { visible: true });
      await page.waitForFunction(() => !document.querySelector('#confirm-modal-ok').closest('.modal-panel').getAnimations().some(animation => animation.playState === 'running'));
      await page.click('#confirm-modal-ok');
      try { await page.waitForFunction(id => document.querySelector('#task-activity-template')?.value === String(id), {}, template.id); }
      catch (error) { console.log(await page.evaluate(() => ({ title: document.querySelector('#shared-modal-title')?.textContent, select: document.querySelector('#task-activity-template')?.value, body: document.body.innerText.slice(-8000) }))); await page.screenshot({ path: path.join(output, 'full-app-failure.png') }); throw error; }
      await page.focus('#task-submit-btn'); await page.keyboard.press('Enter');
      await page.waitForFunction(() => !document.querySelector('#task-form'));
      const task = d.prepare('SELECT * FROM tasks WHERE title=? AND parent_task_id IS NULL ORDER BY id DESC LIMIT 1').get(title);
      assert.ok(task);
      for (const [key, value] of Object.entries(schedule)) assert.equal(task[key], value);
      assert.equal(task.recurrence_rule, template.recurrence_rule);
      assert.equal(task.points, width === 1366 ? 2 : 5);
      assert.deepEqual(errors, []);
      results.push({ width, title, template: template.id, task: task.id, schedule, recurrence: task.recurrence_rule,
        validationFocus: true, persisted: true, dropdownRefresh: true, draftPreserved: true });
      await context.close();
    }
    writeFileSync(path.join(output, 'full-app-results.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify({ pass: results.length, results }));
  } finally { await browser.close(); }
  process.exit(0);
}
