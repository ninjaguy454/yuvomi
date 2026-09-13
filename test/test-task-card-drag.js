import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bindTaskCardTouchDrag, taskDragHandle, TASK_DRAG_HOLD_MS, TASK_DRAG_SCROLL_SETTLE_MS,
} from '../public/utils/task-card-drag.js';

class Element {
  constructor(selectors = [], parent = null) {
    this.selectors = new Set(selectors);
    this.parentElement = parent;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.isConnected = true;
    this.disabled = false;
    const classes = new Set();
    this.classList = { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) };
    parent?.children.push(this);
  }
  closest(selector) {
    if (this.selectors.has(selector)) return this;
    return this.parentElement?.closest(selector) ?? null;
  }
  contains(element) {
    return this === element || this.children.some(child => child.contains(element));
  }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [
      ...(selector === '[id]' ? child.attributes.has('id') : selector.startsWith('.')
        ? child.classList.contains(selector.slice(1)) : child.selectors.has(selector)) ? [child] : [],
      ...child.querySelectorAll(selector),
    ]);
  }
  getBoundingClientRect() { return { left: 40, top: 120, width: 270, height: 110 }; }
  cloneNode() {
    const clone = new Element();
    clone.setAttribute('id', 'card');
    new Element([], clone).setAttribute('id', 'subtask');
    return clone;
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  appendChild(child) { child.parentElement = this; this.children.push(child); }
  remove() {
    this.isConnected = false;
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
  }
  addEventListener(name, handler, options) {
    const listeners = this.listeners.get(name) || [];
    listeners.push({ handler, options });
    this.listeners.set(name, listeners);
  }
  removeEventListener(name, handler) {
    this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item.handler !== handler));
  }
  async emit(name, event = {}) {
    const value = {
      target: this, cancelable: true, defaultPrevented: false, stopped: false,
      touches: [],
      preventDefault() { this.defaultPrevented = true; },
      stopImmediatePropagation() { this.stopped = true; },
      ...event,
    };
    for (const { handler } of this.listeners.get(name) || []) {
      await handler(value);
      if (value.stopped) break;
    }
    return value;
  }
  listenerCount() { return [...this.listeners.values()].reduce((total, list) => total + list.length, 0); }
}

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  const doc = new Element();
  doc.body = new Element();
  doc.defaultView = new Element();
  const board = new Element([], doc.body);
  board.ownerDocument = doc;
  const bucket = new Element(['[data-bucket-key]'], board);
  bucket.dataset.bucketKey = 'Eleanor';
  const card = new Element(['.kanban-card[data-task-id]'], bucket);
  card.dataset.taskId = '72';
  const handle = new Element(['[data-task-drag-handle]'], card);
  const handleIcon = new Element([], handle);
  const cardBody = new Element([], card);
  const zone = new Element(['[data-drop-zone]'], bucket);
  zone.dataset.dropZone = 'in_progress';
  doc.elementFromPoint = () => zone;
  const drops = [];
  const states = [];
  let allowed = true;
  const dispose = bindTaskCardTouchDrag(board, {
    canDrag: value => value === card && allowed,
    onDrop: result => { drops.push(result); },
    onDragStateChange: value => states.push(value),
  });
  t.after(dispose);
  const touch = (x, y, identifier = 7) => ({ identifier, clientX: x, clientY: y });
  const start = (target = handle) => board.emit('touchstart', { target, touches: [touch(50, 160)] });
  const move = (x, y, extra = {}) => board.emit('touchmove', { target: handle, touches: [touch(x, y)], ...extra });
  const end = () => board.emit('touchend', { target: handle, touches: [] });
  return { doc, board, card, handle, handleIcon, cardBody, zone, drops, states, dispose, start, move, end, touch,
    tick: ms => t.mock.timers.tick(ms), disallow: () => { allowed = false; } };
}

for (const [label, x, y] of [['vertical swipe', 53, 400], ['fast flick', 80, 710], ['horizontal board scroll', 260, 162]]) {
  test(`card body ${label} never arms drag or prevents native scrolling`, async t => {
    const f = fixture(t);
    const start = await f.start(f.cardBody);
    f.tick(1000);
    const move = await f.move(x, y);
    await f.end();
    assert.equal(start.defaultPrevented, false);
    assert.equal(move.defaultPrevented, false);
    assert.deepEqual(f.states, []);
    assert.deepEqual(f.drops, []);
  });
}

test('small tap movement does not drag, block scrolling or swallow a keyboard/tap action', async t => {
  const f = fixture(t);
  await f.start();
  f.tick(TASK_DRAG_HOLD_MS);
  const move = await f.move(53, 163);
  await f.end();
  const click = await f.board.emit('click', { target: f.handle });
  assert.equal(move.defaultPrevented, false);
  assert.equal(click.defaultPrevented, false);
  assert.deepEqual(f.states, []);
  assert.deepEqual(f.drops, []);
});

for (const [label, x, y] of [['vertical swipe', 52, 180], ['horizontal swipe', 70, 162], ['diagonal flick', 75, 230]]) {
  test(`handle ${label} before the hold cancels drag until the touch ends`, async t => {
    const f = fixture(t);
    await f.start();
    f.tick(TASK_DRAG_HOLD_MS - 1);
    assert.equal((await f.move(x, y)).defaultPrevented, false);
    f.tick(500);
    assert.equal((await f.move(300, 400)).defaultPrevented, false);
    await f.end();
    assert.deepEqual(f.states, []);
    assert.deepEqual(f.drops, []);
    assert.equal((await f.board.emit('click', { target: f.handle })).defaultPrevented, true, 'scroll must not open the status dialog');
  });
}

test('held handle moves deliberately, drops once, then cleans ghost/highlight and suppresses click', async t => {
  const f = fixture(t);
  assert.equal(taskDragHandle(f.handleIcon, f.board), f.handle);
  assert.equal((await f.start(f.handleIcon)).defaultPrevented, false);
  f.tick(TASK_DRAG_HOLD_MS);
  assert.equal(f.handle.classList.contains('task-card__drag-handle--ready'), true);
  assert.equal((await f.move(51, 180)).defaultPrevented, true);
  const ghost = f.doc.body.children.find(child => child.className === 'kanban-card kanban-card--ghost');
  assert.ok(ghost);
  assert.equal(ghost.attributes.get('aria-hidden'), 'true');
  assert.equal(ghost.attributes.has('inert'), true);
  assert.equal(ghost.attributes.has('id'), false);
  assert.equal(ghost.querySelectorAll('[id]').length, 0);
  await f.move(300, 250);
  await f.end();
  await f.end();
  assert.deepEqual(f.drops, [{ taskId: '72', sourceBucketKey: 'Eleanor', zone: f.zone }]);
  assert.deepEqual(f.states, [true, false]);
  assert.equal(f.doc.body.contains(ghost), false);
  assert.equal(f.zone.classList.contains('kanban-col__body--over'), false);
  assert.equal((await f.board.emit('click', { target: f.handle })).defaultPrevented, true);
  // A subsequent intentional tap remains available; there is no 800ms lockout.
  await f.start();
  await f.end();
  assert.equal((await f.board.emit('click', { target: f.handle })).defaultPrevented, false);
});

test('scroll cancels a pending hold and prevents activation during momentum', async t => {
  const f = fixture(t);
  await f.start();
  await f.doc.emit('scroll');
  f.tick(TASK_DRAG_HOLD_MS);
  assert.equal((await f.move(100, 200)).defaultPrevented, false);
  await f.end();
  await f.start();
  f.tick(TASK_DRAG_HOLD_MS);
  assert.equal((await f.move(100, 200)).defaultPrevented, false);
  assert.deepEqual(f.states, []);
  f.tick(TASK_DRAG_SCROLL_SETTLE_MS);
  await f.start();
  f.tick(TASK_DRAG_HOLD_MS);
  assert.equal((await f.move(100, 200)).defaultPrevented, true);
});

test('noncancelable browser-owned movement never becomes a drag after the hold', async t => {
  const f = fixture(t);
  await f.start();
  f.tick(TASK_DRAG_HOLD_MS);
  const move = await f.move(100, 200, { cancelable: false });
  await f.end();
  assert.equal(move.defaultPrevented, false);
  assert.deepEqual(f.drops, []);
  assert.deepEqual(f.states, []);
});

test('permission and detached-card checks apply at both activation and drop', async t => {
  const f = fixture(t);
  f.handle.disabled = true;
  assert.equal(taskDragHandle(f.handle, f.board), null);
  await f.start();
  f.tick(TASK_DRAG_HOLD_MS);
  assert.equal((await f.move(100, 200)).defaultPrevented, false);
  f.handle.disabled = false;
  await f.start();
  f.tick(TASK_DRAG_HOLD_MS);
  await f.move(100, 200);
  f.disallow();
  await f.end();
  assert.deepEqual(f.drops, []);
  assert.deepEqual(f.states, [true, false]);
});

test('live removal before activation cancels the gesture and cannot move a stale Task', async t => {
  const f = fixture(t);
  await f.start();
  f.card.remove();
  f.tick(TASK_DRAG_HOLD_MS);
  assert.equal((await f.move(100, 200)).defaultPrevented, false);
  await f.end();
  assert.deepEqual(f.drops, []);
});

for (const reason of ['touchcancel', 'scroll', 'Escape', 'hidden', 'blur', 'second touch']) {
  test(`${reason} cancels an active drag without invoking a mutation`, async t => {
    const f = fixture(t);
    await f.start();
    f.tick(TASK_DRAG_HOLD_MS);
    await f.move(100, 200);
    if (reason === 'scroll') await f.doc.emit('scroll');
    else if (reason === 'Escape') await f.doc.emit('keydown', { key: 'Escape' });
    else if (reason === 'hidden') { f.doc.hidden = true; await f.doc.emit('visibilitychange'); }
    else if (reason === 'blur') await f.doc.defaultView.emit('blur');
    else if (reason === 'second touch') await f.move(100, 200, { touches: [f.touch(100, 200), f.touch(140, 200, 8)] });
    else await f.board.emit(reason);
    await f.end();
    assert.deepEqual(f.states, [true, false]);
    assert.deepEqual(f.drops, []);
    assert.equal(f.board.classList.contains('kanban-board--dragging'), false);
    assert.equal(f.doc.body.children.length, 1);
  });
}

test('touch and native HTML drag cannot both own the same gesture; mouse path remains allowed', async t => {
  const f = fixture(t);
  assert.equal((await f.board.emit('dragstart', { target: f.handle })).defaultPrevented, false);
  await f.start();
  const native = await f.board.emit('dragstart', { target: f.handle });
  assert.equal(native.defaultPrevented, true);
  assert.equal(native.stopped, true);
  f.tick(TASK_DRAG_HOLD_MS);
  assert.equal((await f.board.emit('contextmenu', { target: f.handle })).defaultPrevented, true);
});

test('drop outside this board is ignored', async t => {
  const f = fixture(t);
  f.doc.elementFromPoint = () => new Element(['[data-drop-zone]']);
  await f.start();
  f.tick(TASK_DRAG_HOLD_MS);
  await f.move(100, 200);
  await f.end();
  assert.deepEqual(f.drops, []);
});

test('disposal removes every board/document/window listener, timer and ghost', async t => {
  const f = fixture(t);
  await f.start();
  f.tick(TASK_DRAG_HOLD_MS);
  await f.move(100, 200);
  f.dispose();
  f.dispose();
  assert.equal(f.board.listenerCount(), 0);
  assert.equal(f.doc.listenerCount(), 0);
  assert.equal(f.doc.defaultView.listenerCount(), 0);
  assert.equal(f.doc.body.children.length, 1);
  assert.deepEqual(f.states, [true, false]);
  assert.deepEqual(f.drops, []);
});
