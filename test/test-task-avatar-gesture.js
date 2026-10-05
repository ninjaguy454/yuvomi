import test from 'node:test';
import assert from 'node:assert/strict';

const gestureModule = await import('../public/utils/task-avatar-gesture.js').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});

function fakeClock() {
  let time = 0;
  let nextId = 1;
  const queued = new Map();
  function schedule(callback, delay, type) {
    const id = nextId++;
    queued.set(id, { callback, at: time + delay, type });
    return id;
  }
  return {
    now: () => time,
    setTimeout: (callback, delay) => schedule(callback, delay, 'timer'),
    clearTimeout: id => queued.delete(id),
    requestAnimationFrame: callback => schedule(callback, 16, 'frame'),
    cancelAnimationFrame: id => queued.delete(id),
    advance(milliseconds) {
      const until = time + milliseconds;
      while (true) {
        const entry = [...queued].filter(([, value]) => value.at <= until)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!entry) break;
        const [id, value] = entry;
        queued.delete(id);
        time = value.at;
        value.callback(time);
      }
      time = until;
    },
    frameAfter(milliseconds) {
      time += milliseconds;
      for (const [id, value] of [...queued]) {
        if (value.type !== 'frame') continue;
        queued.delete(id);
        value.callback(time);
      }
    },
    get pending() { return queued.size; },
  };
}

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(name, handler) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(handler);
    },
    removeEventListener(name, handler) { listeners.get(name)?.delete(handler); },
    emit(name, event) { for (const handler of [...(listeners.get(name) || [])]) handler(event); },
    get listenerCount() { return [...listeners.values()].reduce((count, values) => count + values.size, 0); },
  };
}

function pointer(overrides = {}) {
  return {
    pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0,
    clientX: 20, clientY: 30, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }, ...overrides,
  };
}

function harness(options = {}) {
  assert.equal(typeof gestureModule.createTaskAvatarGesture, 'function', 'gesture controller is exported');
  const clock = fakeClock();
  const document = eventTarget();
  const host = Object.assign(eventTarget(), {
    isConnected: true,
    ownerDocument: document,
    capture: null,
    setPointerCapture(id) { this.capture = id; },
    hasPointerCapture(id) { return this.capture === id; },
    releasePointerCapture(id) {
      if (this.capture !== id) return;
      this.capture = null;
      this.emit('lostpointercapture', { pointerId: id });
    },
  });
  const anchor = { isConnected: true };
  const state = { valid: true, selected: new Set([1, 2]), childId: 10 };
  const assignments = [];
  const people = [];
  const drags = [];
  const frames = [];
  const controller = gestureModule.createTaskAvatarGesture({
    clock, host,
    isValid: userId => state.valid && state.selected.has(userId),
    hitTest: (_x, _y, userId) => state.selected.has(userId) ? state.childId : null,
    onAssign: (childId, userId) => assignments.push([childId, userId]),
    onPerson: (userId, personAnchor) => people.push([userId, personAnchor]),
    onDrag: session => drags.push(session && { ...session }),
    onFrame: (session, elapsedMs) => frames.push({ ...session, elapsedMs }),
    ...options,
  });
  return { clock, host, document, anchor, state, controller, assignments, people, drags, frames,
    down: event => controller.pointerDown(event || pointer(), { userId: 2, anchor }),
    move: overrides => controller.pointerMove(pointer(overrides)),
    up: overrides => controller.pointerUp(pointer(overrides)),
  };
}

test('tap before 500ms opens no card and assigns no child', () => {
  const h = harness();
  assert.equal(h.down(), true);
  assert.equal(h.host.capture, 7);
  h.clock.advance(499);
  assert.deepEqual(h.assignments, []);
  assert.deepEqual(h.people, []);
  assert.equal(h.up(), false);
  assert.equal(h.host.capture, null);
  assert.equal(h.clock.pending, 0);
  h.clock.advance(1000);
  assert.deepEqual(h.people, []);
});

test('exactly 8 CSS pixels starts dragging and cancels long press', () => {
  const h = harness();
  h.down();
  h.move({ clientX: 27.999 });
  assert.equal(h.drags.filter(Boolean).length, 0);
  h.move({ clientX: 28 });
  assert.equal(h.drags.at(-1).state, 'dragging');
  assert.equal(h.drags.at(-1).childId, 10);
  h.clock.advance(700);
  assert.deepEqual(h.people, []);
  assert.equal(h.up({ clientX: 28 }), true);
  assert.deepEqual(h.assignments, [[10, 2]]);
  assert.equal(h.clock.pending, 0);
  assert.equal(h.drags.at(-1), null);
});

test('drag threshold uses total Euclidean distance in CSS pixels', () => {
  const h = harness();
  h.down();
  h.move({ clientX: 25, clientY: 35 });
  assert.equal(h.drags.filter(Boolean).length, 0);
  h.move({ clientX: 26, clientY: 36 });
  assert.equal(h.drags.at(-1).state, 'dragging');
  h.up({ clientX: 26, clientY: 36 });
  assert.deepEqual(h.assignments, [[10, 2]]);
});

test('500ms long press opens the card once and suppresses subsequent drop and click', () => {
  const h = harness();
  h.down();
  h.clock.advance(499);
  assert.deepEqual(h.people, []);
  h.clock.advance(1);
  assert.deepEqual(h.people, [[2, h.anchor]]);
  assert.equal(h.clock.pending, 0);
  h.clock.advance(1000);
  h.move({ clientX: 100 });
  const up = pointer({ clientX: 100 });
  assert.equal(h.controller.pointerUp(up), true);
  assert.equal(up.defaultPrevented, true);
  h.controller.pointerUp(up);
  assert.equal(h.people.length, 1);
  assert.deepEqual(h.assignments, []);
});

test('completed drag assigns exactly once using the release hit test', () => {
  const positions = [];
  const h = harness({ hitTest: (x, y, userId) => {
    positions.push([x, y, userId]);
    return y >= 90 ? 11 : 10;
  } });
  h.down();
  h.move({ clientY: 38 });
  h.up({ clientY: 90 });
  h.up({ clientY: 90 });
  assert.deepEqual(h.assignments, [[11, 2]]);
  assert.deepEqual(positions.at(-1), [20, 90, 2]);
  assert.deepEqual(h.people, []);
});

for (const childId of [null, undefined, '10', 0, -1, 1.5, NaN, Infinity]) {
  test(`invalid or protected drop target (${String(childId)}) creates no assignment`, () => {
    const h = harness();
    h.down();
    h.move({ clientX: 28 });
    h.state.childId = childId;
    h.up({ clientX: 28 });
    assert.deepEqual(h.assignments, []);
    assert.equal(h.clock.pending, 0);
  });
}

for (const cancel of ['pointercancel', 'lostpointercapture', 'secondtouch', 'sessionend', 'dispose']) {
  for (const dragging of [false, true]) {
    test(`${cancel} during ${dragging ? 'drag' : 'press'} cancels without assignment`, () => {
      const h = harness();
      h.down();
      if (dragging) h.move({ clientX: 28 });
      if (cancel === 'pointercancel') h.controller.pointerCancel(pointer());
      if (cancel === 'lostpointercapture') h.host.emit('lostpointercapture', { pointerId: 7 });
      if (cancel === 'secondtouch') h.controller.pointerDown(pointer({ pointerId: 8, isPrimary: false }), { userId: 1, anchor: h.anchor });
      if (cancel === 'sessionend') h.controller.pointerCancel();
      if (cancel === 'dispose') h.controller.dispose();
      assert.equal(h.clock.pending, 0);
      h.clock.advance(1000);
      h.up({ clientX: 100 });
      assert.deepEqual(h.assignments, []);
      assert.deepEqual(h.people, []);
      assert.equal(h.host.capture, null);
      if (dragging) assert.equal(h.drags.at(-1), null);
    });
  }
}

test('a second touch elsewhere in the document cancels the captured gesture', () => {
  const h = harness();
  h.down();
  h.move({ clientY: 38 });
  h.document.emit('pointerdown', pointer({ pointerId: 8, isPrimary: false }));
  h.up({ clientY: 90 });
  assert.deepEqual(h.assignments, []);
  assert.equal(h.clock.pending, 0);
});

for (const dragging of [false, true]) {
  test(`released capture during ${dragging ? 'drag' : 'press'} stops work before lostpointercapture is delivered`, () => {
    const h = harness();
    h.down();
    if (dragging) h.move({ clientX: 28 });
    h.clock.advance(16);
    const previousFrames = h.frames.length;
    // Browsers may defer lostpointercapture until a subsequent pointer event.
    h.host.releasePointerCapture = id => { if (h.host.capture === id) h.host.capture = null; };
    h.host.releasePointerCapture(7);
    h.clock.advance(16);
    assert.equal(h.frames.length, previousFrames, 'released capture must not scroll another frame');
    assert.equal(h.clock.pending, 0, 'released capture must stop all timers and frames');
    h.clock.advance(1000);
    h.up({ clientX: 28 });
    assert.deepEqual(h.assignments, []);
    assert.deepEqual(h.people, []);
    if (dragging) assert.equal(h.drags.at(-1), null);
  });
}

test('released capture prevents a drop before the next frame or lostpointercapture event', () => {
  const h = harness();
  h.down();
  h.move({ clientX: 28 });
  h.host.capture = null;
  h.up({ clientX: 28 });
  assert.deepEqual(h.assignments, []);
  assert.equal(h.clock.pending, 0);
});

test('released capture prevents a long press before the next frame or lostpointercapture event', () => {
  const h = harness();
  h.down();
  h.clock.advance(499);
  h.host.capture = null;
  h.clock.advance(1);
  assert.deepEqual(h.people, []);
  assert.equal(h.clock.pending, 0);
});

for (const invalidation of ['authentication', 'helper', 'host', 'anchor']) {
  for (const dragging of [false, true]) {
    test(`${invalidation} invalidation during ${dragging ? 'drag' : 'press'} cancels on the next frame`, () => {
      const h = harness();
      h.down();
      if (dragging) h.move({ clientX: 28 });
      if (invalidation === 'authentication') h.state.valid = false;
      if (invalidation === 'helper') h.state.selected.delete(2);
      if (invalidation === 'host') h.host.isConnected = false;
      if (invalidation === 'anchor') h.anchor.isConnected = false;
      h.clock.advance(16);
      assert.equal(h.clock.pending, 0);
      h.state.valid = true;
      h.state.selected.add(2);
      h.up({ clientX: 28 });
      assert.deepEqual(h.assignments, []);
      assert.deepEqual(h.people, []);
    });
  }
}

test('validity is checked again on release before any pending frame', () => {
  const h = harness();
  h.down();
  h.move({ clientX: 28 });
  h.state.valid = false;
  h.up({ clientX: 28 });
  assert.deepEqual(h.assignments, []);
});

test('pending long press rechecks candidate validity before opening the card', () => {
  const h = harness();
  h.down();
  h.clock.advance(499);
  h.state.selected.delete(2);
  h.clock.advance(1);
  assert.deepEqual(h.people, []);
  assert.equal(h.clock.pending, 0);
});

test('only selected numeric candidate IDs and primary left-button pointers can start', () => {
  const h = harness();
  for (const userId of [3, '2', 0, -2, NaN]) {
    assert.equal(h.controller.pointerDown(pointer(), { userId, anchor: h.anchor }), false);
  }
  assert.equal(h.down(pointer({ button: 2 })), false);
  assert.equal(h.down(pointer({ isPrimary: false })), false);
  assert.equal(h.down(pointer({ clientX: NaN })), false);
  assert.equal(h.clock.pending, 0);
  assert.equal(h.host.capture, null);
});

test('non-integer candidate IDs are rejected independently of caller validity', () => {
  const h = harness({ isValid: () => true });
  for (const userId of ['2', 0, -2, 1.5, NaN, Infinity]) {
    assert.equal(h.controller.pointerDown(pointer(), { userId, anchor: h.anchor }), false);
  }
  assert.equal(h.clock.pending, 0);
});

test('unrelated pointers cannot move, release, or cancel the active gesture', () => {
  const h = harness();
  h.down();
  h.move({ pointerId: 8, clientX: 100 });
  h.up({ pointerId: 8, clientX: 100 });
  h.controller.pointerCancel(pointer({ pointerId: 8 }));
  h.host.emit('lostpointercapture', { pointerId: 8 });
  h.clock.advance(500);
  assert.deepEqual(h.people, [[2, h.anchor]]);
  h.up();
});

test('frames allow edge scrolling then re-hit-test the stationary pointer', () => {
  let childId = 10;
  const h = harness({
    hitTest: () => childId,
    onFrame: (_session, elapsedMs) => {
      assert.ok(elapsedMs > 0 && elapsedMs <= 32);
      childId = 11;
    },
  });
  h.down();
  h.move({ clientY: 38 });
  assert.equal(h.drags.at(-1).childId, 10);
  h.clock.advance(16);
  assert.equal(h.drags.at(-1).childId, 11);
  h.clock.frameAfter(1000);
  h.up({ clientY: 38 });
  assert.deepEqual(h.assignments, [[11, 2]]);
});

test('dispose removes listeners, timers, frames, capture, and future interactions', () => {
  const h = harness();
  h.down();
  h.move({ clientX: 28 });
  assert.ok(h.clock.pending > 0);
  h.controller.dispose();
  h.controller.dispose();
  assert.equal(h.clock.pending, 0);
  assert.equal(h.host.listenerCount, 0);
  assert.equal(h.document.listenerCount, 0);
  assert.equal(h.host.capture, null);
  assert.equal(h.down(), false);
  h.clock.advance(1000);
  h.up({ clientX: 28 });
  assert.deepEqual(h.assignments, []);
  assert.deepEqual(h.people, []);
});

test('capture failure leaves no live gesture or scheduled work', () => {
  const h = harness();
  h.host.setPointerCapture = () => { throw new Error('detached capture host'); };
  assert.equal(h.down(), false);
  assert.equal(h.clock.pending, 0);
  h.clock.advance(500);
  h.up({ clientX: 28 });
  assert.deepEqual(h.people, []);
  assert.deepEqual(h.assignments, []);
});
