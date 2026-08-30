/**
 * Tasks-Kalender: reine Datums- und Abfrageverträge.
 * Ausführen:
 *   node --loader ./test/test-browser-loader.mjs --test test/test-tasks-calendar.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Die Tasks-Seite importiert Browser-Web-Components. Für die hier geprüften
// reinen Helfer reicht ein leerer Custom-Element-Platzhalter.
globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };

const { __test: tasks } = await import('../public/pages/tasks.js');

test('Monatsraster enthält immer 42 Tage und respektiert Montag als Wochenstart', () => {
  const days = tasks.buildTaskMonthDays('2026-08-01', 1);

  assert.equal(days.length, 42);
  assert.equal(days[0].date, '2026-07-27');
  assert.equal(days.at(-1).date, '2026-09-06');
  assert.equal(days.filter((day) => day.inMonth).length, 31);
  assert.equal(days[0].inMonth, false);
  assert.equal(days.at(-1).inMonth, false);
});

test('Monatsraster respektiert Sonntag als Wochenstart und rollt in Nachbarmonate', () => {
  const days = tasks.buildTaskMonthDays('2026-08-19', 0);

  assert.equal(days.length, 42);
  assert.equal(days[0].date, '2026-07-26');
  assert.equal(days.at(-1).date, '2026-09-05');
  assert.equal(new Date(`${days[0].date}T12:00:00`).getDay(), 0);
});

test('Monatsraster respektiert Samstag als Wochenstart', () => {
  const days = tasks.buildTaskMonthDays('2026-08-31', 6);

  assert.equal(days.length, 42);
  assert.equal(days[0].date, '2026-08-01');
  assert.equal(days.at(-1).date, '2026-09-11');
  assert.equal(new Date(`${days[0].date}T12:00:00`).getDay(), 6);
});

test('umgekehrt gezogene Auswahl wird chronologisch normalisiert', () => {
  assert.deepEqual(
    tasks.normalizeTaskCalendarRange('2026-09-12', '2026-09-03'),
    { start_date: '2026-09-03', due_date: '2026-09-12' },
  );
});

test('Kalenderdatum bevorzugt Fälligkeit und fällt auf Startdatum zurück', () => {
  assert.equal(
    tasks.taskCalendarDate({ start_date: '2026-09-03', due_date: '2026-09-12' }),
    '2026-09-12',
  );
  assert.equal(tasks.taskCalendarDate({ start_date: '2026-09-03', due_date: null }), '2026-09-03');
  assert.equal(tasks.taskCalendarDate({}), null);
});

test('Kalenderabfrage fordert zukünftige Aufgaben an und behält Statusfilter', () => {
  const snapshot = {
    viewMode: tasks.state.viewMode,
    showFuture: tasks.state.showFuture,
    filters: {
      status: [...tasks.state.filters.status],
      priority: [...tasks.state.filters.priority],
      assigned_to: [...tasks.state.filters.assigned_to],
      tags: [...tasks.state.filters.tags],
    },
  };

  try {
    tasks.state.viewMode = 'calendar';
    tasks.state.showFuture = false;
    tasks.state.filters.status = ['open', 'in_progress'];
    tasks.state.filters.priority = ['high'];
    tasks.state.filters.assigned_to = [];
    tasks.state.filters.tags = [];

    const params = new URLSearchParams(tasks.taskQuery().slice(1));
    assert.equal(params.get('include_future'), '1');
    assert.deepEqual(params.getAll('status'), ['open', 'in_progress']);
    assert.deepEqual(params.getAll('priority'), ['high']);
  } finally {
    tasks.state.viewMode = snapshot.viewMode;
    tasks.state.showFuture = snapshot.showFuture;
    tasks.state.filters = snapshot.filters;
  }
});
