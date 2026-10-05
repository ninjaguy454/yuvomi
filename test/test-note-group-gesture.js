import test from 'node:test';
import assert from 'node:assert/strict';

const { createNoteGroupGesture } = await import('../public/utils/note-group-gesture.js').catch(() => ({}));

function fakeClock() {
  let now = 0, nextId = 1;
  const timers = new Map();
  return {
    setTimeout(callback, delay) { const id = nextId++; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout(id) { timers.delete(id); },
    tick(ms) {
      const until = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].callback();
      }
      now = until;
    },
    get pending() { return timers.size; },
  };
}

function fixture(selected = [2, 5, 7, 9], hooks = {}) {
  assert.equal(typeof createNoteGroupGesture, 'function', 'group gesture controller exists');
  const clock = fakeClock(), previews = [], drops = [], exits = [], cancels = [], captured = new Set();
  let target = { kind: 'overview', group_id: 10, before_note_id: 3, valid: true };
  const host = { setPointerCapture(id) { captured.add(id); }, hasPointerCapture(id) { return captured.has(id); }, releasePointerCapture(id) { captured.delete(id); } };
  const seed = { selected_ids: selected, source_group_id: 10, can_manage: true, expected: { groups: [{ id: 10, revision: 4 }], notes: [{ id: 2, revision: 1, layout_revision: 2 }] } };
  const event = (overrides = {}) => ({ pointerId: 6, pointerType: 'touch', isPrimary: true, button: 0, clientX: 100, clientY: 120, currentTarget: host, preventDefault() {}, ...overrides });
  const gesture = createNoteGroupGesture({ clock, hitTest: () => target, clientToWorld: (x, y) => ({ x: x / 2, y: y / 4 }), onPreview: preview => { previews.push(preview); hooks.onPreview?.(preview, { gesture, event, seed }); }, onExit: session => exits.push(session), onDrop: (session, dropTarget) => drops.push({ session, target: dropTarget }), onCancel: (reason, session) => cancels.push({ reason, session }) });
  return { gesture, clock, previews, drops, exits, cancels, captured, seed, event, target(value) { target = value; }, start() { gesture.pointerDown(event(), seed); clock.tick(250); } };
}

test('hold starts at 250ms within eight CSS pixels and freezes the drag snapshot', () => {
  const f = fixture(); f.gesture.pointerDown(f.event(), f.seed); f.clock.tick(249);
  assert.equal(f.previews.at(-1).state, 'holding'); assert.equal(f.captured.size, 0);
  f.gesture.pointerMove(f.event({ clientX: 108 })); f.clock.tick(1);
  assert.equal(f.previews.at(-1).state, 'dragging'); assert.ok(f.captured.has(6));
  const session = f.previews.at(-1).session;
  assert.deepEqual(session.selected_ids, [2, 5, 7, 9]); assert.ok(Object.isFrozen(session.selected_ids));
  assert.ok(Object.isFrozen(session.expected.notes[0]));
  f.seed.selected_ids.reverse(); f.seed.expected.groups[0].revision = 999;
  f.gesture.pointerMove(f.event({ clientX: 120, clientY: 160 }));
  assert.deepEqual(f.previews.at(-1).session.selected_ids, [2, 5, 7, 9]);
  assert.equal(f.previews.at(-1).session.expected.groups[0].revision, 4);
  assert.equal(f.previews.at(-1).session.worldX, 60); assert.equal(f.previews.at(-1).session.worldY, 40);
  assert.equal(session.clientX, 108, 'subsequent movement does not mutate published sessions');
  f.gesture.dispose();
});

test('early movement beyond eight pixels permits native scroll with no capture or drop', () => {
  const f = fixture(); let prevented = 0;
  f.gesture.pointerDown(f.event(), f.seed);
  f.gesture.pointerMove(f.event({ clientX: 109, preventDefault() { prevented++; } }));
  f.clock.tick(2000); f.gesture.pointerUp(f.event());
  assert.equal(prevented, 0); assert.equal(f.captured.size, 0); assert.equal(f.drops.length, 0);
  assert.equal(f.clock.pending, 0); assert.equal(f.cancels[0].reason, 'scroll');
});

test('a tap before the hold never submits and does not become a released drag', () => {
  const f = fixture(); f.gesture.pointerDown(f.event(), f.seed); f.clock.tick(249);
  assert.equal(f.gesture.pointerUp(f.event()), false); f.clock.tick(1000);
  assert.equal(f.drops.length, 0); assert.equal(f.clock.pending, 0);
});

test('target hover activates at 400ms and movement within the same target keeps the timer', () => {
  const f = fixture(); f.start(); f.target({ kind: 'group', id: 12, valid: true });
  f.gesture.pointerMove(f.event()); f.clock.tick(399);
  assert.notEqual(f.previews.at(-1).state, 'destination-overview');
  f.gesture.pointerMove(f.event({ clientX: 105 })); f.clock.tick(1);
  assert.equal(f.previews.at(-1).state, 'destination-overview'); assert.equal(f.previews.at(-1).target.id, 12);
  assert.equal(f.drops.length, 0); f.gesture.dispose();
});

test('leaving a hover target cancels its timer and a new target gets a full dwell', () => {
  const f = fixture(); f.start(); f.target({ kind: 'group', id: 12, valid: true }); f.gesture.pointerMove(f.event());
  f.clock.tick(399); f.target({ kind: 'group', id: 13, valid: true }); f.gesture.pointerMove(f.event());
  f.clock.tick(399); assert.notEqual(f.previews.at(-1).state, 'destination-overview');
  f.clock.tick(1); assert.equal(f.previews.at(-1).target.id, 13); f.gesture.dispose();
});

for (const kind of ['note', 'group']) {
  for (const dwell of [0, 100, 399, 400]) test(`overview ${kind} drop requires its completed 400ms hover (${dwell}ms)`, () => {
    const f = fixture([2]); f.start(); f.target({ kind: 'exit' }); f.gesture.pointerMove(f.event()); f.clock.tick(1000);
    f.target({ kind, id: 12, valid: true }); f.gesture.pointerMove(f.event()); f.clock.tick(dwell);
    f.gesture.pointerUp(f.event());
    assert.equal(f.drops.length, dwell === 400 ? 1 : 0);
    assert.equal(f.captured.size, 0); assert.equal(f.clock.pending, 0);
  });
  test(`overview ${kind} drop cannot switch to an unarmed target at release`, () => {
    const f = fixture([2]); f.start(); f.target({ kind: 'exit' }); f.gesture.pointerMove(f.event()); f.clock.tick(1000);
    f.target({ kind, id: 12, valid: true }); f.gesture.pointerMove(f.event()); f.clock.tick(400);
    f.target({ kind, id: 13, valid: true }); f.gesture.pointerUp(f.event());
    assert.equal(f.drops.length, 0); assert.equal(f.captured.size, 0); assert.equal(f.clock.pending, 0);
  });
}

test('exit dwell keeps the pointer and ordered selection alive at exactly 1000ms without writing', () => {
  const f = fixture(); f.start(); f.target({ kind: 'exit' }); f.gesture.pointerMove(f.event());
  f.clock.tick(999); assert.equal(f.exits.length, 0); assert.equal(f.previews.at(-1).state, 'exit-dwell');
  f.clock.tick(1); assert.equal(f.exits.length, 1); assert.equal(f.previews.at(-1).state, 'canvas-drag');
  assert.equal(f.exits[0].pointerId, 6); assert.deepEqual(f.exits[0].selected_ids, [2, 5, 7, 9]);
  assert.ok(f.captured.has(6)); assert.equal(f.drops.length, 0);
  f.target({ kind: 'canvas', valid: true }); f.gesture.pointerMove(f.event({ clientX: 400, clientY: 600 }));
  assert.equal(f.gesture.pointerUp(f.event({ clientX: 400, clientY: 600 })), true);
  assert.equal(f.drops.length, 1); assert.equal(f.previews.at(-1).state, 'placement-choice');
  assert.deepEqual([f.drops[0].session.worldX, f.drops[0].session.worldY], [200, 150]);
  assert.equal(f.captured.size, 0); assert.equal(f.clock.pending, 0);
});

test('leaving the exit zone requires a new continuous one second dwell', () => {
  const f = fixture(); f.start(); f.target({ kind: 'exit' }); f.gesture.pointerMove(f.event()); f.clock.tick(999);
  f.target({ kind: 'overview', valid: true }); f.gesture.pointerMove(f.event()); f.clock.tick(1);
  assert.equal(f.exits.length, 0); f.target({ kind: 'exit' }); f.gesture.pointerMove(f.event());
  f.clock.tick(999); assert.equal(f.exits.length, 0); f.clock.tick(1); assert.equal(f.exits.length, 1); f.gesture.dispose();
});

for (const reason of ['pointercancel', 'lostpointercapture', 'viewport-resize', 'authentication', 'access', 'stale']) {
  test(`${reason} during exit dwell releases capture, clears all timers and submits nothing`, () => {
    const f = fixture(); f.start(); f.target({ kind: 'exit' }); f.gesture.pointerMove(f.event()); f.clock.tick(999);
    f.gesture.pointerCancel(reason); f.clock.tick(5000); f.gesture.pointerUp(f.event());
    assert.equal(f.exits.length, 0); assert.equal(f.drops.length, 0); assert.equal(f.clock.pending, 0);
    assert.equal(f.captured.size, 0); assert.equal(f.cancels.at(-1).reason, reason);
  });
}

test('a second touch cancels the original continuous drag and cannot replace its selection', () => {
  const f = fixture(); f.start(); f.target({ kind: 'exit' }); f.gesture.pointerMove(f.event()); f.clock.tick(999);
  f.gesture.pointerDown(f.event({ pointerId: 7, isPrimary: false }), { ...f.seed, selected_ids: [1] });
  f.clock.tick(5000); f.gesture.pointerUp(f.event()); f.gesture.pointerUp(f.event({ pointerId: 7 }));
  assert.equal(f.cancels.at(-1).reason, 'second-pointer'); assert.equal(f.exits.length, 0);
  assert.equal(f.drops.length, 0); assert.equal(f.captured.size, 0); assert.equal(f.clock.pending, 0);
});

test('foreign pointer move and up cannot drop the captured selection', () => {
  const f = fixture(); f.start(); f.gesture.pointerMove(f.event({ pointerId: 8, clientX: 999 }));
  f.gesture.pointerUp(f.event({ pointerId: 8 })); assert.equal(f.drops.length, 0); assert.ok(f.captured.has(6));
  f.gesture.pointerUp(f.event()); assert.equal(f.drops.length, 1); assert.equal(f.drops[0].session.clientX, 100);
});

test('invalid and self-selected drop targets cancel without submitting', () => {
  for (const target of [null, { kind: 'exit' }, { kind: 'note', id: 5, valid: true }, { kind: 'group', id: 12, valid: false }, { kind: 'overview', group_id: 10, before_note_id: 7, valid: true }]) {
    const f = fixture(); f.start(); f.target(target); f.gesture.pointerUp(f.event());
    assert.equal(f.drops.length, 0); assert.equal(f.captured.size, 0); assert.equal(f.clock.pending, 0);
  }
});

test('browse-only sources do not start gestures; hidden member locks do not block explicit extraction', () => {
  const f = fixture(); f.gesture.pointerDown(f.event(), { ...f.seed, can_manage: false }); f.clock.tick(1000);
  assert.equal(f.previews.length, 0); assert.equal(f.captured.size, 0);
  f.gesture.pointerDown(f.event(), { ...f.seed, position_locked: true }); f.clock.tick(250);
  assert.equal(f.previews.at(-1).state, 'dragging'); f.gesture.dispose();
});

test('single valid drop submits only once and duplicate pointerup is inert', () => {
  const f = fixture([2]); f.start(); assert.equal(f.drops.length, 0);
  f.gesture.pointerUp(f.event()); f.gesture.pointerUp(f.event()); f.clock.tick(5000);
  assert.equal(f.drops.length, 1); assert.equal(f.previews.at(-1).state, 'submitting'); assert.equal(f.clock.pending, 0);
});

test('dispose is permanent, idempotent and cancels queued callbacks', () => {
  const f = fixture(); f.start(); f.target({ kind: 'group', id: 12, valid: true }); f.gesture.pointerMove(f.event());
  f.gesture.dispose(); f.gesture.dispose(); const length = f.previews.length;
  f.clock.tick(5000); f.gesture.pointerDown(f.event(), f.seed); f.clock.tick(1000);
  assert.equal(f.previews.length, length); assert.equal(f.captured.size, 0); assert.equal(f.drops.length, 0);
  assert.equal(f.clock.pending, 0); assert.equal(f.cancels.length, 1);
});

test('authentication cancellation during the final preview vetoes the pending drop', () => {
  const f = fixture([2], { onPreview(preview, { gesture }) { if (preview.state === 'submitting') gesture.pointerCancel('authentication'); } });
  f.start(); f.gesture.pointerUp(f.event());
  assert.equal(f.drops.length, 0); assert.equal(f.clock.pending, 0); assert.equal(f.captured.size, 0);
});

for (const replacementId of [6, 7]) test(`exit preview cannot hand off a replacement gesture using pointer ${replacementId}`, () => {
  let replaced = false;
  const f = fixture([2], { onPreview(preview, { gesture, event, seed }) {
    if (preview.state !== 'canvas-drag' || replaced) return;
    replaced = true; gesture.pointerCancel('access'); gesture.pointerDown(event({ pointerId: replacementId }), { ...seed, selected_ids: [9] });
  } });
  f.start(); f.target({ kind: 'exit' }); f.gesture.pointerMove(f.event()); f.clock.tick(1000);
  assert.equal(f.exits.length, 0, 'cancelled lifecycle cannot publish the replacement session');
  f.gesture.dispose(); assert.equal(f.clock.pending, 0);
});

test('a cancelled established drag consumes its eventual pointer release', () => {
  const f = fixture(); f.start(); f.gesture.pointerCancel('lostpointercapture');
  assert.equal(f.gesture.pointerUp(f.event()), true, 'cancelled drag release cannot activate a note');
  assert.equal(f.drops.length, 0);
  f.gesture.pointerDown(f.event(), f.seed); f.clock.tick(100);
  assert.equal(f.gesture.pointerUp(f.event()), false, 'a later ordinary tap with the reused pointer ID remains a tap');
});

test('cancellation during a holding preview cannot arm another lifecycle hold timer', () => {
  let replaced = false;
  const f = fixture([2], { onPreview(preview, { gesture, event, seed }) {
    if (preview.state !== 'holding' || replaced) return;
    replaced = true; gesture.pointerCancel('stale'); gesture.pointerDown(event({ pointerId: 7 }), seed);
  } });
  f.gesture.pointerDown(f.event(), f.seed);
  assert.equal(f.clock.pending, 1, 'only the replacement gesture owns a hold timer'); f.gesture.dispose(); assert.equal(f.clock.pending, 0);
});

test('a hovered destination overview can exit again with the same continuous selection', () => {
  const f = fixture(); f.start(); f.target({ kind: 'exit' }); f.gesture.pointerMove(f.event()); f.clock.tick(1000);
  f.target({ kind: 'group', id: 12, valid: true }); f.gesture.pointerMove(f.event()); f.clock.tick(400);
  assert.equal(f.previews.at(-1).state, 'destination-overview');
  f.target({ kind: 'exit' }); f.gesture.pointerMove(f.event()); f.clock.tick(999);
  assert.equal(f.exits.length, 1); f.clock.tick(1); assert.equal(f.exits.length, 2);
  assert.equal(f.exits[1].pointerId, 6); assert.deepEqual(f.exits[1].selected_ids, [2,5,7,9]); assert.equal(f.drops.length, 0);
  f.gesture.dispose();
});
