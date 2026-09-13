import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'task-release-live-isolated';
const db = await import('../server/db.js');
const { router: authRouter, sessionMiddleware, requireAuth } = await import('../server/auth.js');
const { taskChangesStream } = await import('../server/services/task-changes.js');
const { replaceSubjectPermissions } = await import('../server/permissions.js');
const { hashPassword } = await import('../server/utils/password.js');
const d = db.get();
const member = Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES('live-member','Live Member',?,'member','child')").run(await hashPassword('Release-Live-Test-2026!')).lastInsertRowid);
const app = express(); app.use(express.json()); app.use(sessionMiddleware);
app.use('/api/v1/auth', authRouter);
app.get('/api/v1/tasks/changes', requireAuth, taskChangesStream);
const server = http.createServer(app);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.closeAllConnections(); server.close(); });

async function login() {
  const res = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'live-member', password: 'Release-Live-Test-2026!' }) });
  assert.equal(res.status, 200);
  return { cookie: res.headers.getSetCookie().map(value => value.split(';')[0]).join('; '), body: await res.json() };
}
async function connected(identity) {
  const abort = new AbortController();
  const res = await fetch(`${base}/api/v1/tasks/changes`, { headers: { cookie: identity.cookie }, signal: abort.signal });
  assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /event: change/); assert.doesNotMatch(first, /Live Member|title|assigned_to/);
  return { reader, abort };
}
async function mustEnd(stream) {
  const timeout = setTimeout(() => stream.abort.abort(), 2500);
  try {
    for (;;) { const result = await stream.reader.read(); if (result.done) break; }
  } catch (error) { assert.fail(`Revoked stream did not close: ${error.name}`); }
  finally { clearTimeout(timeout); stream.abort.abort(); }
}

test('session-authenticated event stream closes after actual logout, even without another Task write', async () => {
  const identity = await login(), stream = await connected(identity);
  const out = await fetch(`${base}/api/v1/auth/logout`, { method: 'POST', headers: { cookie: identity.cookie, 'X-CSRF-Token': identity.body.csrfToken } });
  assert.equal(out.status, 200); await mustEnd(stream);
});
test('event stream closes on expired persisted session, not the stale request session', async () => {
  const identity = await login(), stream = await connected(identity);
  d.prepare('UPDATE sessions SET expired_at=0').run(); await mustEnd(stream);
});
test('event stream closes when Task permission is revoked without changing Task clock', async () => {
  const identity = await login(), stream = await connected(identity);
  replaceSubjectPermissions(d, 'user', member, { modules: { tasks: 'none' } });
  try { await mustEnd(stream); } finally { replaceSubjectPermissions(d, 'user', member, {}); }
});

const source = readFileSync(new URL('../public/utils/task-live.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
function harness() {
  const timers = new Map(); let seq = 0, reads = 0;
  const events = () => ({ listeners: new Map(), addEventListener(name, fn) { this.listeners.set(name, fn); }, removeEventListener(name) { this.listeners.delete(name); }, emit(name, event = {}) { this.listeners.get(name)?.(event); } });
  const document = { ...events(), hidden: false }, window = events(), navigator = { onLine: true };
  const streams = [];
  class Source {
    constructor() { Object.assign(this, events()); this.readyState = 1; streams.push(this); }
    close() { this.closed = true; this.readyState = 2; }
  }
  const context = vm.createContext({ document, window, navigator, EventSource: Source, auth: { me: async () => { reads++; } }, setTimeout(fn, ms) { timers.set(++seq, { fn, ms }); return seq; }, clearTimeout(id) { timers.delete(id); } });
  vm.runInContext(`${source}\nthis.subject={watchTaskChanges};`, context);
  return { ...context.subject, document, window, navigator, streams, timers, reads: () => reads, async flush(ms = 80) { const pending = [...timers.entries()].filter(([, x]) => x.ms <= ms); for (const [id, x] of pending) { timers.delete(id); await x.fn(); } } };
}
test('permission-close error refreshes authentication and visible canonical snapshots', async () => {
  const h = harness(); let refresh = 0; const stop = h.watchTaskChanges(() => refresh++);
  h.streams[0].emit('error'); await h.flush();
  assert.equal(h.reads(), 1); assert.equal(refresh, 1); stop();
});
test('native reconnect after server restart refreshes even when version equals pre-restart version', async () => {
  const h = harness(); let refresh = 0; const stop = h.watchTaskChanges(() => refresh++);
  h.streams[0].emit('change', { data: '{"version":22}' }); await h.flush();
  h.streams[0].emit('open'); await h.flush();
  assert.equal(refresh, 2); assert.equal(h.streams.length, 1); stop();
});
test('offline closes a dead stream and online opens exactly one new connection', async () => {
  const h = harness(); let refresh = 0; const stop = h.watchTaskChanges(() => refresh++);
  h.navigator.onLine = false; h.window.emit('offline'); assert.equal(h.streams[0].closed, true);
  h.navigator.onLine = true; h.window.emit('online'); h.window.emit('focus'); await h.flush();
  assert.equal(h.streams.length, 2); assert.equal(refresh, 1); stop();
});
test('pagehide suspends event delivery and pageshow resumes once after sleep or back-forward cache', async () => {
  const h = harness(); let refresh = 0; const stop = h.watchTaskChanges(() => refresh++);
  h.streams[0].emit('change', { data: '{"version":1}' }); h.window.emit('pagehide');
  await h.flush(); assert.equal(refresh, 0); assert.equal(h.streams[0].closed, true);
  h.window.emit('pageshow', { persisted: true }); await h.flush();
  assert.equal(h.streams.length, 2); assert.equal(refresh, 1); stop();
});
test('expired authentication cancels pending Task refresh and closes the stream immediately', async () => {
  const h = harness(); let refresh = 0; const stop = h.watchTaskChanges(() => refresh++);
  h.streams[0].emit('change', { data: '{"version":2}' }); h.window.emit('auth:expired'); await h.flush();
  assert.equal(h.streams[0].closed, true); assert.equal(refresh, 0); stop();
});
test('two tabs converge independently while two consumers in one tab share one stream', async () => {
  const a = harness(), b = harness(); let list = 0, detail = 0, other = 0;
  const stops = [a.watchTaskChanges(() => list++), a.watchTaskChanges(() => detail++), b.watchTaskChanges(() => other++)];
  for (const h of [a, b]) { h.streams[0].emit('change', { data: '{"version":3}' }); await h.flush(); }
  assert.deepEqual([list, detail, other], [1, 1, 1]); assert.equal(a.streams.length, 1); assert.equal(b.streams.length, 1); stops.forEach(stop => stop());
});

function commentEditHarness(fail = false) {
  const source = readFileSync(new URL('../public/components/task-detail.js', import.meta.url), 'utf8');
  const edit = source.slice(source.indexOf('function startCommentEdit('), source.indexOf('function wireMentionSuggest('));
  const nodes = [], writes = [], errors = [];
  const element = tag => { const value = { tag, children: [], listeners: {}, append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; }, addEventListener(name, fn) { this.listeners[name] = fn; }, focus() {} }; nodes.push(value); return value; };
  const context = vm.createContext({ document: { createElement: element }, t: key => key, wireMentionSuggest() {},
    taskRevision: task => ({ expected_revision: task.revision }),
    api: { patch: async (url, body) => { writes.push({ url, body }); if (fail) throw new Error('Refresh this Task before editing.'); } },
    window: { yuvomi: { showToast: message => errors.push(message) } } });
  vm.runInContext(`${edit}\nthis.edit=startCommentEdit;`, context);
  return { edit: context.edit, nodes, writes, errors, element };
}
test('successful comment edit leaves draft mode so guarded reload can publish the saved comment', async () => {
  const h = commentEditHarness(), row = h.element('row'), task = { revision: 4 }; let reloads = 0;
  h.edit(row, { id: 8, task_id: 2, comment: 'Previous', task_revision_snapshot: { expected_revision: 3 } }, { ctx: { task }, onChanged: async () => { assert.equal(row.children.length, 0); reloads++; } });
  const field = h.nodes.find(node => node.tag === 'textarea'), form = h.nodes.find(node => node.tag === 'form');
  field.value = 'Edited'; task.revision = 9;
  await form.listeners.submit({ preventDefault() {} });
  assert.equal(reloads, 1); assert.deepEqual(JSON.parse(JSON.stringify(h.writes)), [{ url: '/tasks/2/comments/8', body: { comment: 'Edited', expected_revision: 3 } }]);
});
test('rejected stale comment edit retains the draft and re-enables Save', async () => {
  const h = commentEditHarness(true), row = h.element('row'); let reloads = 0;
  h.edit(row, { id: 8, task_id: 2, comment: 'Previous' }, { ctx: { task: { revision: 4 } }, onChanged: async () => reloads++ });
  const field = h.nodes.find(node => node.tag === 'textarea'), form = h.nodes.find(node => node.tag === 'form'); field.value = 'Unsaved';
  await form.listeners.submit({ preventDefault() {} });
  assert.equal(reloads, 0); assert.equal(row.children[0], form); assert.equal(field.value, 'Unsaved');
  assert.equal(h.nodes.find(node => node.tag === 'button' && node.type === 'submit').disabled, false); assert.equal(h.errors.length, 1);
});
