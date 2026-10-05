/** Local pointer arbitration only. Callbacks own presentation and intentional submission. */
export function createNoteGroupGesture({
  clock = globalThis, hitTest, clientToWorld,
  onPreview = () => {}, onExit = () => {}, onDrop = () => {}, onCancel = () => {},
}) {
  let disposed = false, session = null, state = 'idle', origin = null, captureHost = null;
  let holdTimer = null, hoverTimer = null, exitTimer = null, target = null, hoverKey = null;
  let onCanvas = false, hoverActive = false;
  let generation = 0;
  const consumedPointers = new Set();

  function clearTimer(name) {
    const timer = name === 'hold' ? holdTimer : name === 'hover' ? hoverTimer : exitTimer;
    if (timer !== null) clock.clearTimeout(timer);
    if (name === 'hold') holdTimer = null;
    else if (name === 'hover') hoverTimer = null;
    else exitTimer = null;
  }
  function clearTimers() { clearTimer('hold'); clearTimer('hover'); clearTimer('exit'); }
  function preview(nextState) {
    state = nextState;
    onPreview({ state, session, target });
  }
  function release(host, pointerId) {
    try {
      if (host?.hasPointerCapture?.(pointerId)) host.releasePointerCapture(pointerId);
    } catch { /* A detached host or cancelled browser pointer already released capture. */ }
  }
  function reset() {
    const previous = session, host = captureHost;
    generation++;
    clearTimers(); session = null; captureHost = null; target = null; hoverKey = null;
    origin = null; onCanvas = false; hoverActive = false; state = 'idle';
    if (previous) release(host, previous.pointerId);
    return previous;
  }
  function cancel(reason) {
    // A consumer may cancel synchronously from the final preview, after capture
    // has been released. That still invalidates the pending onDrop callback.
    generation++;
    if (!session) return false;
    const previous = reset();
    onCancel(reason, previous);
    return true;
  }
  function updateCoordinates(event) {
    const { clientX, clientY } = event;
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return false;
    const world = clientToWorld(clientX, clientY);
    if (!world || !Number.isFinite(world.x) || !Number.isFinite(world.y)) return false;
    session = Object.freeze({ ...session, clientX, clientY, worldX: world.x, worldY: world.y });
    return true;
  }
  function validTarget(value) {
    return value?.valid === true && ['overview', 'group', 'note', 'canvas'].includes(value.kind)
      && !(value.kind === 'note' && session.selected_ids.includes(value.id))
      && !(value.kind === 'overview' && value.group_id === session.source_group_id
        && session.selected_ids.includes(value.before_note_id));
  }
  function visitTarget() {
    const currentGeneration = generation;
    const found = hitTest(session) || null;
    if (generation !== currentGeneration || !session) return;
    target = found;
    if (target?.kind === 'exit' && !onCanvas) {
      clearTimer('hover'); hoverKey = null; hoverActive = false;
      if (exitTimer === null) {
        const exitGeneration = generation;
        exitTimer = clock.setTimeout(() => {
          exitTimer = null;
          if (!session || generation !== exitGeneration || state !== 'exit-dwell') return;
          onCanvas = true;
          const exitingSession = session;
          preview('canvas-drag');
          if (session && generation === exitGeneration) onExit(exitingSession);
        }, 1000);
      }
      preview('exit-dwell');
      return;
    }
    clearTimer('exit');
    const nextKey = validTarget(target) && ['group', 'note'].includes(target.kind) ? `${target.kind}:${target.id}` : null;
    if (nextKey !== hoverKey) {
      clearTimer('hover'); hoverKey = nextKey; hoverActive = false;
      if (nextKey) {
        const hoverGeneration = generation;
        hoverTimer = clock.setTimeout(() => {
          hoverTimer = null;
          if (!session || generation !== hoverGeneration || hoverKey !== nextKey) return;
          hoverActive = true;
          if (target.kind === 'group') onCanvas = false;
          preview(target.kind === 'group' ? 'destination-overview' : 'target-ready');
        }, 400);
      }
    }
    preview(hoverActive ? (target.kind === 'group' ? 'destination-overview' : 'target-ready') : onCanvas ? 'canvas-drag' : 'dragging');
  }
  function pointerDown(event, seed) {
    if (disposed) return false;
    if (session) {
      if (event.pointerId !== session.pointerId) cancel('second-pointer');
      return false;
    }
    if (!seed || seed.can_manage === false || event.isPrimary === false || (event.button != null && event.button !== 0)
      || !Number.isInteger(event.pointerId) || !Array.isArray(seed.selected_ids) || !seed.selected_ids.length) return false;
    const selected = [...new Set(seed.selected_ids)];
    if (selected.some(id => !Number.isSafeInteger(id) || id <= 0) || selected.length > 500) return false;
    const currentGeneration = ++generation;
    consumedPointers.delete(event.pointerId);
    // Never retain caller-owned mutable revision or selection objects across a dwell.
    session = Object.freeze({
      pointerId: event.pointerId, selected_ids: Object.freeze(selected),
      source_group_id: seed.source_group_id ?? null, expected: deepFreeze(structuredClone(seed.expected || { groups: [], notes: [] })),
    });
    if (!updateCoordinates(event)) { reset(); return false; }
    captureHost = event.currentTarget;
    origin = { x: event.clientX, y: event.clientY };
    onCanvas = false; hoverActive = false;
    preview('holding');
    if (!session || generation !== currentGeneration) return false;
    holdTimer = clock.setTimeout(() => {
      holdTimer = null;
      if (!session || generation !== currentGeneration || state !== 'holding') return;
      try { captureHost?.setPointerCapture?.(session.pointerId); }
      catch { cancel('capture-failed'); return; }
      consumedPointers.add(session.pointerId);
      preview('dragging');
    }, 250);
    return false; // Native scrolling remains available until the hold completes.
  }
  function pointerMove(event) {
    if (disposed || !session || event.pointerId !== session.pointerId) return false;
    if (!updateCoordinates(event)) { cancel('coordinates'); return false; }
    if (state === 'holding') {
      if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 8) cancel('scroll');
      return false;
    }
    event.preventDefault?.();
    visitTarget();
    return true;
  }
  function pointerUp(event) {
    if (disposed || !session || event.pointerId !== session.pointerId) {
      const consumed = consumedPointers.delete(event.pointerId);
      if (consumed) event.preventDefault?.();
      return consumed;
    }
    if (state === 'holding') { reset(); return false; }
    event.preventDefault?.();
    if (!updateCoordinates(event)) { cancel('coordinates'); return true; }
    const currentGeneration = generation;
    const found = hitTest(session) || null;
    if (generation !== currentGeneration || !session) return true;
    target = found;
    if (!validTarget(target) || (target.kind === 'canvas' && !onCanvas)) { cancel('invalid-drop'); return true; }
    const finalState = target.kind === 'canvas' && session.selected_ids.length > 1 ? 'placement-choice' : 'submitting';
    const finalSession = session, finalTarget = target;
    reset();
    consumedPointers.delete(event.pointerId);
    const submissionGeneration = generation;
    // Release capture before notifying a consumer that may synchronously replace its DOM.
    state = finalState;
    onPreview({ state, session: finalSession, target: finalTarget });
    if (!disposed && generation === submissionGeneration) onDrop(finalSession, finalTarget);
    return true; // A completed or cancelled drag must never be interpreted as a tap.
  }
  function pointerCancel(reason = 'pointercancel') {
    if (typeof reason === 'object') {
      if (reason.pointerId != null && session && reason.pointerId !== session.pointerId) return false;
      reason = reason.type || 'pointercancel';
    }
    return cancel(reason);
  }
  function dispose() {
    if (disposed) return;
    disposed = true; cancel('dispose'); clearTimers();
  }
  return { pointerDown, pointerMove, pointerUp, pointerCancel, dispose };
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
