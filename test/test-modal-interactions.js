import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Execute the real modal functions with small DOM doubles. Keeping the private
// helpers private avoids adding a production API solely for these regressions.
const source = readFileSync(new URL('../public/components/modal.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?;\r?\n/gm, '')
  .replace(/^export /gm, '');

function modalHarness() {
  const document = { activeElement: null };
  const context = vm.createContext({
    document,
    getComputedStyle: (el) => ({ visibility: el.visibility }),
    matchMedia: () => ({ matches: false }),
    setTimeout: (callback) => { callback(); return 1; },
    clearTimeout: () => {},
  });
  vm.runInContext(`${source}\nthis.modal = {
    trapFocus, applyInitialFocus, focusFirstField, isFormDirty,
    snapshot(container) { _initialFormSnapshot = serializeForm(container); },
  };`, context);

  function control(options = {}) {
    return {
      tagName: 'INPUT', type: 'text', name: '', id: '', value: '',
      tabIndex: 0, checked: false, multiple: false, selectedOptions: [],
      hiddenAncestor: false, disabled: false, rendered: true, visibility: 'visible',
      matches: function () { return this.disabled; },
      closest: function () { return this.hiddenAncestor ? {} : null; },
      getClientRects: function () { return this.rendered ? [{}] : []; },
      focus: function () { document.activeElement = this; },
      ...options,
    };
  }

  function container(controls) {
    const listeners = new Map();
    return {
      listeners,
      querySelectorAll(selector) {
        if (selector === 'input:not([type="file"]), select, textarea') {
          return controls.filter((el) => el.type !== 'file');
        }
        if (selector.startsWith('input:not([type="hidden"])')) {
          return controls.filter((el) => ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) && el.type !== 'hidden');
        }
        return controls;
      },
      querySelector: () => null,
      addEventListener: (name, listener) => listeners.set(name, listener),
      setAttribute: function (name, value) { this[name] = value; },
      focus: function () { document.activeElement = this; },
    };
  }

  return { modal: context.modal, document, control, container };
}

test('checkbox-only edits require confirmation and reverting the toggle restores a clean form', () => {
  const { modal, control, container } = modalHarness();
  const countdown = control({ id: 'countdown', type: 'checkbox', value: 'on' });
  const panel = container([countdown]);
  modal.snapshot(panel);
  countdown.checked = true;
  assert.equal(modal.isFormDirty(panel), true);
  countdown.checked = false;
  assert.equal(modal.isFormDirty(panel), false);
});

test('switching radio choices and adding another selected option are dirty edits', () => {
  const { modal, control, container } = modalHarness();
  const first = control({ name: 'meal_choice', type: 'radio', value: '1', checked: true });
  const second = control({ name: 'meal_choice', type: 'radio', value: '2' });
  const choices = container([first, second]);
  modal.snapshot(choices);
  first.checked = false;
  second.checked = true;
  assert.equal(modal.isFormDirty(choices), true);

  const members = control({ tagName: 'SELECT', name: 'members', multiple: true, value: '1', selectedOptions: [{ value: '1' }] });
  const form = container([members]);
  modal.snapshot(form);
  members.selectedOptions.push({ value: '2' });
  assert.equal(modal.isFormDirty(form), true, 'the first selected value did not change');
  members.selectedOptions.pop();
  assert.equal(modal.isFormDirty(form), false);
});

test('form snapshots retain text boundaries and ordinary field changes', () => {
  const { modal, control, container } = modalHarness();
  const first = control({ name: 'a', value: '1&b=2' });
  const second = control({ name: 'b', value: '3' });
  const panel = container([first, second]);
  modal.snapshot(panel);
  first.value = '1';
  second.value = '2&b=3';
  assert.equal(modal.isFormDirty(panel), true, 'text containing separators cannot hide an edit');
  first.value = '1&b=2';
  second.value = '3';
  assert.equal(modal.isFormDirty(panel), false);
  second.value = 'updated';
  assert.equal(modal.isFormDirty(panel), true);
});

function tab(panel, shiftKey = false) {
  let prevented = false;
  panel.listeners.get('keydown')({ key: 'Tab', shiftKey, preventDefault: () => { prevented = true; } });
  return prevented;
}

test('Tab and Shift+Tab wrap around visible controls after the edit pane is hidden', () => {
  const { modal, document, control, container } = modalHarness();
  const edit = control({ tagName: 'BUTTON' });
  const close = control({ tagName: 'BUTTON' });
  const field = control();
  const panel = container([edit, close, field]);
  modal.trapFocus(panel, 'none');

  // Returning to Detail keeps the edit field in the DOM, under a hidden pane.
  field.hiddenAncestor = true;
  close.focus();
  assert.equal(tab(panel), true);
  assert.equal(document.activeElement, edit);
  assert.equal(tab(panel, true), true);
  assert.equal(document.activeElement, close);
});

test('focus skips hidden, collapsed, inert, disabled and excluded controls', () => {
  const { modal, document, control, container } = modalHarness();
  const unavailable = [
    control({ type: 'hidden' }),
    control({ hiddenAncestor: true }),
    control({ rendered: false }), // closed details or display:none
    control({ visibility: 'hidden' }),
    control({ disabled: true }),
    control({ tabIndex: -1 }),
  ];
  const field = control({ id: 'visible-title' });
  const panel = container([...unavailable, field]);
  modal.applyInitialFocus(panel, 'first-field');
  assert.equal(document.activeElement, field);
  document.activeElement = null;
  assert.equal(modal.focusFirstField(panel), field);
  assert.equal(document.activeElement, field);
  modal.trapFocus(panel, 'none');
  assert.equal(tab(panel), true);
  assert.equal(document.activeElement, field);
});

test('a heading focus enters the current Tab sequence and empty panels retain focus', () => {
  const { modal, document, control, container } = modalHarness();
  const first = control();
  const last = control({ tagName: 'BUTTON' });
  const panel = container([first, last]);
  modal.trapFocus(panel, 'none');
  document.activeElement = panel;
  assert.equal(tab(panel), true);
  assert.equal(document.activeElement, first);
  document.activeElement = panel;
  assert.equal(tab(panel, true), true);
  assert.equal(document.activeElement, last);

  const empty = container([]);
  modal.trapFocus(empty, 'none');
  assert.equal(tab(empty), true);
  assert.equal(document.activeElement, empty);
  assert.equal(empty.tabindex, '-1');
});

test('shared form hints are styled without loading Settings and retain scoped reading width', () => {
  const read = (name) => readFileSync(new URL(`../public/styles/${name}.css`, import.meta.url), 'utf8');
  const layout = read('layout');
  const settings = read('settings');
  assert.match(layout, /\.form-hint\s*\{[^}]*font-size:\s*var\(--text-sm\);[^}]*color:\s*var\(--color-text-secondary\);/);
  for (const tone of ['success', 'danger']) {
    assert.match(layout, new RegExp(`\\.form-hint--${tone} \\{ color: var\\(--color-${tone}\\); \\}`));
  }
  assert.doesNotMatch(settings, /^\.form-hint(?:\s*\{|--)/m, 'Settings must not own generic hint rules');
  assert.match(settings, /\.settings-page \.form-hint,/);
  assert.doesNotMatch(read('meals'), /@import[^;]*settings\.css/, 'Kitchen needs the shared base without importing Settings');
});

test('Task detail controls use the available row width and stack on compact screens', () => {
  const detail = readFileSync(new URL('../public/styles/detail-view.css', import.meta.url), 'utf8');
  const tasks = readFileSync(new URL('../public/styles/tasks.css', import.meta.url), 'utf8');
  assert.match(detail, /\.detail-task-subtasks\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;/);
  assert.match(tasks, /\.task-detail-participants\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;/);
  assert.match(tasks, /@media \(max-width: 640px\)\s*\{\s*\.task-detail-participant-add\s*\{[^}]*flex-direction:\s*column;[^}]*align-items:\s*stretch;/);
});
