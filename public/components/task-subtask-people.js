import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { memberLabel } from '/utils/member-label.js';
import { authenticationSnapshot, sameAuthentication } from '/utils/device-context.js';
import { createTaskAvatarGesture } from '/utils/task-avatar-gesture.js';
import { openAllocationPicker } from '/components/task-acceptance-allocation.js';
import { openTaskPersonCard, safeTaskPersonPhoto, taskPersonInitials } from '/components/task-person-card.js';

function avatar(person) {
  const photo = safeTaskPersonPhoto(person?.avatar_data);
  const node = document.createElement(photo ? 'img' : 'span');
  node.className = 'task-allocation__avatar'; node.setAttribute('aria-hidden', 'true');
  const initials = taskPersonInitials(person?.display_name || t('tasks.acceptMember'));
  if (photo) { node.src = photo; node.alt = ''; node.onerror = () => node.replaceWith(avatar({ ...person, avatar_data: null })); }
  else {
    node.textContent = initials;
    const color = person?.avatar_color || person?.color;
    if (color && CSS.supports('color', color)) node.style.backgroundColor = color;
  }
  return node;
}

/** Adapt concrete Task draft fields to the bounty chooser and gesture controller. */
export function bindSubtaskPeople(editor, { users = [],groups=[] } = {}) {
  const pool = editor.querySelector('[data-task-subtask-people]');
  if (!pool) return null;
  const listeners = new AbortController(), options = { signal: listeners.signal };
  const authentication = authenticationSnapshot();
  const people = new Map(users.map(person => [Number(person.id), person]));
  const modalHost = editor.closest('.modal-panel') || editor;
  const scrollHost = editor.closest('.modal-panel__body') || document.scrollingElement;
  const keys = new WeakMap(); let nextKey = 1;
  let disposed = false, picker = null, personCard = null, ghost = null, suppressClick = false;
  const valid = () => !disposed && editor.isConnected && !editor.closest('[hidden], [inert]') && sameAuthentication(authentication);
  const rows = () => [...editor.querySelectorAll('[data-task-subtask-row]')];
  const key = row => { if (!keys.has(row)) keys.set(row, nextKey++); return keys.get(row); };
  const rowFor = id => rows().find(row => key(row) === Number(id));
  const selectFor = row => row?.querySelector('[data-task-subtask-assignee]');
  const enabled = row => valid() && !pool.hidden && !!selectFor(row) && !selectFor(row).disabled
    && !row.querySelector('[data-task-subtask-assignment]').hidden;
  const eligible = row => {
    const ids = row.dataset.eligibleAssigneeIds;
    return ids ? JSON.parse(ids).map(Number).filter(id => people.has(id)) : [...people.keys()];
  };
  function assign(id, userId) {
    const row = rowFor(id), select = selectFor(row);
    if (!row || !enabled(row) || (userId !== null && !eligible(row).includes(Number(userId)))) return false;
    const value = userId === null ? '' : String(userId);
    if (select.value !== value) {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if(userId!==null){const group=row.querySelector('[data-task-subtask-group]');if(group&&group.value){group.value='';group.dispatchEvent(new Event('change',{bubbles:true}));}}
    refresh(); row.querySelector('[data-task-subtask-target]').focus({ preventScroll: true });
    return true;
  }
  function assignGroup(id,groupId){
    const row=rowFor(id),control=row?.querySelector('[data-task-subtask-group]');
    if(!row||!enabled(row)||!control||!groups.some(group=>Number(group.id)===groupId))return false;
    control.value=String(groupId);control.dispatchEvent(new Event('change',{bubbles:true}));
    row.querySelector('[data-task-subtask-group-behavior]').open=true;
    refresh();row.querySelector('[data-task-subtask-group-start]').focus({preventScroll:true});return true;
  }
  function showPerson(id, anchor) {
    if (!valid() || pool.hidden || anchor.disabled || !people.has(id)) return;
    picker?.dispose(); personCard?.dispose();
    personCard = openTaskPersonCard({ person: people.get(id), anchor, host: modalHost, signal: listeners.signal });
  }
  function feedback(session) {
    editor.querySelectorAll('[data-task-subtask-target]').forEach(target => {
      target.classList.toggle('task-allocation__target--active', !!session && Number(target.dataset.taskSubtaskTarget) === session.childId);
    });
    if (!session) { ghost?.remove(); ghost = null; return; }
    if (!ghost) {
      ghost = document.createElement('div'); ghost.className = 'task-allocation__ghost'; ghost.setAttribute('aria-hidden', 'true');
      ghost.append(avatar(people.get(session.userId))); document.body.append(ghost);
    }
    const half = ghost.offsetWidth / 2, inset = half + 4;
    const visualY = session.y - (session.pointerType === 'touch' ? half + 12 : 0);
    ghost.style.left = `${Math.max(inset, Math.min(innerWidth - inset, session.x))}px`;
    ghost.style.top = `${Math.max(inset, Math.min(innerHeight - inset, visualY))}px`;
  }
  const gesture = createTaskAvatarGesture({ host: editor,
    isValid: id => valid() && !pool.hidden && people.has(id) && rows().some(row => enabled(row) && eligible(row).includes(id)),
    hitTest(x, y, id) {
      const row = document.elementFromPoint(x, y)?.closest('[data-task-subtask-row]');
      return row && editor.contains(row) && enabled(row) && eligible(row).includes(id) ? key(row) : null;
    },
    onAssign: assign, onPerson: showPerson, onDrag: feedback,
    onFrame(session, elapsed) {
      const bounds = scrollHost === document.scrollingElement ? { left: 0, right: innerWidth, top: 0, bottom: innerHeight } : scrollHost.getBoundingClientRect();
      if (session.x < bounds.left || session.x > bounds.right || session.y < bounds.top || session.y > bounds.bottom) return;
      const edge = 56;
      const strength = session.y < bounds.top + edge ? -Math.min(1, (bounds.top + edge - session.y) / edge)
        : session.y > bounds.bottom - edge ? Math.min(1, (session.y - bounds.bottom + edge) / edge) : 0;
      scrollHost.scrollTop += strength * Math.min(Math.max(elapsed, 0), 32) * 0.9;
    },
  });
  for (const person of people.values()) {
    const item = document.createElement('div'); item.className = 'task-allocation__participant';
    const label = memberLabel(person, users);
    item.insertAdjacentHTML('beforeend', `<button type="button" class="task-allocation__person" data-task-subtask-person="${Number(person.id)}" aria-label="${esc(t('tasks.acceptViewPerson', { name: label }))}" aria-haspopup="dialog"></button><span class="task-allocation__name" title="${esc(label)}">${esc(label)}</span>`);
    item.querySelector('button').append(avatar(person)); pool.querySelector('.task-allocation__strip').append(item);
  }
  function refresh() {
    if (disposed) return;
    picker?.dispose(); picker = null;
    const available = rows().some(row => enabled(row));
    pool.querySelectorAll('[data-task-subtask-person]').forEach(button => {
      button.disabled = !available || !rows().some(row => enabled(row) && eligible(row).includes(Number(button.dataset.taskSubtaskPerson)));
    });
    for (const row of rows()) {
      const target = row.querySelector('[data-task-subtask-target]'), select = selectFor(row);
      if (!target || !select) continue;
      const userId = Number(select.value) || null, person = people.get(userId);
      const group=groups.find(item=>Number(item.id)===Number(row.querySelector('[data-task-subtask-group]')?.value));
      const name = group?.name|| (person ? memberLabel(person, users) : userId ? t('tasks.acceptMember') : t('tasks.acceptUnassigned'));
      const title = row.querySelector('[data-task-subtask-title]').value;
      target.dataset.taskSubtaskTarget = String(key(row)); target.dataset.assignee = userId === null ? '' : String(userId);
      target.disabled = !enabled(row);
      target.classList.toggle('task-allocation__target--empty', userId === null);
      target.setAttribute('aria-label', t('tasks.acceptAssignedTo', { title, name }));
      target.title = target.getAttribute('aria-label'); target.replaceChildren();
      if(group){target.innerHTML='<span class="task-allocation__avatar" aria-hidden="true"><i data-lucide="users-round"></i></span>';window.lucide?.createIcons({el:target});}
      else if (person) target.append(avatar(person));
      else { const mark = document.createElement('span'); mark.textContent = '?'; mark.setAttribute('aria-hidden', 'true'); target.append(mark); }
    }
    if (!available) { gesture.pointerCancel(); personCard?.dispose(); }
  }
  editor.addEventListener('click', event => {
    if (!valid()) return;
    const source = event.target.closest('[data-task-subtask-person]');
    if (source) { showPerson(Number(source.dataset.taskSubtaskPerson), source); return; }
    const anchor = event.target.closest('[data-task-subtask-target]'), row = anchor?.closest('[data-task-subtask-row]');
    if (!anchor || !enabled(row)) return;
    if(row.querySelector('[data-task-subtask-group]')?.value){const behavior=row.querySelector('[data-task-subtask-group-behavior]');behavior.open=true;behavior.querySelector('[data-task-subtask-group-start]').focus({preventScroll:true});return;}
    const id = key(row), selected = Number(selectFor(row).value) || null;
    const child = { id, title: row.querySelector('[data-task-subtask-title]').value, eligible_assignee_ids: eligible(row) };
    // The shared chooser uses this small local adapter only; no acceptance write occurs.
    const draft = { primary: null, helpers: [...people.keys()], assignments: { [id]: selected },
      projection: { primary_candidates: [], coassignee_candidates: [...people.values()] } };
    picker?.dispose(); personCard?.dispose();
    picker = openAllocationPicker({ host: modalHost, anchor, child, draft, onAssign: assign,groups,
      selectedGroupId:Number(row.querySelector('[data-task-subtask-group]')?.value)||null,onAssignGroup:assignGroup, signal: listeners.signal });
  }, options);
  document.addEventListener('pointerdown', () => { suppressClick = false; }, { ...options, capture: true });
  document.addEventListener('click', event => {
    if (event.detail > 0 && suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); suppressClick = false; }
  }, { ...options, capture: true });
  editor.addEventListener('pointerdown', event => {
    const anchor = event.target.closest('[data-task-subtask-person]');
    if (!anchor || anchor.disabled || event.button !== 0) return;
    if (gesture.pointerDown(event, { userId: Number(anchor.dataset.taskSubtaskPerson), anchor })) anchor.focus({ preventScroll: true });
  }, options);
  editor.addEventListener('pointermove', event => gesture.pointerMove(event), { ...options, passive: false });
  editor.addEventListener('pointerup', event => { if (gesture.pointerUp(event)) suppressClick = true; }, options);
  editor.addEventListener('pointercancel', event => { gesture.pointerCancel(event); suppressClick = true; }, options);
  editor.addEventListener('keydown', event => {
    if (event.key === 'Escape' && gesture.pointerCancel()) { event.preventDefault(); event.stopImmediatePropagation(); suppressClick = true; }
  }, options);
  editor.addEventListener('change', event => { if (event.target.matches('[data-task-subtask-assignee], [data-task-subtask-group]')) refresh(); }, options);
  for (const name of ['auth:context-ending', 'auth:expired', 'auth:context-rejected']) window.addEventListener(name, dispose, options);
  window.addEventListener('vidamia:auth-context', () => { if (!sameAuthentication(authentication)) dispose(); }, options);
  function dispose() {
    if (disposed) return;
    disposed = true; listeners.abort(); gesture.dispose(); picker?.dispose(); personCard?.dispose(); feedback(null);
  }
  return { refresh, dispose };
}
