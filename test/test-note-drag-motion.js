import test from 'node:test';
import assert from 'node:assert/strict';
const { advanceNoteDragTilt } = await import('../public/utils/note-drag-motion.js').catch(() => ({}));
const travel = (speed, frameMs, duration = 240, initial = 0) => {
  let tilt = initial;
  for (let elapsed = 0; elapsed < duration; elapsed += frameMs) tilt = advanceNoteDragTilt(tilt, speed * frameMs, frameMs);
  return tilt;
};

test('horizontal speed controls the magnitude and direction of the gentle lean', () => {
  const slow = travel(.1, 20), fast = travel(.9, 20), left = travel(-.9, 20);
  assert.ok(slow > 0 && fast > slow * 5);
  assert.ok(Math.abs(left + fast) < 1e-9);
  assert.ok(fast < .9);
});

test('the same motion has the same lean at different display frame rates', () => {
  assert.ok(Math.abs(travel(.7, 10) - travel(.7, 20)) < 1e-9);
});

test('extreme pointer speed stays capped and reversing direction crosses smoothly', () => {
  const right = travel(50, 20);
  assert.ok(right > .8 && right <= .9);
  const reversing = advanceNoteDragTilt(right, -1000, 20);
  assert.ok(reversing < right && reversing > 0);
  assert.ok(travel(-50, 20, 240, right) < -.8);
});

test('falling horizontal velocity and a stationary pointer settle without oscillation', () => {
  const moving = travel(.9, 20), slowing = advanceNoteDragTilt(moving, 2, 20);
  assert.ok(slowing > 0 && slowing < moving);
  const idle = advanceNoteDragTilt(slowing, 0, 20);
  assert.ok(idle > 0 && idle < slowing);
  assert.ok(travel(0, 20, 600, idle) < .0001);
});
