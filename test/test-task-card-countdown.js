import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.HTMLElement ??= class {};
globalThis.customElements ??= { define() {}, get() {} };
const { __test: tasks } = await import('../public/pages/tasks.js');
const row = (patch = {}) => ({ id: 41, title: 'Prepare for tomorrow', category: 'misc',
  status: 'open', priority: 'none', due_date: '2026-10-06', due_time: '14:30', countdown: 1, ...patch });

test('enabling the persisted countdown renders it in the card due metadata', () => {
  const html = tasks.renderTaskCard(row());
  assert.match(html, /class="activity-card__when"[\s\S]*data-task-countdown/);
  assert.match(html, /data-due-date="2026-10-06"/);
  assert.match(html, /data-due-time="14:30"/);
});

test('off, undated, completed, archived and expired cards retain ordinary due metadata', () => {
  for (const patch of [{ countdown: 0 }, { due_date: null }, { status: 'done' },
    { archived_at: '2026-10-04' }, { status: 'expired' }, { expired_at: '2026-10-04' }]) {
    assert.doesNotMatch(tasks.renderTaskCard(row(patch)), /data-task-countdown/);
  }
});
