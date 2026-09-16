import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '/api.js';
import { isExpired, taskCompletionPoints, completionCounts, FILTER_STATUSES } from '../public/utils/task-fields.js';
import { changeTaskStatus, reopenExpiredTask } from '../public/utils/task-state.js';
import { createManualTaskDraft, taskDraftToActivity } from '../public/utils/task-draft.js';
import { helperWaitingLabel } from '../public/utils/task-progress.js';

globalThis.HTMLElement ??= class {};
globalThis.customElements ??= { define() {}, get() {} };
const { __test: ui } = await import('../public/pages/tasks.js');
const { __test: detail } = await import('../public/components/task-detail.js');

const morning = () => ({ id: 1, title: 'Get Ready for the Day', status: 'expired', points: 2, expiration_policy: 'expire_incomplete',
  start_date: '2026-09-14', start_time: '07:00', due_date: '2026-09-14', due_time: '08:00', expired_at: '2026-09-14T12:00:00Z',
  is_recurring: 1, recurrence_rule: 'FREQ=DAILY', revision: 4, priority: 'none', category: 'misc',
  permissions: { edit: true, change_dates: true, complete: false }, subtasks: [
    { id: 2, title: 'Brush teeth', status: 'done', points: 0, permissions: { complete: true } },
    { id: 3, title: 'Pack bag', status: 'expired', points: 0, permissions: { complete: true } },
  ] });

test('expired occurrence has zero available parent points without losing its reward or partial progress', () => {
  const task = morning();
  assert.equal(isExpired(task), true);
  assert.equal(taskCompletionPoints(task), 0);
  assert.equal(task.points, 2);
  assert.deepEqual(completionCounts(task), { done: 1, total: 2, earnedPoints: 0, totalPoints: 0 });
  assert.equal(taskCompletionPoints({ ...task, status: 'open' }), 2);
});

test('expired stays a distinct historical status across archive and due grouping', () => {
  assert.ok(FILTER_STATUSES().some(row => row.value === 'expired'));
  assert.equal(ui.kanbanSectionOf(morning()), 'expired');
  assert.equal(ui.kanbanSectionOf({ ...morning(), archived_at: '2026-09-15' }), 'archived');
  assert.equal(ui.statusForBoardDrop(morning(), 'active'), 'expired');
  assert.deepEqual(ui.groupBy([morning()], 'due').map(row => row.id), ['expired']);
  assert.equal(helperWaitingLabel({ ...morning(), waiting_on_helper: true }, 1), '');
});

test('expired cards show zero points and history but offer no completion or child toggle', () => {
  const card = ui.renderTaskCard(morning(), { expandedSubtasks: true, board: true });
  assert.match(card, /activity-card__status-label--expired">Expired/);
  assert.match(card, /activity-card__points">tasks.pointsSummary\{&quot;count&quot;:0\}/);
  assert.doesNotMatch(card, /due-date--overdue|data-task-drag-handle|Helper needed|Supervision needed/);
  assert.match(card, /data-action="toggle-status"[^>]+disabled/);
  assert.match(card, /data-action="toggle-subtask" data-id="2"[^>]+disabled/);
  assert.match(card, /data-action="toggle-subtask" data-id="3"[^>]+disabled/);
  assert.match(card, /Brush teeth/);
});

test('default active query omits expired while the board requests its own historical section', () => {
  const previous = ui.state.viewMode;
  try {
    ui.state.viewMode = 'list';
    assert.deepEqual(new URLSearchParams(ui.taskQuery()).getAll('status'), ['open', 'in_progress']);
    ui.state.viewMode = 'kanban';
    assert.ok(new URLSearchParams(ui.taskQuery()).getAll('status').includes('expired'));
  } finally { ui.state.viewMode = previous; }
});

test('Task editor and reusable drafts preserve optional expiration policy and the 7-8 AM window', () => {
  assert.equal(createManualTaskDraft().expiration_policy, 'keep_overdue');
  const draft = createManualTaskDraft({ template: morning() });
  assert.equal(draft.expiration_policy, 'expire_incomplete');
  assert.equal(taskDraftToActivity(draft).expiration_policy, 'expire_incomplete');
  const editor = ui.renderModalContent({ task: morning() });
  assert.match(editor, /name="start_time"\s+value="07:00"/);
  assert.match(editor, /name="due_time"\s+value="08:00"/);
  assert.match(editor, /value="expire_incomplete" selected/);
  assert.match(editor, /Repeat from completion pauses/);
  assert.match(editor, /id="task-status" name="status" disabled/);
});

test('restricted Task editors cannot submit deadline policy or start-time changes', () => {
  const body = ui.permittedTaskBody({ expiration_policy: 'expire_incomplete', start_time: '07:00' }, { permissions: { edit: true, change_dates: false } });
  assert.equal(Object.hasOwn(body, 'expiration_policy'), false);
  assert.equal(Object.hasOwn(body, 'start_time'), false);
});

test('expired history uses its actual transition time and never pretends completion', () => {
  const entry = { id: 10, task_id: 1, event_type: 'expired', title: 'Get Ready for the Day', completed_at: null, expired_at: '2026-09-14T12:00:00Z', user_name: null };
  const html = ui.renderHistoryEntry(entry);
  assert.match(html, /Task expired · 0 completion points/);
  assert.match(html, /datetime="2026-09-14T12:00:00Z"/);
  assert.match(html, /history-entry:expired:10/);
  assert.match(html, /data-lucide="clock"/);
  assert.doesNotMatch(html, /historyUnknownMember|Completed/);
  assert.doesNotMatch(ui.renderHistoryEntry({ ...entry, user_name: 'Misleading actor', user_avatar: 'member-avatar.png' }), /Misleading actor|member-avatar/);
  for (const event_type of ['completed', undefined]) {
    const completed = { ...entry, event_type, expired_at: null, completed_at: '2026-09-14T11:59:59Z' };
    assert.match(ui.renderHistoryEntry({ ...completed, user_name: 'Alex' }), /Alex/);
    assert.match(ui.renderHistoryEntry(completed), /tasks.historyUnknownMember/);
    assert.doesNotMatch(ui.renderHistoryEntry(completed), /Task expired|data-lucide="clock"/);
  }
});

// Exercise the real asynchronous detail renderers with only their DOM/API edges stubbed.
async function renderedHistory({ events = [], occurrences = [] }, render) {
  const originalDocument = globalThis.document, originalGet = api.get;
  class Node {
    children = []; isConnected = true; ownText = '';
    set textContent(value) { this.ownText = String(value); this.children = []; }
    get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
    append(...children) { this.children.push(...children); }
    appendChild(child) { this.append(child); return child; }
    replaceChildren(...children) { this.ownText = ''; this.children = children; }
  }
  try {
    globalThis.document = { createElement: () => new Node() };
    api.get = async path => ({ data: path.endsWith('/activity') ? events : occurrences });
    const ctx = {}, activity = detail.activityNode(morning(), ctx);
    const history = render === 'activity' ? activity : detail.seriesHistoryNode(morning(), ctx);
    await new Promise(resolve => setImmediate(resolve));
    return history.textContent;
  } finally { globalThis.document = originalDocument; api.get = originalGet; }
}

test('Task detail Activity labels automatic expiration without a member and preserves manual action attribution', async () => {
  const events = ['expired', 'status_changed', 'reopened', 'completed', 'archived', 'member_removed'].map((event_type, id) => ({
    id, event_type, actor_name: event_type === 'expired' ? 'Misleading actor' : 'Alex', created_at: '2026-09-14T12:00:00Z', details: { title: 'Morning routine' },
  }));
  const text = await renderedHistory({ events }, 'activity');
  assert.match(text, /Task expired · 0 completion points · Morning routine/);
  assert.doesNotMatch(text, /Misleading actor|historyUnknownMember/);
  for (const label of ['Status changed', 'Reopened', 'Completed', 'archived', 'member removed']) {
    assert.ok(text.includes(`${label} · Morning routine · Alex`));
  }
});

test('Task detail occurrence history distinguishes automatic expiry from a removed completing member, including archived occurrences', async () => {
  const base = { user_name: null, archived_at: '2026-09-15T12:00:00Z' };
  const completed = { ...base, completed_at: '2026-09-14T11:59:59Z', expired_at: null };
  const text = await renderedHistory({ occurrences: [
    { ...base, event_type: 'expired', expired_at: '2026-09-14T12:00:00Z', completed_at: null },
    { ...base, event_type: 'expired', expired_at: '2026-09-14T12:00:00Z', completed_at: null, user_name: 'Misleading actor' },
    { ...completed, event_type: 'completed' },
    { ...completed, event_type: 'completed', user_name: 'Alex' },
    { ...completed, user_name: 'Legacy member' },
    completed,
  ] });
  assert.match(text, /Task expired · 0 completion points/);
  assert.doesNotMatch(text, /Task expired · 0 completion points ·|Misleading actor/);
  assert.match(text, /Completed · tasks.historyUnknownMember/);
  assert.match(text, /Completed · Alex/);
  assert.match(text, /Completed · Legacy member/);
});

test('Task detail Activity fallback retains automatic expiration without attributing a member', async () => {
  const event = { event_type: 'expired', action_task_id: 1, actor_name: 'Misleading actor', created_at: '2026-09-14T12:00:00Z' };
  const text = await renderedHistory({ events: [event] });
  assert.match(text, /Task expired · 0 completion points · History retained in Activity/);
  assert.doesNotMatch(text, /Misleading actor|historyUnknownMember|Historical completion/);
  const completion = await renderedHistory({ events: [{ ...event, event_type: 'completed', actor_name: 'Alex' }] });
  assert.match(completion, /Alex · Historical completion retained in Activity/);
});

test('completion and manual expiration are rejected before a status request', async () => {
  const original = api.patch; let writes = 0;
  try {
    api.patch = async () => writes++;
    await assert.rejects(changeTaskStatus(morning(), 'done'), /Reopen/);
    await assert.rejects(changeTaskStatus({ ...morning(), status: 'open' }, 'expired'), /automatically/);
    assert.equal(writes, 0);
  } finally { api.patch = original; }
});

test('explicit reopen captures revision and confirms reward and per-occurrence policy before writing', async () => {
  const original = api.post, writes = [], task = morning();
  try {
    api.post = async (path, body) => writes.push({ path, body });
    assert.equal(await reopenExpiredTask(task, { confirm: async () => false }), null);
    assert.equal(writes.length, 0);
    await reopenExpiredTask(task, { confirm: async (_message, options) => {
      assert.match(options.detail, /2 completion points/);
      assert.match(options.detail, /Already-created future occurrences stay unchanged/);
      assert.match(options.detail, /Repeat from completion, future occurrences will also keep overdue/);
      task.revision = 5;
      return true;
    } });
    assert.deepEqual(writes, [{ path: '/tasks/1/reopen', body: { expiration_policy: 'keep_overdue', expected_revision: 4 } }]);
  } finally { api.post = original; }
});

test('archived expired work and restricted members cannot invoke reopen', async () => {
  await assert.rejects(reopenExpiredTask({ ...morning(), archived_at: '2026-09-15' }), /cannot reopen/);
  await assert.rejects(reopenExpiredTask({ ...morning(), permissions: { edit: true, change_dates: false } }), /cannot reopen/);
});
