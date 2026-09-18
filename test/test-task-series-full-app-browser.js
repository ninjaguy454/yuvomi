import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';

const repo = fileURLToPath(new URL('..', import.meta.url));
if (process.env.TASK_SERIES_BROWSER_CHILD === '1') await run();
else test('shared morning template: independent structural series edits, later generations, preserved history and live clients', { timeout: 270000 }, () => {
  const temporary = !process.env.TASK_SERIES_QA_OUTPUT;
  const output = process.env.TASK_SERIES_QA_OUTPUT || mkdtempSync(path.join(tmpdir(), 'task-series-browser-'));
  mkdirSync(output, { recursive: true });
  try {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 260000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, TASK_SERIES_BROWSER_CHILD: '1', TASK_SERIES_QA_OUTPUT: output } });
    writeFileSync(path.join(output, 'full-app-child.log'), `${child.stdout}\n${child.stderr}`);
    assert.equal(child.status, 0, `${child.error || ''}\n${child.stdout}\n${child.stderr}`);
    const results = JSON.parse(readFileSync(path.join(output, 'full-app-results.json'), 'utf8'));
    assert.ok(results.grace && results.eleanor && results.frankieUnchanged && results.liveClient && results.sharedTemplateUnchanged && results.laterGenerations);
  } finally {
    if (temporary) {
      assert.equal(path.dirname(path.resolve(output)), path.resolve(tmpdir()));
      assert.ok(path.basename(output).startsWith('task-series-browser-'));
      rmSync(output, { recursive: true, force: true });
    }
  }
});

async function run() {
  const output = process.env.TASK_SERIES_QA_OUTPUT; process.chdir(output);
  process.env.DB_PATH = path.join(output, `series-${Date.now()}.db`);
  // Only the child application's clock is controlled. Advancing to an actual
  // occurrence window exercises normal API validation and recurrence; no Task
  // dates or completion records are rewritten to bypass the start-date gate.
  const realToday = new Date();
  const monday = new Date(Date.UTC(realToday.getUTCFullYear(), realToday.getUTCMonth(), realToday.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const { todayKey, storedToInstantMs } = await import(pathToFileURL(path.join(repo, 'server/utils/timezone.js')));
  const morningInstant = day => storedToInstantMs(`${day}T07:30:00`, 'America/New_York');
  mock.timers.enable({ apis: ['Date'], now: morningInstant(monday.toISOString().slice(0, 10)) });
  delete process.env.DB_ENCRYPTION_KEY;
  Object.assign(process.env, { SESSION_SECRET: 'isolated-series-browser-fixture-only', SESSION_SECURE: 'false', BACKUP_ENABLED: 'false', NODE_ENV: 'development', PORT: '0', LOG_LEVEL: 'error' });
  const { get } = await import(pathToFileURL(path.join(repo, 'server/db.js')));
  const d = get();
  const { hashPassword } = await import(pathToFileURL(path.join(repo, 'server/utils/password.js')));
  const password = 'Synthetic-Series-Only!';
  d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role,onboarding_version) VALUES('seriesqa','Series QA',?,'admin','parent',1)").run(await hashPassword(password));
  const members = {};
  for (const name of ['Gracelynn', 'Eleanor', 'Frankie']) members[name] = Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role,onboarding_version) VALUES(?,?,'x','member','child',1)").run(name.toLowerCase(), name).lastInsertRowid);
  d.prepare("INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','America/New_York')").run();
  const today = todayKey(d);
  let readyResolve; const ready = new Promise(resolve => { readyResolve = resolve; });
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function(...args) {
    if (args[0] === '0') { args[0] = 0; args.splice(1, 0, '127.0.0.1'); this.once('listening', () => readyResolve(`http://127.0.0.1:${this.address().port}`)); }
    return listen.apply(this, args);
  };
  await import(pathToFileURL(path.join(repo, 'server/index.js')));
  const origin = await ready;
  const browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const errors = [];
  const set = (page, selector, value) => page.$eval(selector, (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, value);
  const api = (page, method, url, body) => page.evaluate(async ({ method, url, body }) => {
    const { api } = await import('/api.js');
    // Three real clients share this fixture's loopback IP. Honor the production
    // request limiter rather than disabling it or changing application code.
    for (let attempt = 0; ; attempt++) {
      try { return await api[method](url, body); }
      catch (error) {
        if (error.status !== 429 || attempt >= 2) throw error;
        window.qaRateLimitWaits = (window.qaRateLimitWaits || 0) + 1;
        await new Promise(resolve => setTimeout(resolve, 30000));
      }
    }
  }, { method, url, body });
  const row = id => d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  const children = id => d.prepare('SELECT * FROM tasks WHERE parent_task_id=? AND archived_at IS NULL ORDER BY sort_order,id').all(id);
  const successor = id => d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(id);
  async function client(width) {
    const context = await browser.createBrowserContext(), page = await context.newPage();
    page.setDefaultTimeout(12000); await page.setViewport({ width, height: 900 });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/login`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(async password => {
      const response = await fetch('/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'seriesqa', password }) });
      if (!response.ok) throw new Error(`login ${response.status}`);
    }, password);
    await page.goto(`${origin}/tasks`, { waitUntil: 'domcontentloaded' });
    // Real first-install service-worker reload settles before interaction.
    await new Promise(resolve => setTimeout(resolve, 10000));
    assert.equal(await page.evaluate(() => navigator.onLine), true);
    await page.waitForSelector(width < 1024 ? '#fab-new-task' : '#btn-new-task');
    await page.evaluate(() => {
      window.qaToasts = []; const original = window.yuvomi.showToast;
      window.yuvomi.showToast = (...args) => { window.qaToasts.push(args[0]); return original(...args); };
    });
    return page;
  }
  async function open(page, id, edit = true) {
    await page.evaluate(async id => {
      const { closeModal } = await import('/components/modal.js'); await closeModal({ force: true });
      const { openTaskById } = await import('/pages/tasks.js'); await openTaskById(id, { user: window.yuvomi.user });
    }, id);
    await page.waitForSelector('#detail-view-edit');
    if (edit) { await page.click('#detail-view-edit'); await page.waitForSelector('#task-form'); }
  }
  async function save(page, scope, cancel = false) {
    await page.focus('#task-submit-btn'); await page.keyboard.press('Enter');
    await page.waitForSelector('#task-edit-scope-form', { visible: true });
    await page.waitForFunction(() => {
      const panel = document.querySelector('#task-edit-scope-form')?.closest('.modal-panel');
      return panel && !panel.getAnimations({ subtree: true }).some(animation => animation.playState === 'running');
    });
    await page.click(`[name="edit_scope"][value="${scope}"]`);
    if (cancel) { await page.click('[data-task-scope-cancel]'); await page.waitForFunction(() => !document.querySelector('#task-edit-scope-form')); return; }
    await page.click('#task-scope-apply');
    await page.waitForFunction(() => !document.querySelector('#task-form'));
  }
  async function complete(page, id, parent = false) {
    const task = (await api(page, 'get', `/tasks/${id}`)).data;
    return api(page, 'patch', `/tasks/${id}/status`, { status: 'done', ...(parent ? { complete_remaining: true } : {}), expected_revision: task.revision, ...(task.parent_revision == null ? {} : { expected_parent_revision: task.parent_revision }) });
  }
  async function addAction(page, title, optional = false) {
    await page.focus('[data-task-subtask-add]'); await page.keyboard.press('Enter');
    await set(page, '[data-task-subtask-row]:last-child [data-task-subtask-title]', title);
    if (optional) {
      await page.focus('[data-task-subtask-row]:last-child [data-task-subtask-optional]'); await page.keyboard.press('Space');
    }
  }
  try {
    const desktop = await client(1366), mobile = await client(390), observer = await client(1366);
    const baseline = ['Get dressed', 'Put pajamas / dirty clothes away', 'Make bed', 'Brush teeth', 'Brush / fix hair',
      'Wash face', 'Put on socks and shoes', 'Get backpack / school items ready', 'Ready for the day'];
    const activity = (await api(desktop, 'post', '/automation/admin/activity-templates', {
      name: 'Get Ready for the Day', title_template: 'Get Ready for the Day', points: 2,
      assignment_strategy: 'fixed', fixed_user_id: members.Eleanor, subject_required: false, allow_assignment_override: true,
      presence_policy: 'ignore', start_time: '07:00', due_time: '08:00', due_date_offset_days: 0,
      expiration_policy: 'expire_incomplete', recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', recurrence_from_completion: false,
      checklist: baseline.map(title_template => ({ title_template, is_optional: false })),
    })).data;
    const templateSnapshot = () => ({ root: d.prepare('SELECT * FROM activity_templates WHERE id=?').get(activity.id),
      actions: d.prepare('SELECT * FROM activity_template_checklist_items WHERE activity_template_id=? ORDER BY sort_order,id').all(activity.id) });
    const templateBefore = templateSnapshot();
    const routine = async (name, startDate = today) => (await api(desktop, 'post', '/tasks', {
      activity_template_id: activity.id, title: `${name} routine`, assigned_to: [members[name]], start_date: startDate,
    })).data;
    // The unchanged control is outside the clock advances below, so ordinary
    // automatic expiration cannot be mistaken for a cross-series edit.
    const nextMonday = new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10);
    const grace = await routine('Gracelynn'), eleanorFirst = await routine('Eleanor'), frankie = await routine('Frankie', nextMonday);
    assert.equal(new Set([grace.recurrence_series_id, eleanorFirst.recurrence_series_id, frankie.recurrence_series_id]).size, 3);
    const untouched = id => ({ root: row(id), actions: children(id) });
    const frankieBefore = untouched(frankie.id), eleanorBefore = untouched(eleanorFirst.id);
    const firstStep = children(grace.id)[0]; await complete(desktop, firstStep.id);
    const completedEvidence = { task: row(firstStep.id), receipts: d.prepare('SELECT * FROM task_completions WHERE task_id=?').all(firstStep.id),
      history: d.prepare('SELECT * FROM task_activity_events WHERE action_task_id=? ORDER BY id').all(firstStep.id) };
    await open(observer, grace.id, false);
    await open(desktop, grace.id);
    await set(desktop, '#task-title', 'Gracelynn routine revised'); await set(desktop, '#task-points', '3');
    await addAction(desktop, 'Put on deodorant'); await addAction(desktop, 'Put in earrings', true);
    const before = d.prepare('SELECT COUNT(*) n FROM task_activity_events').get().n;
    await save(desktop, 'future', true);
    assert.equal(row(grace.id).title, 'Gracelynn routine'); assert.equal(d.prepare('SELECT COUNT(*) n FROM task_activity_events').get().n, before);
    assert.equal(children(grace.id).length, 9); assert.equal(await desktop.$$eval('[data-task-subtask-row]', rows => rows.length), 11);
    await save(desktop, 'future');
    assert.equal(row(grace.id).points, 3); assert.equal(children(grace.id)[0].status, 'done');
    assert.equal(children(grace.id).find(action => action.title === 'Put on deodorant').is_optional, 0);
    assert.equal(children(grace.id).find(action => action.title === 'Put in earrings').is_optional, 1);
    assert.deepEqual(d.prepare('SELECT * FROM task_completions WHERE task_id=?').all(firstStep.id), completedEvidence.receipts);
    assert.deepEqual(d.prepare('SELECT * FROM task_activity_events WHERE action_task_id=? ORDER BY id').all(firstStep.id), completedEvidence.history);
    assert.equal(row(firstStep.id).completed_at, completedEvidence.task.completed_at);
    assert.deepEqual(untouched(eleanorFirst.id), eleanorBefore); assert.deepEqual(untouched(frankie.id), frankieBefore);
    await observer.waitForFunction(() => document.querySelector('#shared-modal-title')?.textContent.includes('Gracelynn routine revised'));
    await observer.waitForFunction(() => document.querySelector('#shared-modal-panel')?.textContent.includes('Put on deodorant') || document.querySelector('#shared-modal-overlay')?.textContent.includes('Put on deodorant'));
    await complete(desktop, grace.id, true);
    assert.equal(children(grace.id).find(action => action.is_optional).status, 'open');
    const graceNext = successor(grace.id);
    await complete(desktop, eleanorFirst.id, true); const eleanor = successor(eleanorFirst.id);
    const historicalEleanor = untouched(eleanorFirst.id);
    await open(mobile, eleanor.id); await set(mobile, '#task-title', 'Eleanor one day only'); await set(mobile, '#task-points', '9');
    await save(mobile, 'occurrence'); assert.equal(row(eleanor.id).title, 'Eleanor one day only');
    await open(mobile, eleanorFirst.id); await set(mobile, '#task-title', 'Eleanor future routine'); await set(mobile, '#task-points', '5');
    await addAction(mobile, 'Put in earrings', true);
    await save(mobile, 'future'); assert.equal(row(eleanor.id).title, 'Eleanor one day only');
    assert.match(await mobile.evaluate(() => window.qaToasts.join(' ')), /future occurrence was preserved/);
    assert.deepEqual(untouched(eleanorFirst.id), historicalEleanor);
    assert.equal(children(eleanor.id).length, 9, 'the occurrence-specific exception remains unchanged');
    const assertGrace = task => {
      assert.deepEqual(children(task.id).map(action => [action.title, action.is_optional, action.status]),
        [...baseline.map(title => [title, 0, 'open']), ['Put on deodorant', 0, 'open'], ['Put in earrings', 1, 'open']]);
      assert.equal(task.points, 3); assert.equal(task.start_time, '07:00'); assert.equal(task.due_time, '08:00');
      assert.equal(task.expiration_policy, 'expire_incomplete'); assert.equal(task.recurrence_rule, 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
    };
    assertGrace(graceNext);
    mock.timers.setTime(morningInstant(graceNext.start_date));
    await complete(desktop, graceNext.id, true); const graceLater = successor(graceNext.id); assertGrace(graceLater);
    await complete(mobile, eleanor.id, true); const eleanorNext = successor(eleanor.id);
    const assertEleanor = task => {
      assert.equal(task.title, 'Eleanor future routine'); assert.equal(task.points, 5);
      assert.deepEqual(children(task.id).map(action => [action.title, action.is_optional, action.status]),
        [...baseline.map(title => [title, 0, 'open']), ['Put in earrings', 1, 'open']]);
    };
    assertEleanor(eleanorNext);
    mock.timers.setTime(morningInstant(eleanorNext.start_date));
    await complete(mobile, eleanorNext.id, true); const eleanorLater = successor(eleanorNext.id); assertEleanor(eleanorLater);
    assert.deepEqual(untouched(frankie.id), frankieBefore); assert.deepEqual(templateSnapshot(), templateBefore);
    assert.equal(d.prepare("SELECT COUNT(*) n FROM task_activity_events WHERE task_id=? AND event_type='series_edited'").get(grace.id).n, 1);
    assert.deepEqual(errors, []);
    const results = { grace: true, eleanor: true, frankieUnchanged: true, liveClient: true, partialHistoryPreserved: true, manualExceptionPreserved: true,
      sharedTemplateUnchanged: true, laterGenerations: true, baselineRequired: 9, graceRequired: 10, graceOptional: 1, eleanorRequired: 9, eleanorOptional: 1,
      graceTask: grace.id, graceSuccessor: graceNext.id, graceLater: graceLater.id,
      eleanorTask: eleanor.id, eleanorSuccessor: eleanorNext.id, eleanorLater: eleanorLater.id };
    writeFileSync(path.join(output, 'full-app-results.json'), JSON.stringify(results, null, 2)); console.log(JSON.stringify(results));
  } catch (error) {
    for (const [index, page] of (await browser.pages()).entries()) {
      if (page.url().startsWith(origin)) { console.log('PAGE', index, await page.evaluate(() => document.body.innerText.slice(-3500))); await page.screenshot({ path: path.join(output, `failure-${index}.png`) }); }
    }
    throw error;
  } finally { await browser.close(); }
  process.exit(0);
}
