/** A visual-only lean: gentle at low speed, more pronounced during a brisk drag. */
export function advanceNoteDragTilt(previous, deltaX, elapsedMs) {
  const duration = Math.max(1, elapsedMs);
  const velocity = deltaX / duration, speed = Math.abs(velocity);
  const target = Math.sign(velocity) * Math.min(4, .75 * speed + 3.25 * speed * speed);
  return previous + (target - previous) * (1 - Math.exp(-duration / 60));
}
