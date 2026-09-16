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
  const entry = { id: 10, task_id: 1, event_type: 'expired', title: 'Get Ready for the Day', completed_at: null, expired_at: '2026-09-14T12:00:00Z', user_name: 'Alex' };
  const html = ui.renderHistoryEntry(entry);
  assert.match(html, /Expired · 0 completion points/);
  assert.match(html, /datetime="2026-09-14T12:00:00Z"/);
  assert.match(html, /history-entry:expired:10/);
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
