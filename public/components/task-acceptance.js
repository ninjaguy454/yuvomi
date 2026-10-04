import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { authenticationSnapshot, sameAuthentication } from '/utils/device-context.js';
import { openChildModal, mountFooter, focusFirstField } from '/components/modal.js';
import { createAcceptanceDraft, setAcceptanceHelpers, needsAcceptanceAllocation, assignAcceptanceSubtask, lockAcceptancePayload } from '/utils/task-acceptance-draft.js';

/** One server-authorized acceptance; all choices stay local until confirmation. */
export async function acceptOpenTask(task) {
  const authentication = authenticationSnapshot();
  let active = true, draft = null, stage = 'loading', message = '', result = null, busy = false, loadGeneration = 0;
  let dragListeners = null;
  const valid = () => active && sameAuthentication(authentication);
  const modal = openChildModal({ title: t('tasks.acceptTitle'), size: 'lg', initialFocus: 'none', content: '<div data-task-acceptance></div>', onClose: () => { active = false; } });
  const body = modal.panel.querySelector('.modal-panel__body');
  const endEvents = ['auth:context-ending', 'auth:expired', 'auth:context-rejected'];
  const close = () => { active = false; loadGeneration++; dragListeners?.abort(); return modal.close({ force: true }); };
  for (const event of endEvents) window.addEventListener(event, close);
  function names() { return new Map([...(draft?.projection.primary_candidates || []), ...(draft?.projection.coassignee_candidates || [])].map(member => [Number(member.id), member.display_name])); }
  function memberName(id) { return names().get(Number(id)) || t('tasks.acceptMember'); }
  const button = (action, label, primary = false) => `<button type="button" class="btn btn--${primary ? 'primary' : 'secondary'}" data-acceptance-${action}>${esc(label)}</button>`;
  function render(focus = true) {
    if (!valid()) return;
    dragListeners?.abort();
    let content = '', actions = button('cancel', t('common.cancel'));
    if (stage === 'loading') content = `<p role="status">${esc(t('common.loading'))}</p>`;
    else if (stage === 'error' || stage === 'conflict') {
      content = `<p role="alert">${esc(message)}</p>`;
      actions += button('reload', t('tasks.acceptReload'), true);
    } else if (stage === 'retry') {
      content = `<p role="alert">${esc(t('tasks.acceptUnknown'))}</p>`;
      actions += button('retry', t('tasks.acceptRetry'), true);
    } else {
      const p = draft.projection;
      content = `<h3>${esc(p.task.title)}</h3>${message ? `<p role="status">${esc(message)}</p>` : ''}`;
      if (stage === 'primary') {
        content += `<label for="acceptance-primary">${esc(t('tasks.acceptWho'))}</label><p class="text-muted">${esc(t('tasks.acceptIdentityHint'))}</p><select id="acceptance-primary" class="input" data-immediate-action data-acceptance-primary><option value="">${esc(t('tasks.acceptChoose'))}</option>${p.primary_candidates.map(member => `<option value="${Number(member.id)}" ${draft.primary === Number(member.id) ? 'selected' : ''}>${esc(member.display_name)}</option>`).join('')}</select>`;
        actions += button('next', t('common.next'), true);
      } else if (stage === 'helpers') {
        content += `<p>${esc(t('tasks.acceptPrimary', { name: memberName(draft.primary) }))}</p><fieldset class="task-acceptance__helpers"><legend>${esc(t('tasks.acceptHelpers'))}</legend><p class="text-muted">${esc(t('tasks.acceptHelpersHint'))}</p>`;
        if (p.can_add_helpers) content += p.coassignee_candidates.filter(member => Number(member.id) !== draft.primary).map(member => `<label class="task-acceptance__member"><input type="checkbox" data-immediate-action data-acceptance-helper="${Number(member.id)}" ${draft.helpers.includes(Number(member.id)) ? 'checked' : ''}>${esc(member.display_name)}</label>`).join('');
        else content += `<p data-acceptance-helper-unavailable>${esc(t('tasks.acceptHelpersUnavailable'))}</p>${document.querySelector('[data-device-login]') ? button('signin', t('tasks.acceptSignIn')) : ''}`;
        content += '</fieldset>';
        if (p.primary_mode === 'choose') actions += button('back', t('common.back'));
        actions += button('next', t('common.next'), true);
      } else if (stage === 'allocation') {
        const recipients = [draft.primary, ...draft.helpers];
        content += `<p>${esc(t('tasks.acceptAllocateHint'))}</p><div class="task-acceptance__pools">${[null, ...recipients].map(id => `<section class="task-acceptance__pool" data-acceptance-pool="${id ?? ''}" aria-label="${esc(id == null ? t('tasks.acceptUnassigned') : memberName(id))}"><h4>${esc(id == null ? t('tasks.acceptUnassigned') : memberName(id))}</h4>${p.subtasks.filter(child => child.allocatable && (draft.assignments[child.id] ?? null) === id).map(child => `<div class="task-acceptance__step" data-acceptance-child="${Number(child.id)}"><button type="button" class="btn btn--ghost task-acceptance__drag" data-acceptance-drag="${Number(child.id)}" aria-label="${esc(t('tasks.acceptMove', { title: child.title }))}">↕</button><span>${esc(child.title)}</span><label class="sr-only" for="acceptance-child-${Number(child.id)}">${esc(t('tasks.acceptAssign', { title: child.title }))}</label><select id="acceptance-child-${Number(child.id)}" class="input" data-immediate-action data-acceptance-assignment="${Number(child.id)}"><option value="">${esc(t('tasks.acceptUnassigned'))}</option>${recipients.filter(uid => child.eligible_assignee_ids.map(Number).includes(uid)).map(uid => `<option value="${uid}" ${id === uid ? 'selected' : ''}>${esc(memberName(uid))}</option>`).join('')}</select></div>`).join('')}</section>`).join('')}</div>`;
        const protectedSteps = p.subtasks.filter(child => !child.allocatable);
        if (protectedSteps.length) content += `<p class="text-muted">${esc(t('tasks.acceptPreserved'))}</p><ul>${protectedSteps.map(child => `<li>${esc(child.title)}</li>`).join('')}</ul>`;
        actions += button('back', t('common.back')) + button('next', t('common.next'), true);
      } else if (stage === 'confirm') {
        content += `<p>${esc(t('tasks.acceptPrimary', { name: memberName(draft.primary) }))}</p><p>${esc(t('tasks.acceptWithHelpers', { names: draft.helpers.length ? draft.helpers.map(memberName).join(', ') : t('tasks.acceptNoHelpers') }))}</p>`;
        if (p.subtasks.length) content += `<ul>${p.subtasks.map(child => `<li>${esc(child.title)}: ${esc(!child.allocatable ? t('tasks.acceptPreservedShort') : draft.assignments[child.id] ? memberName(draft.assignments[child.id]) : t('tasks.acceptUnassigned'))}</li>`).join('')}</ul>`;
        content += `<p class="text-muted">${esc(t('tasks.acceptConfirmHint'))}</p>`;
        actions += button('back', t('common.back')) + button('confirm', t('tasks.acceptConfirm'), true);
      }
    }
    body.replaceChildren();
    body.insertAdjacentHTML('beforeend', `<div class="task-acceptance" data-task-acceptance data-stage="${stage}">${content}</div><div class="modal-panel__footer">${actions}</div>`);
    mountFooter(modal.panel);
    modal.panel.querySelectorAll('button,select,input').forEach(el => { if (!el.matches('.modal-panel__close')) el.disabled = busy; });
    const on = (name, handler) => { const el = modal.panel.querySelector(`[data-acceptance-${name}]`); if (el) el.onclick = handler; };
    on('cancel', close); on('reload', () => load(draft?.primary, true)); on('retry', submit); on('confirm', submit);
    on('signin', async () => { await close(); document.querySelector('[data-device-login]')?.click(); });
    on('next', async () => {
      if (stage === 'primary') {
        const primary = Number(modal.panel.querySelector('[data-acceptance-primary]').value);
        if (!primary) { modal.panel.querySelector('[data-acceptance-primary]').focus(); return; }
        if (primary === draft.primary) { stage = 'helpers'; render(); return; }
        await load(primary); return;
      }
      stage = stage === 'helpers' && needsAcceptanceAllocation(draft) ? 'allocation' : 'confirm'; message = ''; render();
    });
    on('back', () => { stage = stage === 'helpers' ? 'primary' : stage === 'confirm' && needsAcceptanceAllocation(draft) ? 'allocation' : 'helpers'; render(); });
    modal.panel.querySelectorAll('[data-acceptance-helper]').forEach(el => { el.onchange = () => setAcceptanceHelpers(draft, [...modal.panel.querySelectorAll('[data-acceptance-helper]:checked')].map(input => Number(input.dataset.acceptanceHelper))); });
    modal.panel.querySelectorAll('[data-acceptance-assignment]').forEach(el => { el.onchange = () => { const id = Number(el.dataset.acceptanceAssignment); assignAcceptanceSubtask(draft, id, el.value ? Number(el.value) : null); render(false); modal.panel.querySelector(`[data-acceptance-assignment="${id}"]`)?.focus(); }; });
    wireDrag();
    if (focus) focusFirstField(modal.panel);
  }
  function wireDrag() {
    dragListeners = new AbortController();
    const options = { signal: dragListeners.signal };
    let drag = null, frame = 0, previousTime = 0;
    const highlight = () => {
      const pool = drag && document.elementFromPoint(drag.x, drag.y)?.closest('[data-acceptance-pool]');
      modal.panel.querySelectorAll('[data-acceptance-pool]').forEach(el => el.classList.toggle('task-acceptance__pool--target', el === pool));
    };
    const stop = () => {
      const previous = drag; drag = null;
      cancelAnimationFrame(frame); frame = 0; previousTime = 0;
      if (previous?.handle.hasPointerCapture?.(previous.pointer)) previous.handle.releasePointerCapture(previous.pointer);
      highlight();
    };
    dragListeners.signal.addEventListener('abort', stop, { once: true });
    function scroll(time) {
      if (!drag || !valid() || !drag.handle.hasPointerCapture(drag.pointer)) { stop(); return; }
      const rect = body.getBoundingClientRect(), edge = 56;
      const elapsed = previousTime ? Math.min(time - previousTime, 32) : 0;
      previousTime = time;
      // Only the allocation body scrolls; a held pointer keeps working as pools move beneath it.
      if (drag.x >= rect.left && drag.x <= rect.right && drag.y >= rect.top && drag.y <= rect.bottom) {
        const strength = drag.y < rect.top + edge ? -Math.min(1, (rect.top + edge - drag.y) / edge)
          : drag.y > rect.bottom - edge ? Math.min(1, (drag.y - rect.bottom + edge) / edge) : 0;
        body.scrollTop += strength * elapsed * 0.9;
      }
      highlight(); frame = requestAnimationFrame(scroll);
    }
    modal.panel.addEventListener('pointerdown', event => {
      const handle = event.target.closest('[data-acceptance-drag]');
      if (!handle || event.button !== 0 || busy || drag) return;
      drag = { id: Number(handle.dataset.acceptanceDrag), pointer: event.pointerId, handle, x: event.clientX, y: event.clientY };
      handle.setPointerCapture?.(event.pointerId); event.preventDefault();
      frame = requestAnimationFrame(scroll);
    }, options);
    modal.panel.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.pointer) return;
      drag.x = event.clientX; drag.y = event.clientY; highlight();
      event.preventDefault();
    }, { ...options, passive: false });
    modal.panel.addEventListener('pointerup', event => {
      if (!drag || event.pointerId !== drag.pointer) return;
      const pool = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-acceptance-pool]');
      const id = drag.id; stop();
      if (pool) assignAcceptanceSubtask(draft, id, pool.dataset.acceptancePool ? Number(pool.dataset.acceptancePool) : null);
      render(false); modal.panel.querySelector(`[data-acceptance-drag="${id}"]`)?.focus({ preventScroll: true });
    }, options);
    const cancel = event => { if (drag && event.pointerId === drag.pointer) { stop(); render(false); } };
    modal.panel.addEventListener('pointercancel', cancel, options);
    modal.panel.addEventListener('lostpointercapture', cancel, options);
    modal.panel.addEventListener('keydown', event => { if (event.key === 'Escape' && drag) { event.stopImmediatePropagation(); stop(); render(false); } }, { ...options, capture: true });
  }
  async function load(primary = null, refreshed = false) {
    const generation = ++loadGeneration;
    stage = 'loading'; render();
    try {
      const response = await api.get(`/tasks/${task.id}/acceptance${primary ? `?primary_user_id=${primary}` : ''}`, { requireFresh: true });
      if (!valid() || generation !== loadGeneration) return;
      draft = createAcceptanceDraft(response.data, crypto.randomUUID());
      stage = draft.projection.primary_mode === 'choose' && !draft.primary ? 'primary' : 'helpers';
      message = refreshed ? t('tasks.acceptRefreshed') : '';
    } catch (error) {
      if (!valid() || generation !== loadGeneration) return;
      stage = 'error'; message = error.data?.error || error.message;
    }
    render();
  }
  async function submit() {
    if (!valid() || busy) return;
    busy = true; render(false);
    try {
      const response = await api.post(`/tasks/${task.id}/accept`, lockAcceptancePayload(draft));
      if (!valid()) return;
      result = response; await close();
    } catch (error) {
      if (!valid()) return;
      if (error.status === 409) { stage = 'conflict'; message = t('tasks.acceptConflict'); }
      else if (error.outcome === 'unknown' || !error.status || error.status >= 500) stage = 'retry';
      else { stage = 'error'; message = error.data?.error || error.message; }
    } finally { busy = false; render(); }
  }
  void load();
  await modal.closed;
  active = false; dragListeners?.abort();
  for (const event of endEvents) window.removeEventListener(event, close);
  return result;
}
