import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register('./test-browser-loader.mjs', import.meta.url);

// Expose the real private renderers only in this test import. Their dependencies
// use the same browser loader as the existing Dashboard and Calendar tests.
async function rendererModule(file, names) {
  const source = readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
  return import(`data:text/javascript,${encodeURIComponent(`${source}\nexport { ${names.join(', ')} };`)}`);
}
const { renderUrgentTasks, renderTodayCockpit, renderWallSurface } = await rendererModule('pages/dashboard.js', ['renderUrgentTasks', 'renderTodayCockpit', 'renderWallSurface']);
const { renderTaskChip } = await rendererModule('pages/calendar.js', ['renderTaskChip']);
const { wallWidgetContent } = await import('../public/components/wall-dashboard.js');
const { setDisplayTimeZone } = await import('../public/utils/timezone.js');

const task = {
  id: 42, title: 'Pack school bag', priority: 'medium', status: 'open',
  countdown: 1, due_date: '2030-01-02', due_time: '15:30', assigned_users: [],
};
const countdownSpan = /<span\b[^>]*class="[^"]*\btask-countdown\b[^>]*>/g;
const countCountdowns = html => [...html.matchAll(countdownSpan)].length;

test.beforeEach(t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2030-01-02T14:00:00Z') });
  setDisplayTimeZone('UTC');
});

test('Dashboard places one enabled task countdown in the existing due metadata', () => {
  const html = renderUrgentTasks([task]);
  assert.equal(countCountdowns(html), 1);
  assert.match(html, /class="task-item__meta[^\"]*"[^>]*>\s*<span[^>]*task-countdown/);
  assert.match(html, /(?:title|aria-label)="[^\"]*2030-01-02[^\"]*15:30/);
  assert.doesNotMatch(html, /dashboard\.dueToday/);
  assert.doesNotMatch(html, /task-item__meta--(?:soon|overdue)/, 'the live countdown owns urgency so a parent color cannot remain stale');
});

test('Calendar replaces the compact due time with the enabled task countdown', () => {
  const html = renderTaskChip(task);
  assert.equal(countCountdowns(html), 1);
  assert.match(html, /Pack school bag/);
  assert.match(html, /(?:title|aria-label)="[^\"]*2030-01-02[^\"]*15:30/);
  assert.doesNotMatch(html, />[^<]*15:30[^<]*</, 'the absolute time stays accessible without duplicating countdown metadata');
});

test('Calendar month chips retain their noninteractive, icon-free shape with countdown enabled', () => {
  const html = renderTaskChip(task, { interactive: false, icon: false });
  assert.equal(countCountdowns(html), 1);
  assert.doesNotMatch(html, /role="button"|tabindex=|data-lucide=/);
});

test('Wall Dashboard task rows receive the same countdown as the normal Dashboard', () => {
  const html = wallWidgetContent('tasks', { urgentTasks: [task] }, { tasks: renderUrgentTasks });
  assert.equal(countCountdowns(html), 1);
  assert.equal(html, renderUrgentTasks([task]));
});

test('Dashboard Today task cards show countdown in their time metadata', t => {
  const previousWindow = globalThis.window;
  globalThis.window = { yuvomi: null };
  t.after(() => { globalThis.window = previousWindow; });
  const html = renderTodayCockpit({ urgentTasks: [task] }, []);
  assert.equal(countCountdowns(html), 1);
  assert.match(html, /today-cockpit-card__time/);
  assert.doesNotMatch(html, /dashboard\.todayUntil/);
  assert.equal(countCountdowns(renderTodayCockpit({ urgentTasks: [{ ...task, countdown: 0 }] }, [])), 0);
});

test('the shared Today model retains countdown metadata for the large wall rows', t => {
  const previousWindow = globalThis.window;
  globalThis.window = { yuvomi: null };
  t.after(() => { globalThis.window = previousWindow; });
  const html = renderWallSurface({ urgentTasks: [task], users: [] }, null);
  assert.equal(countCountdowns(html), 1);
  assert.match(html, /wall-row__time/);
  assert.doesNotMatch(html, /dashboard\.todayUntil/);
});

test('date-only countdowns render on both surfaces without introducing a due time', () => {
  for (const render of [row => renderUrgentTasks([row]), renderTaskChip]) {
    const html = render({ ...task, due_date: '2030-01-03', due_time: null });
    assert.equal(countCountdowns(html), 1);
    assert.doesNotMatch(html, /(?:23:59|00:00)/);
  }
});

test('disabled, undated, and terminal tasks retain their existing metadata without countdowns', () => {
  for (const patch of [
    { countdown: 0 }, { countdown: undefined }, { due_date: null, due_time: null },
    { status: 'done' }, { status: 'expired' }, { archived_at: '2030-01-01T00:00:00Z' },
  ]) {
    for (const render of [row => renderUrgentTasks([row]), renderTaskChip]) {
      assert.equal(countCountdowns(render({ ...task, ...patch })), 0, JSON.stringify(patch));
    }
  }
  assert.match(renderUrgentTasks([{ ...task, countdown: 0 }]), /dashboard\.dueToday/);
  assert.match(renderTaskChip({ ...task, countdown: 0 }), />Pack school bag · 15:30</);
});
