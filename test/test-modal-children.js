import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/components/modal.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');

// Real close/dirty/suspend/restore/history orchestration; only DOM mounting,
// animation completion, and the user's answer are controlled boundaries.
function harness({ mobile = false } = {}) {
  const overlays = [], observers = new Set(), timers = new Map();
  const document = {
    activeElement: null, body: { style: {} },
    addEventListener() {}, removeEventListener() {},
    querySelector: () => overlays.find((el) => el.isConnected) || null,
    querySelectorAll: () => overlays.filter((el) => el.isConnected),
    getElementById: (id) => overlays.find((el) => el.id === id && el.isConnected) || null,
  };
  function mount(options) {
    const field = { id: 'draft', type: 'text', value: options.value || '', isConnected: true,
      focus() { document.activeElement = field; } };
    const panel = { field, scrollTop: 187, expanded: true,
      querySelectorAll: () => [field], removeEventListener() {}, addEventListener() {},
      classList: { add() {} } };
    const title = { id: 'shared-modal-title', removeAttribute(name) { this[name] = ''; } };
    const overlay = { id: 'shared-modal-overlay', isConnected: true, inert: false,
      _onCloseCallback: options.onClose,
      querySelector: (selector) => selector === '.modal-panel' ? panel : selector === '#shared-modal-title' ? title : null,
      contains: (target) => target === field,
      removeAttribute(name) { this[name] = ''; },
      remove() { this.isConnected = false; field.isConnected = false; for (const observer of observers) observer(); },
    };
    overlays.push(overlay);
    return overlay;
  }
  let sequence = 0;
  const context = vm.createContext({ document, window: { innerWidth: mobile ? 390 : 1366 },
    t: (key) => key, mount,
    setTimeout: (callback, delay) => { timers.set(++sequence, { callback, delay }); return sequence; },
    clearTimeout: (id) => timers.delete(id),
    MutationObserver: class { constructor(callback) { this.callback = callback; } observe() { observers.add(this.callback); } disconnect() { observers.delete(this.callback); } },
  });
  vm.runInContext(`${source}
    _syncOverlayRegistration = () => {};
    openModal = (options = {}) => {
      previouslyFocused = document.activeElement;
      activeOverlay = mount(options);
      modalState = 'open';
      document.activeElement = activeOverlay.querySelector('.modal-panel').field;
      _snapshotNow();
      options.onSave?.(activeOverlay.querySelector('.modal-panel'));
    };
    confirmModal = () => new Promise(resolve => {
      openModal({});
      const confirmation = activeOverlay;
      this.choose = async value => { await closeModal({force:true}); resolve(value); };
    });
    this.modal = { open: openModal, child: openChildModal, close: closeModal,
      active: () => activeOverlay, dirty: isFormDirty, back: _closeFromBackNavigation };
  `, context);
  const finishAnimation = () => {
    for (const [id, timer] of [...timers]) if (timer.delay === 400) { timers.delete(id); timer.callback(); }
  };
  context.modal.open({ value: 'clean parent' });
  const parent = context.modal.active();
  const panel = parent.querySelector('.modal-panel');
  panel.field.value = 'unsaved parent';
  return { modal: context.modal, context, document, parent, panel, finishAnimation, overlays };
}

for (const mobile of [false, true]) {
  test(`child Cancel retains parent values, expansion, scroll, focus and dirty baseline (${mobile ? 'mobile' : 'desktop'})`, async () => {
    const { modal, document, parent, panel, finishAnimation } = harness({ mobile });
    const child = modal.child({ value: 'child' });
    assert.equal(parent.inert, true);
    assert.equal(parent.id, '');
    const closing = child.close();
    if (mobile) { assert.equal(parent.inert, true); finishAnimation(); }
    assert.equal(await closing, true);
    assert.equal(modal.active(), parent);
    assert.equal(parent.inert, false);
    assert.equal(parent.id, 'shared-modal-overlay');
    assert.equal(panel.field.value, 'unsaved parent');
    assert.equal(panel.scrollTop, 187);
    assert.equal(panel.expanded, true);
    assert.equal(document.activeElement, panel.field);
    assert.equal(modal.dirty(panel), true);
  });
}

test('nested child editors return one level at a time without discarding either parent', async () => {
  const { modal, parent, panel } = harness();
  const first = modal.child({ value: 'first child' });
  const firstOverlay = modal.active();
  first.panel.field.value = 'edited first child';
  const second = modal.child({ value: 'second child' });
  await second.close({ force: true });
  assert.equal(modal.active(), firstOverlay);
  assert.equal(first.panel.field.value, 'edited first child');
  assert.equal(modal.dirty(first.panel), true);
  await first.close({ force: true });
  assert.equal(modal.active(), parent);
  assert.equal(panel.field.value, 'unsaved parent');
});

test('dirty child cancel/discard confirmation and Back retain the launcher', async () => {
  const { modal, context, parent } = harness();
  const child = modal.child({ value: 'clean workflow' });
  child.panel.field.value = 'changed workflow';
  const cancelled = child.close();
  await context.choose(false);
  assert.equal(await cancelled, false);
  assert.equal(child.panel.field.value, 'changed workflow');
  assert.equal(parent.inert, true);
  const back = modal.back();
  await context.choose(true);
  await back;
  await child.closed;
  assert.equal(modal.active(), parent);
});

test('session-end navigation removes parked parents without restoring a phantom modal', async () => {
  const { modal, parent, finishAnimation, document } = harness({ mobile: true });
  const child = modal.child({ value: 'workflow' });
  await modal.back({ force: true });
  finishAnimation();
  await child.closed;
  assert.equal(parent.isConnected, false);
  assert.equal(modal.active(), null);
  assert.equal(document.body.style.overflow, '');
});

test('a failed child mount restores the live parent', () => {
  const { modal, parent, panel, overlays } = harness();
  assert.throws(() => modal.child({ onSave() { throw new Error('mount failed'); } }), /mount failed/);
  assert.equal(modal.active(), parent);
  assert.equal(panel.field.value, 'unsaved parent');
  assert.equal(parent.inert, false);
  assert.equal(overlays.filter((overlay) => overlay.isConnected).length, 1);
});

test('confirmation checkbox is optional, reports its value, and keeps the boolean confirm/cancel contract', async () => {
  for (const accepted of [true, false]) {
    const context = vm.createContext({ t: (key) => key, esc: (value) => String(value).replaceAll('<', '&lt;') });
    vm.runInContext(`${source}
      openModal = options => { this.options = options; };
      closeModal = async () => true;
      refreshDirtySnapshot = () => { this.refreshed = true; };
      this.confirm = confirmModal;
    `, context);
    const seen = [];
    const pending = context.confirm('Switch templates?', { checkbox: { label: "Don't show <again>", checked: false, onChange: (value) => seen.push(value) } });
    assert.match(context.options.content, /Don\x27t show &lt;again>/);
    assert.doesNotMatch(context.options.content, /id="confirm-modal-checkbox" checked/);
    const controls = new Map();
    for (const id of ['checkbox', 'ok', 'cancel']) controls.set(`#confirm-modal-${id}`, {
      checked: false, listeners: {}, addEventListener(name, listener) { this.listeners[name] = listener; },
    });
    context.options.onSave({ querySelector: (selector) => controls.get(selector) });
    controls.get('#confirm-modal-checkbox').checked = true;
    controls.get('#confirm-modal-checkbox').listeners.change();
    assert.deepEqual(seen, [true]);
    assert.equal(context.refreshed, true, 'checkbox input is not an unsaved form requiring another confirmation');
    controls.get(accepted ? '#confirm-modal-ok' : '#confirm-modal-cancel').listeners.click();
    assert.equal(await pending, accepted);
  }
});
