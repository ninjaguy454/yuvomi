const DRAG_DISTANCE = 8;
const LONG_PRESS_MS = 500;
const MAX_FRAME_MS = 32;
const isId = value => Number.isSafeInteger(value) && value > 0;

/**
 * Arbitrate one avatar gesture without reading profiles or changing a draft.
 *
 * pointerDown(event, { userId, anchor }) accepts only a currently valid candidate.
 * pointerUp returns true when its generated click must be suppressed by the caller;
 * a short tap returns false. pointerCancel() also cancels keyboard/session exits.
 * onDrag receives a session snapshot, or null when the ghost must be removed.
 * onFrame may scroll the host; hit testing runs again immediately afterwards.
 * The caller supplies current authentication/helper/frozen-draft validity and a
 * checked onAssign callback. This controller never makes an API request.
 */
export function createTaskAvatarGesture({
  clock,
  host,
  isValid,
  hitTest,
  onAssign,
  onPerson,
  onDrag = () => {},
  onFrame = () => {},
}) {
  const time = clock || {
    now: () => performance.now(),
    setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimeout: id => globalThis.clearTimeout(id),
    requestAnimationFrame: callback => globalThis.requestAnimationFrame(callback),
    cancelAnimationFrame: id => globalThis.cancelAnimationFrame(id),
  };
  const document = host.ownerDocument || host;
  let current = null;
  let timer = null;
  let frame = null;
  let lastFrameAt = 0;
  let consumedPointerId = null;
  let disposed = false;

  function valid(session) {
    return !disposed && host.isConnected !== false && session.anchor?.isConnected !== false
      // Capture loss can precede its event. Only a live session owns capture;
      // startup checks and assignment checks after intentional release do not.
      && (current !== session || !host.hasPointerCapture || host.hasPointerCapture(session.pointerId))
      && isId(session.userId) && isValid(session.userId);
  }

  function position(event) {
    return Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY);
  }

  function stopWork() {
    if (timer !== null) time.clearTimeout(timer);
    if (frame !== null) time.cancelAnimationFrame(frame);
    timer = null;
    frame = null;
  }

  function finish(consume = true) {
    const session = current;
    if (!session) return false;
    current = null;
    stopWork();
    if (consume) consumedPointerId = session.pointerId;
    // Clear ownership before releasing: lostpointercapture may fire synchronously.
    try {
      if (!host.hasPointerCapture || host.hasPointerCapture(session.pointerId)) {
        host.releasePointerCapture(session.pointerId);
      }
    } catch {
      // A detached host may already have lost capture; local work still stops.
    }
    if (session.state === 'dragging') onDrag(null);
    return true;
  }

  function target(session) {
    const childId = hitTest(session.x, session.y, session.userId);
    return isId(childId) ? childId : null;
  }

  function draw(session) {
    session.childId = target(session);
    if (current === session) onDrag({ ...session });
  }

  function tick() {
    frame = null;
    const session = current;
    if (!session) return;
    if (!valid(session)) {
      finish();
      return;
    }
    const now = time.now();
    const elapsedMs = Math.max(0, Math.min(MAX_FRAME_MS, now - lastFrameAt));
    lastFrameAt = now;
    if (session.state === 'dragging') {
      onFrame({ ...session }, elapsedMs);
      if (current !== session) return;
      if (!valid(session)) {
        finish();
        return;
      }
      draw(session);
    }
    if (current === session && session.state !== 'person') {
      frame = time.requestAnimationFrame(tick);
    }
  }

  function pointerDown(event, candidate) {
    if (disposed) return false;
    if (current) {
      if (event?.pointerId !== current.pointerId) finish();
      return false;
    }
    if (!candidate?.anchor || !isId(candidate.userId) || !position(event)
        || !Number.isFinite(event.pointerId) || event.isPrimary === false
        || (event.button != null && event.button !== 0)) return false;
    const session = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      userId: candidate.userId,
      anchor: candidate.anchor,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      state: 'pressing',
      childId: null,
    };
    if (!valid(session)) return false;
    try {
      host.setPointerCapture(session.pointerId);
    } catch {
      return false;
    }
    current = session;
    consumedPointerId = null;
    lastFrameAt = time.now();
    timer = time.setTimeout(() => {
      timer = null;
      if (current !== session || session.state !== 'pressing') return;
      if (!valid(session)) {
        finish();
        return;
      }
      session.state = 'person';
      stopWork();
      onPerson(session.userId, session.anchor);
    }, LONG_PRESS_MS);
    frame = time.requestAnimationFrame(tick);
    return true;
  }

  function pointerMove(event) {
    const session = current;
    if (!session || event?.pointerId !== session.pointerId) return false;
    if (!valid(session) || !position(event)) {
      finish();
      return true;
    }
    session.x = event.clientX;
    session.y = event.clientY;
    if (session.state === 'pressing'
        && Math.hypot(session.x - session.startX, session.y - session.startY) >= DRAG_DISTANCE) {
      session.state = 'dragging';
      if (timer !== null) time.clearTimeout(timer);
      timer = null;
    }
    if (session.state === 'pressing') return false;
    event.preventDefault?.();
    if (session.state === 'dragging') draw(session);
    return true;
  }

  function pointerUp(event) {
    const session = current;
    if (!session || event?.pointerId !== session.pointerId) {
      if (event?.pointerId !== consumedPointerId) return false;
      consumedPointerId = null;
      event.preventDefault?.();
      return true;
    }
    if (!valid(session) || !position(event)) {
      finish();
      consumedPointerId = null;
      event.preventDefault?.();
      return true;
    }
    session.x = event.clientX;
    session.y = event.clientY;
    const consumed = session.state !== 'pressing';
    const childId = session.state === 'dragging' ? target(session) : null;
    if (consumed) event.preventDefault?.();
    finish(consumed);
    consumedPointerId = null;
    // Hit testing and cleanup may themselves invalidate the current candidate.
    if (childId !== null && valid(session)) onAssign(childId, session.userId);
    return consumed;
  }

  function pointerCancel(event) {
    if (!current || (event?.pointerId != null && event.pointerId !== current.pointerId)) return false;
    event?.preventDefault?.();
    return finish();
  }

  function secondPointer(event) {
    if (current && event.pointerId !== current.pointerId) finish();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    finish();
    stopWork();
    host.removeEventListener('lostpointercapture', pointerCancel);
    document.removeEventListener('pointerdown', secondPointer, true);
  }

  host.addEventListener('lostpointercapture', pointerCancel);
  document.addEventListener('pointerdown', secondPointer, true);
  return { pointerDown, pointerMove, pointerUp, pointerCancel, dispose };
}
