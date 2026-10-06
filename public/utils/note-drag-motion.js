/** A visual-only lean: horizontal pixels/ms, with a gentle cap and smooth decay. */
export function advanceNoteDragTilt(previous, deltaX, elapsedMs) {
  const duration = Math.max(1, elapsedMs);
  const target = Math.max(-.9, Math.min(.9, deltaX / duration * .75));
  return previous + (target - previous) * (1 - Math.exp(-duration / 60));
}
