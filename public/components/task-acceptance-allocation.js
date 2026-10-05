import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { memberLabel, firstLastInitial } from '/utils/member-label.js';
import { sameAuthentication } from '/utils/device-context.js';
import { assignAcceptanceSubtask } from '/utils/task-acceptance-draft.js';
import { createTaskAvatarGesture } from '/utils/task-avatar-gesture.js';
import { attachOverlay, dropOverlay } from '/utils/overlay-history.js';
import { safeTaskPersonPhoto, taskPersonInitials } from '/components/task-person-card.js';

const protectedReasonCodes = new Set(['already_assigned', 'not_open', 'locked', 'protected_action', 'managed_assignment', 'not_available', 'helpers_not_allowed']);

function candidates(draft) {
  return new Map([...draft.projection.primary_candidates, ...draft.projection.coassignee_candidates].map(person => [Number(person.id), person]));
}
function participants(draft) {
  const people = candidates(draft);
  return [draft.primary, ...draft.helpers].map(id => people.get(Number(id))).filter(Boolean);
}
function avatar(person) {
  const photo = safeTaskPersonPhoto(person?.avatar_data);
  const element = document.createElement(photo ? 'img' : 'span');
  element.className = 'task-allocation__avatar'; element.setAttribute('aria-hidden', 'true');
  if (photo) { element.src = photo; element.alt = ''; }
  else {
    element.textContent = taskPersonInitials(person?.display_name || t('tasks.acceptMember'));
    const color = person?.avatar_color || person?.color;
    if (color && CSS.supports('color', color)) element.style.backgroundColor = color;
  }
  return element;
}

/** A nested, locally focused chooser. No assignment occurs on opening or dismissal. */
export function openAllocationPicker({ host, anchor, child, draft, onAssign, signal }) {
  let closed = false, overlayToken = null;
  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  const layer = document.createElement('div'); layer.className = 'task-allocation-picker-layer';
  const panel = document.createElement('section'); panel.className = 'task-allocation-picker';
  panel.dataset.acceptancePicker = ''; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.tabIndex = -1;
  panel.setAttribute('aria-label', t('tasks.acceptAssign', { title: child.title }));
  panel.insertAdjacentHTML('beforeend', `<div class="task-allocation-picker__heading"><strong>${esc(t('tasks.acceptAssign', { title: child.title }))}</strong><button type="button" class="btn btn--ghost" data-picker-close aria-label="${esc(t('common.close'))}">×</button></div><div class="task-allocation-picker__choices"></div>`);
  const choices = panel.querySelector('.task-allocation-picker__choices');
  const eligible = new Set(child.eligible_assignee_ids.map(Number));
  for (const person of [null, ...participants(draft).filter(person => eligible.has(Number(person.id)))]) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'task-allocation-picker__choice';
    button.dataset.acceptanceChoice = person ? String(person.id) : '';
    const label = person ? memberLabel(person, [], { format: firstLastInitial }) : t('tasks.acceptUnassigned');
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', String((draft.assignments[child.id] ?? null) === (person ? Number(person.id) : null)));
    if (person) button.append(avatar(person));
    const caption = document.createElement('span'); caption.textContent = label; button.append(caption);
    button.addEventListener('click', () => {
      if (draft.submission || signal?.aborted || closed) return;
      close(false); onAssign(Number(child.id), person ? Number(person.id) : null);
      if (anchor.isConnected && !anchor.disabled && !anchor.closest('[inert]')) anchor.focus({ preventScroll: true });
    }, options);
    choices.append(button);
  }
  layer.append(panel); host.append(layer); anchor.setAttribute('aria-expanded', 'true');
  function position() {
    if (closed || !anchor.isConnected || !host.isConnected) { close(false); return; }
    const bounds = layer.getBoundingClientRect(), source = anchor.getBoundingClientRect(), gap = 8;
    panel.style.maxHeight = `${Math.max(0, bounds.height - gap * 2)}px`;
    panel.style.width = `${Math.max(0, Math.min(320, bounds.width - gap * 2))}px`;
    const size = panel.getBoundingClientRect();
    const left = Math.min(Math.max(gap, source.right - bounds.left - size.width), Math.max(gap, bounds.width - size.width - gap));
    const below = source.bottom - bounds.top + gap;
    const top = Math.min(Math.max(gap, below + size.height <= bounds.height - gap ? below : source.top - bounds.top - size.height - gap), Math.max(gap, bounds.height - size.height - gap));
    panel.style.left = `${left}px`; panel.style.top = `${top}px`;
  }
  function close(restore = true) {
    if (closed) return;
    closed = true; listeners.abort(); signal?.removeEventListener('abort', abort);
    if (overlayToken !== null) { dropOverlay(overlayToken); overlayToken = null; }
    layer.remove(); anchor.setAttribute('aria-expanded', 'false');
    if (restore && !signal?.aborted && anchor.isConnected && !anchor.disabled && !anchor.closest('[inert]')) anchor.focus({ preventScroll: true });
  }
  const abort = () => close(false);
  panel.querySelector('[data-picker-close]').addEventListener('click', () => close(), options);
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); }
    if (event.key === 'Tab') {
      event.preventDefault(); event.stopImmediatePropagation();
      const buttons = [...panel.querySelectorAll('button:not(:disabled)')];
      const index = buttons.indexOf(document.activeElement);
      buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
    }
  }, options);
  // Capture outside actions before the acceptance controls can start a gesture
  // or advance a stage. The dismissing click belongs only to this layer.
  document.addEventListener('pointerdown', event => {
    if (!panel.contains(event.target)) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, { ...options, capture: true });
  document.addEventListener('click', event => {
    if (!panel.contains(event.target)) { event.preventDefault(); event.stopImmediatePropagation(); close(); }
  }, { ...options, capture: true });
  window.addEventListener('resize', position, options);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  else {
    overlayToken = attachOverlay(layer, ({ force }) => close(!force));
    position();
    const selected = choices.querySelector('[aria-pressed="true"]');
    selected?.focus({ preventScroll: true });
    if (selected && !closed) {
      // Reveal the selected person only within this scroll container. Native
      // scrollIntoView can also move the acceptance dialog behind the chooser.
      const bounds = panel.getBoundingClientRect(), choice = selected.getBoundingClientRect();
      if (choice.bottom > bounds.bottom) panel.scrollTop += choice.bottom - bounds.bottom + 8;
      else if (choice.top < bounds.top) panel.scrollTop -= bounds.top - choice.top + 8;
    }
  }
  return { close, dispose: () => close(false) };
}

/** Selected candidates and stationary step targets backed by the existing draft. */
export function mountAcceptanceAllocation(host, { draft, authentication, signal, onChange = () => {}, onPerson = () => {} }) {
  const listeners = new AbortController(), options = { signal: listeners.signal };
  const modalHost = host.closest('.modal-panel') || host;
  const body = host.closest('.modal-panel__body') || host;
  let disposed = false, picker = null, ghost = null, pointerOrigin = null, suppressClick = false;
  const valid = () => !disposed && !signal?.aborted && host.isConnected && !draft.submission && sameAuthentication(authentication);
  const selected = userId => participants(draft).some(person => Number(person.id) === Number(userId));
  const personById = userId => candidates(draft).get(Number(userId));
  function showPerson(userId, anchor) {
    if (!valid() || !selected(userId) || !anchor.isConnected) return;
    picker?.dispose(); picker = null;
    onPerson(personById(userId), anchor);
  }
  function assign(childId, userId) {
    if (!valid() || !assignAcceptanceSubtask(draft, childId, userId)) return false;
    refresh(); onChange(childId, userId);
    host.querySelector(`[data-acceptance-target="${Number(childId)}"]`)?.focus({ preventScroll: true });
    return true;
  }
  function dragFeedback(session) {
    host.querySelectorAll('[data-acceptance-target]').forEach(target => target.classList.toggle('task-allocation__target--active', !!session && Number(target.dataset.acceptanceTarget) === session.childId));
    if (!session) { ghost?.remove(); ghost = null; return; }
    if (!ghost) { ghost = document.createElement('div'); ghost.className = 'task-allocation__ghost'; ghost.setAttribute('aria-hidden', 'true'); ghost.append(avatar(personById(session.userId))); document.body.append(ghost); }
    // Offset only the visual feedback. Gesture hit testing and edge scrolling
    // continue to use the real pointer coordinates, including on release.
    const half = ghost.offsetWidth / 2, inset = half + 4;
    const visualY = session.y - (session.pointerType === 'touch' ? half + 12 : 0);
    ghost.style.left = `${Math.max(inset, Math.min(innerWidth - inset, session.x))}px`;
    ghost.style.top = `${Math.max(inset, Math.min(innerHeight - inset, visualY))}px`;
  }
  const gesture = createTaskAvatarGesture({
    host, isValid: userId => valid() && selected(userId),
    hitTest(x, y, userId) {
      const target = document.elementFromPoint(x, y)?.closest('[data-acceptance-target]');
      if (!target || target.disabled || !host.contains(target)) return null;
      const childId = Number(target.dataset.acceptanceTarget), child = draft.projection.subtasks.find(row => Number(row.id) === childId);
      return child?.allocatable && child.eligible_assignee_ids.map(Number).includes(userId) ? childId : null;
    },
    onAssign: assign, onPerson: showPerson, onDrag: dragFeedback,
    onFrame(session, elapsed) {
      const rect = body.getBoundingClientRect(), edge = 56;
      if (session.x < rect.left || session.x > rect.right || session.y < rect.top || session.y > rect.bottom) return;
      const strength = session.y < rect.top + edge ? -Math.min(1, (rect.top + edge - session.y) / edge)
        : session.y > rect.bottom - edge ? Math.min(1, (session.y - rect.bottom + edge) / edge) : 0;
      body.scrollTop += strength * Math.min(Math.max(elapsed, 0), 32) * 0.9;
    },
  });
  host.classList.add('task-allocation');
  host.insertAdjacentHTML('beforeend', `<section class="task-allocation__participants" aria-label="${esc(t('tasks.acceptParticipants'))}"><div class="task-allocation__strip" data-acceptance-strip></div></section><ol class="task-allocation__steps"></ol>`);
  const strip = host.querySelector('[data-acceptance-strip]'), rows = host.querySelector('.task-allocation__steps');
  for (const person of participants(draft)) {
    const item = document.createElement('div'); item.className = 'task-allocation__participant'; item.dataset.acceptanceParticipant = String(person.id);
    const name = memberLabel(person);
    item.insertAdjacentHTML('beforeend', `<button type="button" class="task-allocation__person" data-acceptance-person="${Number(person.id)}" aria-label="${esc(t('tasks.acceptViewPerson', { name }))}" aria-haspopup="dialog"></button><span class="task-allocation__name" title="${esc(name)}">${esc(name)}</span>`);
    item.querySelector('button').append(avatar(person)); strip.append(item);
  }
  for (const child of draft.projection.subtasks) {
    const row = document.createElement('li'); row.className = 'task-allocation__step'; row.dataset.acceptanceChild = String(child.id);
    row.insertAdjacentHTML('beforeend', `<span class="task-allocation__step-title">${esc(child.title)}${!child.allocatable ? `<small>${esc(t('tasks.acceptPreservedShort'))}</small>` : ''}</span><button type="button" class="task-allocation__target" data-acceptance-target="${Number(child.id)}" aria-haspopup="dialog" aria-expanded="false"></button>`);
    rows.append(row);
  }
  function refresh() {
    if (disposed) return;
    picker?.dispose(); picker = null;
    for (const child of draft.projection.subtasks) {
      const target = host.querySelector(`[data-acceptance-target="${Number(child.id)}"]`);
      if (!target) continue;
      const userId = draft.assignments[child.id] ?? null, person = userId == null ? null : personById(userId);
      const label = !child.allocatable ? t('tasks.acceptPreservedShort') : person ? memberLabel(person) : t('tasks.acceptUnassigned');
      const reason = !child.allocatable && child.reason && !protectedReasonCodes.has(child.reason) ? ` (${child.reason})` : '';
      target.disabled = !child.allocatable || !valid(); target.dataset.assignee = userId == null ? '' : String(userId);
      target.classList.toggle('task-allocation__target--empty', !person && !!child.allocatable);
      target.classList.toggle('task-allocation__target--protected', !child.allocatable);
      target.setAttribute('aria-label', t('tasks.acceptAssignedTo', { title: child.title, name: label }) + reason);
      target.title = target.getAttribute('aria-label');
      target.replaceChildren();
      if (!child.allocatable) target.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/></svg>');
      else if (person) target.append(avatar(person));
      else { const mark = document.createElement('span'); mark.setAttribute('aria-hidden', 'true'); mark.textContent = '?'; target.append(mark); }
    }
    host.querySelectorAll('[data-acceptance-person]').forEach(button => { button.disabled = !valid() || !selected(Number(button.dataset.acceptancePerson)); });
  }
  host.addEventListener('click', event => {
    if (!valid()) return;
    const source = event.target.closest('[data-acceptance-person]');
    if (source) { showPerson(Number(source.dataset.acceptancePerson), source); return; }
    const anchor = event.target.closest('[data-acceptance-target]');
    if (!anchor || anchor.disabled) return;
    const child = draft.projection.subtasks.find(row => Number(row.id) === Number(anchor.dataset.acceptanceTarget));
    picker?.dispose(); picker = openAllocationPicker({ host: modalHost, anchor, child, draft, onAssign: assign, signal: listeners.signal });
  }, options);
  // Capture-retargeted clicks can land on the host after pointerup. Consume
  // them before a just-opened person card interprets that click as outside.
  document.addEventListener('pointerdown', () => { suppressClick = false; }, { ...options, capture: true });
  document.addEventListener('click', event => {
    if (event.detail > 0 && suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); suppressClick = false; }
  }, { ...options, capture: true });
  host.addEventListener('contextmenu', event => {
    const source = event.target.closest('[data-acceptance-person]');
    if (!source) return;
    event.preventDefault(); gesture.pointerCancel(); suppressClick = true;
    showPerson(Number(source.dataset.acceptancePerson), source);
  }, options);
  host.addEventListener('pointerdown', event => {
    const anchor = event.target.closest('[data-acceptance-person]');
    if (!anchor || anchor.disabled || event.button !== 0) return;
    const userId = Number(anchor.dataset.acceptancePerson);
    if (gesture.pointerDown(event, { userId, anchor })) { pointerOrigin = { pointerId: event.pointerId, userId, anchor }; anchor.focus({ preventScroll: true }); }
  }, options);
  host.addEventListener('pointermove', event => gesture.pointerMove(event), { ...options, passive: false });
  host.addEventListener('pointerup', event => {
    const origin = pointerOrigin;
    const consumed = gesture.pointerUp(event);
    if (origin?.pointerId !== event.pointerId) return;
    pointerOrigin = null; suppressClick = true;
    if (!consumed) showPerson(origin.userId, origin.anchor);
  }, options);
  host.addEventListener('pointercancel', event => { gesture.pointerCancel(event); suppressClick = true; }, options);
  host.addEventListener('keydown', event => {
    if (event.key === 'Escape' && gesture.pointerCancel()) { event.preventDefault(); event.stopImmediatePropagation(); suppressClick = true; }
  }, options);
  function dispose() {
    if (disposed) return;
    disposed = true; gesture.dispose(); picker?.dispose(); picker = null; listeners.abort(); signal?.removeEventListener('abort', dispose); dragFeedback(null);
  }
  signal?.addEventListener('abort', dispose, { once: true });
  if (signal?.aborted) dispose(); else refresh();
  return { refresh, dispose };
}
