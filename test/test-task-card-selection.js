import test from 'node:test';
import assert from 'node:assert/strict';
import { bindTaskCardSelection, TASK_SELECTION_HOLD_MS } from '../public/utils/task-card-selection.js';

class Element {
  constructor(tag = 'div', classes = [], parent = null, dataset = {}) {
    this.tag = tag; this.parentElement = parent; this.dataset = dataset;
    this.classes = new Set(classes); this.classList = { contains: name => this.classes.has(name) };
    this.listeners = new Map(); this.isConnected = true; this.disabled = false;
  }
  matches(selector) {
    return selector.split(',').some(part => {
      const query = part.trim();
      if (query.includes('[contenteditable]')) return !!this.editable;
      if (query.startsWith('[role=')) return false;
      if ((query.match(/^[a-z]+/) || [])[0] && this.tag !== query.match(/^[a-z]+/)[0]) return false;
      if ([...query.matchAll(/\.([\w-]+)/g)].some(([, name]) => !this.classes.has(name))) return false;
      return ![...query.matchAll(/\[data-([\w-]+)(?:="([^"]+)")?\]/g)].some(([, name, value]) => {
        const key = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        return this.dataset[key] === undefined || value !== undefined && this.dataset[key] !== value;
      });
    });
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  contains(element) { return element === this || !!element?.parentElement && this.contains(element.parentElement); }
  addEventListener(type, handler) { this.listeners.set(type, [...(this.listeners.get(type) || []), handler]); }
  removeEventListener(type, handler) { this.listeners.set(type, (this.listeners.get(type) || []).filter(value => value !== handler)); }
  emit(type, props = {}) {
    const event = { target: this, pointerId: 1, pointerType: 'touch', button: 0, clientX: 100, clientY: 100,
      defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; },
      stopImmediatePropagation() { this.stopped = true; }, stopPropagation() { this.stopped = true; }, ...props };
    for (const handler of this.listeners.get(type) || []) { handler(event); if (event.stopped) break; }
    return event;
  }
  listenerCount() { return [...this.listeners.values()].reduce((sum, list) => sum + list.length, 0); }
}

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  const doc = new Element(); doc.defaultView = new Element();
  const root = new Element('main', [], doc); root.ownerDocument = doc;
  const row = new Element('div', ['swipe-row'], root);
  const card = new Element('article', ['task-card', 'activity-card'], row, { taskId: '72' });
  const title = new Element('button', ['activity-card__open'], card, { action: 'open-task', id: '72' });
  const titleText = new Element('span', [], title);
  const body = new Element('p', [], card);
  const selected = []; let allowed = true;
  const dispose = bindTaskCardSelection(root, { canSelect: () => allowed, onSelect: value => selected.push(value) });
  t.after(dispose);
  return { doc, root, card, title, titleText, body, selected, dispose, tick: ms => t.mock.timers.tick(ms),
    down: (target = titleText, props = {}) => doc.emit('pointerdown', { target, ...props }),
    up: () => doc.emit('pointerup', { target: titleText }),
    move: props => doc.emit('pointermove', { target: titleText, ...props }),
    disallow: () => { allowed = false; }, allow: () => { allowed = true; } };
}

for (const pointerType of ['mouse', 'touch', 'pen']) {
  test(`${pointerType} stationary one-second hold selects once and consumes only its resulting click`, t => {
    const f = fixture(t);
    assert.equal(f.down(f.titleText, { pointerType }).defaultPrevented, false);
    f.tick(TASK_SELECTION_HOLD_MS - 1); assert.equal(f.selected.length, 0);
    f.tick(1); assert.deepEqual(f.selected, [f.card]);
    f.tick(3000); assert.equal(f.selected.length, 1); f.up();
    assert.equal(f.root.emit('click', { target: f.titleText }).defaultPrevented, true);
    assert.equal(f.root.emit('click', { target: f.titleText }).defaultPrevented, false);
  });
}

test('ordinary click and tiny tap movement keep the normal detail action', t => {
  const f = fixture(t); f.down(); f.tick(100); f.move({ clientX: 103, clientY: 102 }); f.up(); f.tick(1000);
  assert.equal(f.selected.length, 0);
  assert.equal(f.root.emit('click', { target: f.titleText }).defaultPrevented, false);
});
test('plain card body is a valid hold surface', t => {
  const f = fixture(t); f.down(f.body); f.tick(1000); assert.deepEqual(f.selected, [f.card]);
});
for (const [label, x, y] of [['8px threshold', 108, 100], ['vertical flick', 102, 300], ['horizontal swipe', 250, 102]]) {
  test(`${label} permanently cancels the hold without preventing scrolling`, t => {
    const f = fixture(t); f.down(); f.tick(200);
    assert.equal(f.move({ clientX: x, clientY: y }).defaultPrevented, false);
    f.move({ clientX: 100, clientY: 100 }); f.tick(2000); f.up();
    assert.equal(f.selected.length, 0);
  });
}
for (const [label, tag, classes, dataset] of [
  ['checkbox', 'input', [], { taskId: '72' }], ['label', 'label', [], {}],
  ['status button', 'button', [], { action: 'toggle-status', id: '72' }],
  ['expand button', 'button', [], { action: 'toggle-activity-details', id: '72' }],
  ['link', 'a', [], {}], ['child title', 'button', ['subtask-item__title'], { action: 'open-task', id: '73' }],
  ['child body', 'div', ['subtask-item'], { subtaskId: '73' }], ['editor', 'textarea', [], {}],
]) {
  test(`${label} remains independent of bulk selection`, t => {
    const f = fixture(t); const control = new Element(tag, classes, f.card, dataset);
    f.down(control); f.tick(1001); f.up();
    assert.equal(f.selected.length, 0); assert.equal(f.root.emit('click', { target: control }).defaultPrevented, false);
  });
}
test('editable content and Kanban cards never arm List selection', t => {
  const f = fixture(t); f.body.editable = true; f.down(f.body); f.tick(1001); f.up();
  f.card.classes.add('kanban-card'); f.down(); f.tick(1001); assert.equal(f.selected.length, 0);
});
test('right click and non-primary pointers do not select', t => {
  const f = fixture(t); f.down(f.title, { button: 2 }); f.tick(1001); f.up();
  f.down(f.title, { isPrimary: false }); f.tick(1001); assert.equal(f.selected.length, 0);
});
test('a second contact cancels the pending hold until all contacts end', t => {
  const f = fixture(t); f.down(); f.tick(500); f.down(f.body, { pointerId: 2, isPrimary: false });
  f.tick(2000); assert.equal(f.selected.length, 0); f.up();
  f.doc.emit('pointerup', { pointerId: 2 }); f.down(); f.tick(1000); assert.equal(f.selected.length, 1);
});
for (const signal of ['scroll', 'pointercancel', 'blur', 'visibilitychange', 'pagehide']) {
  test(`${signal} cancels pending selection`, t => {
    const f = fixture(t); f.down(); f.tick(500);
    if (signal === 'visibilitychange') f.doc.hidden = true;
    (['blur', 'pagehide'].includes(signal) ? f.doc.defaultView : f.doc).emit(signal);
    f.tick(1001); assert.equal(f.selected.length, 0);
  });
}
test('a removed card or changed permission cannot be selected by an old timer', t => {
  const f = fixture(t); f.down(); f.disallow(); f.tick(1001); assert.equal(f.selected.length, 0);
  f.up(); f.allow(); f.down(); f.card.parentElement = null; f.tick(1001); assert.equal(f.selected.length, 0);
});
test('a contact during active scrolling does not arm, but a later settled hold can', t => {
  const f = fixture(t); f.doc.emit('scroll'); f.down(); f.tick(1200); f.up();
  assert.equal(f.selected.length, 0);
  f.down(); f.tick(1000); assert.deepEqual(f.selected, [f.card]);
});
test('Shift+Space on the primary title selects once; other shortcuts and controls retain behavior', t => {
  const f = fixture(t);
  assert.equal(f.root.emit('keydown', { target: f.title, key: ' ', shiftKey: true }).defaultPrevented, true);
  f.root.emit('keydown', { target: f.title, key: ' ', shiftKey: true, repeat: true });
  assert.deepEqual(f.selected, [f.card]);
  assert.equal(f.root.emit('keydown', { target: f.title, key: ' ', shiftKey: false }).defaultPrevented, false);
  assert.equal(f.root.emit('keydown', { target: f.body, key: ' ', shiftKey: true }).defaultPrevented, false);
});
test('selected touch hold cannot also reach legacy swipe mutation listeners', t => {
  const f = fixture(t); f.down(); f.tick(1000);
  f.move({ clientX: 250, clientY: 100 });
  const move = f.doc.emit('touchmove', { target: f.body });
  assert.equal(move.stopped, true); assert.equal(move.defaultPrevented, false);
  f.doc.emit('touchend', { target: f.body });
  assert.equal(f.doc.emit('touchmove', { target: f.body }).stopped, false);
});
test('a new tap after selection is not suppressed', t => {
  const f = fixture(t); f.down(); f.tick(1000); f.up();
  f.down(); f.up(); assert.equal(f.root.emit('click', { target: f.title }).defaultPrevented, false);
});
test('a scroll restoration after selection does not let a late release open details', t => {
  const f = fixture(t); f.down(); f.tick(1000);
  f.doc.emit('scroll'); f.tick(3000); f.up();
  assert.equal(f.root.emit('click', { target: f.title }).defaultPrevented, true);
  assert.deepEqual(f.selected, [f.card]);
});
test('dispose cancels timers and unregisters every delegated listener', t => {
  const f = fixture(t); f.down(); f.dispose(); f.dispose(); f.tick(1500);
  assert.equal(f.selected.length, 0);
  assert.equal(f.root.listenerCount() + f.doc.listenerCount() + f.doc.defaultView.listenerCount(), 0);
});
