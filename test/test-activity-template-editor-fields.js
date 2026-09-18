import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { parseTimeInput, parseDateInput, isDateInputValid } from '../public/i18n.js';
import { esc } from '../public/utils/html-escape.js';

const read = path => readFileSync(new URL(`../public/${path}`, import.meta.url), 'utf8');
const plain = source => source.replace(/^import[\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');
const result = value => JSON.parse(JSON.stringify(value));
const rruleContext = vm.createContext({ t: key => key, formatDateInput: value => value, parseDateInput: value => value,
  isDateInputValid: value => /^\d{4}-\d{2}-\d{2}$/.test(value), formatDate: value => value });
vm.runInContext(`${plain(read('rrule-ui.js'))}\nthis.subject={renderRRuleFields,getRRuleValues};`, rruleContext);
const context = vm.createContext({ ...rruleContext.subject, esc, parseTimeInput, parseDateInput, isDateInputValid, formatDateInput: value => value, formatTimeInput: value => value });
vm.runInContext(`${plain(read('components/activity-automation.js'))}\nthis.subject={activityTimingFields,activityTimingPayload,activityChecklistPayload,memberOptions};`, context);
const ui = context.subject;
function formFixture(overrides = {}) {
  const values = { start_time: '07:00', due_time: '08:00', due_date_offset_days: '0', 'activity-rrule-freq': 'WEEKLY', 'activity-rrule-interval': '1',
    'activity-rrule-end': 'never', 'activity-rrule-source': 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', ...overrides };
  return { querySelector(selector) {
    const key = selector.startsWith('#') ? selector.slice(1) : selector.match(/name="([^"]+)"/)?.[1];
    return key === 'activity-rrule-from-completion' ? { checked: !!values.fromCompletion } : { value: values[key] ?? '', dataset: values.dataset || {} };
  }, querySelectorAll: () => ['MO', 'TU', 'WE', 'TH', 'FR'].map(day => ({ dataset: { day } })) };
}

test('template exposes relative days and local times without absolute date controls', () => {
  const html = ui.activityTimingFields({ due_date_offset_days: 0, start_time: '07:00', due_time: '08:00', recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', recurrence_from_completion: 0 });
  assert.match(html, /yuvomi-datepicker type="time"[^>]+name="start_time" value="07:00"/);
  assert.match(html, /name="due_time" value="08:00"/);
  assert.match(html, /activity-rrule-from-completion/);
  assert.equal((html.match(/data-day="(?:MO|TU|WE|TH|FR)" aria-label="[^"]+" aria-pressed="true"/g) || []).length, 5);
  assert.deepEqual([...html.matchAll(/name="((?:start|due)_(?:date|time))"/g)].map(match => match[1]), ['start_time', 'due_time']);
  assert.match(html, /value="0" selected>Same day/);
  assert.match(html, /value="4" >4 days later/);
  assert.match(ui.activityTimingFields({ due_date_offset_days: 12 }), /value="custom" selected/);
  assert.match(ui.activityTimingFields({ due_date_offset_days: 12 }), /name="due_date_offset_custom" value="12"/);
});

test('unchanged template schedule retains weekdays and completion-relative opt-in', () => {
  assert.deepEqual(result(ui.activityTimingPayload(formFixture())), { values: { due_date_offset_days: 0, start_time: '07:00', due_time: '08:00', recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', recurrence_from_completion: 0 } });
  assert.equal(ui.activityTimingPayload(formFixture({ fromCompletion: true })).values.recurrence_from_completion, 1);
  assert.equal(ui.activityTimingPayload(formFixture({ 'activity-rrule-freq': '', fromCompletion: true })).values.recurrence_from_completion, 0);
  assert.equal(ui.activityTimingPayload(formFixture({ start_time: '', due_time: '' })).values.start_time, null);
});

test('template offsets support multi-day and custom windows without inferring overnight', () => {
  const homework = { due_date_offset_days: '4', start_time: '15:30', due_time: '07:30' };
  const values = ui.activityTimingPayload(formFixture(homework)).values;
  assert.equal(values.due_date_offset_days, 4); assert.equal(values.start_time, '15:30'); assert.equal(values.due_time, '07:30');
  const invalid = ui.activityTimingPayload(formFixture({ start_time: '22:00', due_time: '06:00' }));
  assert.equal(invalid.field, 'due_date_offset_days'); assert.match(invalid.error, /Set Due to 1 day later/);
  assert.equal(ui.activityTimingPayload(formFixture({ start_time: '22:00', due_time: '06:00', due_date_offset_days: '1' })).values.due_date_offset_days, 1);
  assert.equal(ui.activityTimingPayload(formFixture({ start_time: '07:00', due_time: '07:00' })).error, undefined);
  assert.equal(ui.activityTimingPayload(formFixture({ due_date_offset_days: 'custom', due_date_offset_custom: '12' })).values.due_date_offset_days, 12);
  for (const value of ['', '-1', '1.5', '3651', 'NaN']) assert.equal(ui.activityTimingPayload(formFixture({ due_date_offset_days: 'custom', due_date_offset_custom: value })).field, 'due_date_offset_custom');
});

test('unchanged unknown intervals remain null until the schedule is explicitly changed', () => {
  const dataset = { offsetUnset: 'true', initialStartTime: '07:00', initialDueTime: '08:00' };
  assert.equal(ui.activityTimingPayload(formFixture({ dataset })).values.due_date_offset_days, null);
  assert.equal(ui.activityTimingPayload(formFixture({ dataset: { ...dataset, offsetChanged: 'true' } })).values.due_date_offset_days, 0);
  assert.equal(ui.activityTimingPayload(formFixture({ start_time: '', due_time: '', dataset: { offsetUnset: 'true' } })).values.due_date_offset_days, null);
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
