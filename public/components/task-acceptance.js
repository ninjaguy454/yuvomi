import { api } from '/api.js';
import { mountAcceptanceAllocation } from '/components/task-acceptance-allocation.js';
import { openTaskPersonCard } from '/components/task-person-card.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { memberLabel } from '/utils/member-label.js';
import { authenticationSnapshot, sameAuthentication } from '/utils/device-context.js';
import { openChildModal, mountFooter, focusFirstField } from '/components/modal.js';
import { createAcceptanceDraft, setAcceptanceHelpers, needsAcceptanceAllocation, lockAcceptancePayload } from '/utils/task-acceptance-draft.js';

/** One server-authorized acceptance; all choices stay local until confirmation. */
export async function acceptOpenTask(task) {
  const authentication = authenticationSnapshot();
  let active = true, draft = null, stage = 'loading', message = '', result = null, busy = false, loadGeneration = 0;
  let allocation = null, allocationScope = null, personCard = null;
  const valid = () => active && sameAuthentication(authentication);
  const modal = openChildModal({ title: t('tasks.acceptTitle'), size: 'lg', initialFocus: 'none', content: '<div data-task-acceptance></div>', onClose: () => { active = false; clearAllocation(); } });
  const body = modal.panel.querySelector('.modal-panel__body');
  const endEvents = ['auth:context-ending', 'auth:expired', 'auth:context-rejected'];
  const close = () => { active = false; loadGeneration++; clearAllocation(); return modal.close({ force: true }); };
  for (const event of endEvents) window.addEventListener(event, close);
  function membersById() { return new Map([...(draft?.projection.primary_candidates || []), ...(draft?.projection.coassignee_candidates || [])].map(member => [Number(member.id), member])); }
  function memberName(id) { return memberLabel(membersById().get(Number(id))) || t('tasks.acceptMember'); }
  function canonicalName(id) { return membersById().get(Number(id))?.display_name || t('tasks.acceptMember'); }
  function memberInitials(name) {
    const parts = String(name || t('tasks.acceptMember')).trim().split(/\s+/);
    return [parts[0], ...(parts.length > 1 ? [parts.at(-1)] : [])].map(part => Array.from(part)[0] || '').join('').toLocaleUpperCase();
  }
  function memberAvatar(name) { return `<span class="task-acceptance__avatar" aria-hidden="true">${esc(memberInitials(name))}</span>`; }
  const button = (action, label, primary = false) => `<button type="button" class="btn btn--${primary ? 'primary' : 'secondary'}" data-acceptance-${action}>${esc(label)}</button>`;
  function render(focus = true) {
    if (!valid()) return;
    clearAllocation();
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
      content = `<h3 class="task-acceptance__title" title="${esc(p.task.title)}">${esc(p.task.title)}</h3>${message ? `<p role="status">${esc(message)}</p>` : ''}`;
      if (stage === 'primary') {
        content += `<label for="acceptance-primary">${esc(t('tasks.acceptWho'))}</label><p class="text-muted">${esc(t('tasks.acceptIdentityHint'))}</p><select id="acceptance-primary" class="input" data-immediate-action data-acceptance-primary><option value="">${esc(t('tasks.acceptChoose'))}</option>${p.primary_candidates.map(member => `<option value="${Number(member.id)}" ${draft.primary === Number(member.id) ? 'selected' : ''}>${esc(memberLabel(member))}</option>`).join('')}</select>`;
        actions += button('next', t('common.next'), true);
      } else if (stage === 'helpers') {
        content += `<fieldset class="task-acceptance__helpers"><legend>${esc(t('tasks.acceptHelpers'))}</legend>`;
        if (p.can_add_helpers) content += p.coassignee_candidates.filter(member => Number(member.id) !== draft.primary).map(member => `<label class="task-acceptance__member">${memberAvatar(member.display_name)}<span class="task-acceptance__member-name">${esc(memberLabel(member))}</span><input type="checkbox" data-immediate-action data-acceptance-helper="${Number(member.id)}" ${draft.helpers.includes(Number(member.id)) ? 'checked' : ''}></label>`).join('');
        else content += `<p data-acceptance-helper-unavailable>${esc(t('tasks.acceptHelpersUnavailable'))}</p>${document.querySelector('[data-device-login]') ? button('signin', t('tasks.acceptSignIn')) : ''}`;
        content += '</fieldset>';
        if (p.primary_mode === 'choose') actions += button('back', t('common.back'));
        actions += button('next', t('common.next'), true);
      } else if (stage === 'allocation') {
        content += '<div data-acceptance-allocation></div>';
        actions += button('back', t('common.back')) + button('next', t('common.next'), true);
      } else if (stage === 'confirm') {
        content += `<div class="task-acceptance__identity">${memberAvatar(canonicalName(draft.primary))}<span class="task-acceptance__member-name" data-acceptance-identity>${esc(memberName(draft.primary))}</span></div><section class="task-acceptance__summary-helpers" aria-labelledby="acceptance-summary-helpers"><h4 id="acceptance-summary-helpers">${esc(t('tasks.acceptHelpersLabel'))}</h4>${draft.helpers.length ? `<ul class="task-acceptance__summary-members">${draft.helpers.map(id => `<li class="task-acceptance__identity" data-acceptance-summary-helper="${Number(id)}">${memberAvatar(canonicalName(id))}<span class="task-acceptance__member-name">${esc(memberName(id))}</span></li>`).join('')}</ul>` : `<p data-acceptance-no-helpers>${esc(t('tasks.acceptNoHelpers'))}</p>`}</section>`;
        if (p.subtasks.length) content += `<ul>${p.subtasks.map(child => `<li>${esc(child.title)}: ${esc(!child.allocatable ? t('tasks.acceptPreservedShort') : draft.assignments[child.id] ? memberName(draft.assignments[child.id]) : t('tasks.acceptUnassigned'))}</li>`).join('')}</ul>`;
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
    if (stage === 'allocation') {
      allocationScope = new AbortController();
      allocation = mountAcceptanceAllocation(modal.panel.querySelector('[data-acceptance-allocation]'), {
        draft, authentication, signal: allocationScope.signal,
        onPerson(person, anchor) {
          if (!valid() || busy || draft.submission) return;
          personCard?.dispose();
          personCard = openTaskPersonCard({ person, anchor, host: modal.panel, signal: allocationScope.signal, onClose: () => { personCard = null; } });
        },
      });
    }
    if (focus) focusFirstField(modal.panel);
  }
  function clearAllocation() {
    allocationScope?.abort(); allocationScope = null;
    allocation?.dispose(); allocation = null;
    personCard?.dispose(); personCard = null;
  }
  // The shared modal also owns its close button and Escape dismissal. Stop local
  // gestures as soon as those routes begin, before the closing animation ends.
  modal.panel.addEventListener('click', event => {
    if (event.target.closest('[data-action="close-modal"]')) clearAllocation();
  }, { capture: true });
  modal.panel.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented) clearAllocation();
  });
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
  active = false; clearAllocation();
  for (const event of endEvents) window.removeEventListener(event, close);
  return result;
}
