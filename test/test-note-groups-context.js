import test from 'node:test';
import assert from 'node:assert/strict';
import { watchNoteChanges } from '../public/utils/note-live.js';
import { acceptAuthentication, invalidateAuthentication } from '../public/utils/device-context.js';

class Stream extends EventTarget {
  static instances = [];
  constructor(url) { super(); this.url = url; this.closed = false; Stream.instances.push(this); }
  close() { this.closed = true; }
  emit(type) { this.dispatchEvent(new Event(type)); }
}
function setup() {
  globalThis.window = new EventTarget(); globalThis.document = new EventTarget();
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
  globalThis.EventSource = Stream; Stream.instances = [];
  acceptAuthentication({ authContext: `human-${Math.random()}` });
}

test('a changed authentication generation closes the old group invalidation stream', () => {
  setup(); let refreshes = 0; const stop = watchNoteChanges(() => { refreshes++; });
  const stream = Stream.instances.at(-1);
  try {
    stream.emit('change'); assert.equal(refreshes, 1);
    acceptAuthentication({ authContext: 'returned-device-context' });
    assert.equal(stream.closed, true);
    for (const event of ['change', 'open', 'error']) stream.emit(event);
    window.dispatchEvent(new Event('focus'));
    assert.equal(refreshes, 1, 'late stream events cannot request old private board data');
  } finally { stop(); }
});
test('context rejection clears the watcher even before shell teardown completes', () => {
  setup(); let refreshes = 0; const stop = watchNoteChanges(() => { refreshes++; });
  const stream = Stream.instances.at(-1);
  try {
    window.dispatchEvent(new Event('auth:context-rejected'));
    assert.equal(stream.closed, true); stream.emit('change');
    assert.equal(refreshes, 0);
  } finally { stop(); }
});
test('invalidating authentication without an event suppresses pending notifications', () => {
  setup(); let refreshes = 0; const stop = watchNoteChanges(() => { refreshes++; });
  try {
    invalidateAuthentication(); Stream.instances.at(-1).emit('change');
    assert.equal(refreshes, 0);
  } finally { stop(); }
});
test('payload-free notifications refresh, teardown detaches every resume path', () => {
  setup(); let refreshes = 0; const stop = watchNoteChanges(() => { refreshes++; });
  const stream = Stream.instances.at(-1); stream.emit('open'); stream.emit('change');
  assert.equal(refreshes, 2); stop();
  for (const type of ['focus', 'online']) window.dispatchEvent(new Event(type));
  document.dispatchEvent(new Event('visibilitychange')); stream.emit('change');
  assert.equal(refreshes, 2); assert.equal(Stream.instances.length, 1); assert.equal(stream.closed, true);
});
