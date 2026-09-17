import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { parseTimeInput } from '../public/i18n.js';
import { esc } from '../public/utils/html-escape.js';

const read = path => readFileSync(new URL(`../public/${path}`, import.meta.url), 'utf8');
const plain = source => source.replace(/^import[\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');
const result = value => JSON.parse(JSON.stringify(value));
const rruleContext = vm.createContext({ t: key => key, formatDateInput: value => value, parseDateInput: value => value,
  isDateInputValid: value => /^\d{4}-\d{2}-\d{2}$/.test(value), formatDate: value => value });
vm.runInContext(`${plain(read('rrule-ui.js'))}\nthis.subject={renderRRuleFields,getRRuleValues};`, rruleContext);
const context = vm.createContext({ ...rruleContext.subject, esc, parseTimeInput, formatTimeInput: value => value });
vm.runInContext(`${plain(read('components/activity-automation.js'))}\nthis.subject={activityTimingFields,activityTimingPayload,activityChecklistPayload,memberOptions};`, context);
const ui = context.subject;
function formFixture(overrides = {}) {
  const values = { start_time: '07:00', due_time: '08:00', 'activity-rrule-freq': 'WEEKLY', 'activity-rrule-interval': '1',
    'activity-rrule-end': 'never', 'activity-rrule-source': 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', ...overrides };
  return { querySelector(selector) {
    const key = selector.startsWith('#') ? selector.slice(1) : selector.match(/name="([^"]+)"/)?.[1];
    return key === 'activity-rrule-from-completion' ? { checked: !!values.fromCompletion } : { value: values[key] ?? '' };
  }, querySelectorAll: () => ['MO', 'TU', 'WE', 'TH', 'FR'].map(day => ({ dataset: { day } })) };
}

test('template times reuse the shared datepicker and weekly recurrence controls without introducing dates', () => {
  const html = ui.activityTimingFields({ start_time: '07:00', due_time: '08:00', recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', recurrence_from_completion: 0 });
  assert.match(html, /yuvomi-datepicker type="time"[^>]+name="start_time" value="07:00"/);
  assert.match(html, /name="due_time" value="08:00"/);
  assert.match(html, /activity-rrule-from-completion/);
  assert.equal((html.match(/data-day="(?:MO|TU|WE|TH|FR)" aria-label="[^"]+" aria-pressed="true"/g) || []).length, 5);
  assert.doesNotMatch(html, /name="(?:start_date|due_date)"/);
});

test('unchanged template schedule retains weekdays and completion-relative opt-in', () => {
  assert.deepEqual(result(ui.activityTimingPayload(formFixture())), { values: { start_time: '07:00', due_time: '08:00', recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', recurrence_from_completion: 0 } });
  assert.equal(ui.activityTimingPayload(formFixture({ fromCompletion: true })).values.recurrence_from_completion, 1);
  assert.equal(ui.activityTimingPayload(formFixture({ 'activity-rrule-freq': '', fromCompletion: true })).values.recurrence_from_completion, 0);
  assert.equal(ui.activityTimingPayload(formFixture({ start_time: '', due_time: '' })).values.start_time, null);
});

test('template timing validation identifies bad fields while accepting local 12-hour input', () => {
  assert.equal(ui.activityTimingPayload(formFixture({ start_time: '7:00 AM' })).values.start_time, '07:00');
  assert.deepEqual(result(ui.activityTimingPayload(formFixture({ due_time: '29:80' }))), { error: 'Enter a valid due time.', field: 'due_time' });
  assert.equal(ui.activityTimingPayload(formFixture({ 'activity-rrule-end': 'until', 'activity-rrule-until': 'bad' })).field, 'activity-rrule-until');
});

test('template checklist submission retains IDs, Optional and other metadata when titles change', () => {
  const items = [{ id: 41, title: ' Stretch ', title_template: 'Stretch old', skill_ids: [7], is_optional: 1, extra: { keep: true } },
    { id: 42, title: 'Brush teeth', skill_ids: [], is_optional: 0 }];
  const rows = result(ui.activityChecklistPayload(items));
  assert.deepEqual(rows.map(row => [row.id, row.title_template, row.is_optional]), [[41, 'Stretch', 1], [42, 'Brush teeth', 0]]);
  assert.deepEqual(rows[0].skill_ids, [7]); assert.deepEqual(rows[0].extra, { keep: true });
  assert.equal(items[0].title_template, 'Stretch old', 'serialization does not mutate original item definitions');
});

test('fixed member selection remains empty by default and matches the saved stable ID', () => {
  const members = [{ id: 2, display_name: 'Eleanor' }, { id: 3, display_name: 'Gracelynn' }];
  assert.doesNotMatch(ui.memberOptions(members), / selected/);
  assert.match(ui.memberOptions(members, 2), /value="2" selected>Eleanor/);
  assert.doesNotMatch(ui.memberOptions(members, 2), /value="3" selected/);
});
