import { api } from '/api.js';
import { openChildModal } from '/components/modal.js';
import { esc } from '/utils/html.js';
import { taskRevision } from '/utils/task-state.js';
import { isDevicePrincipal, authenticationSnapshot, sameAuthentication } from '/utils/device-context.js';

export const canApproveDeviceTask = task => isDevicePrincipal() && task?.permissions?.supervisor_approval === true;
let currentApproval = null;

/** One authenticated action. Never call setSession or replace the Task board. */
export async function approveDeviceTask(task, parent = null) {
  if (!canApproveDeviceTask(task) || currentApproval) return null;
  currentApproval = task.id;
  const context = authenticationSnapshot();
  let modal, approval, result = null, closed = false, busy = false, secondFactor = false, popup, timer;
  let polling = false;
  const content = `<form id="device-task-approval" autocomplete="off">
    <p>Complete <strong>${esc(task.title)}</strong> with approval from its assigned, qualified supervisor or helper.</p>
    <p class="text-muted">Authentication approves this step only. The display stays in device mode.</p>
    <p data-approval-error class="form-error" role="alert" tabindex="-1" hidden></p>
    <div data-approval-password>
      <div class="form-group"><label for="approval-username">Username</label><input class="input" id="approval-username" name="username" autocomplete="username" data-immediate-action required></div>
      <div class="form-group"><label for="approval-password">Password</label><input class="input" id="approval-password" name="password" type="password" autocomplete="current-password" data-immediate-action required></div>
    </div>
    <div data-approval-factor hidden class="form-group"><label for="approval-code">Authentication or recovery code</label><input class="input" id="approval-code" name="code" autocomplete="one-time-code" data-immediate-action></div>
    <button type="button" class="btn btn--secondary" data-approval-sso hidden>Approve with single sign-on</button>
    <p class="text-muted" data-approval-status role="status">Preparing approval…</p>
    <div class="modal-panel__footer"><button type="button" class="btn btn--secondary" data-approval-cancel>Cancel</button><button type="submit" class="btn btn--primary" data-approval-submit disabled>Authenticate and complete</button></div>
  </form>`;
  const report = error => {
    if (closed || !sameAuthentication(context)) return;
    const target = modal.panel.querySelector('[data-approval-error]');
    target.textContent = error.data?.error || error.message || 'Approval could not be completed.';
    target.hidden = false; target.focus({preventScroll:true}); target.scrollIntoView({block:'nearest'});
  };
  const accept = async response => {
    if (closed || !sameAuthentication(context)) return;
    if (response.approval?.id && response.approval.id !== approval?.id) throw new Error('This approval changed. Cancel and try again.');
    if (response.approval?.approved) { result = response; await modal.close({force:true}); return; }
    if (!secondFactor && (response.twoFactorRequired || response.approval?.twoFactorRequired)) {
      secondFactor = true;
      const form = modal.panel.querySelector('form');
      form.querySelector('[data-approval-password]').hidden = true;
      form.elements.password.value = ''; form.elements.password.required = false; form.elements.username.required = false;
      form.querySelector('[data-approval-factor]').hidden = false; form.elements.code.required = true;
      form.elements.code.focus();
      modal.panel.querySelector('[data-approval-submit]').textContent = 'Verify and complete';
      modal.panel.querySelector('[data-approval-submit]').hidden = false;
      modal.panel.querySelector('[data-approval-sso]').hidden = true;
    }
    if (response.error || response.approval?.error) report(new Error(response.error || response.approval.error));
  };
  const poll = async () => {
    if (closed || busy || polling || !approval || !sameAuthentication(context)) return;
    polling = true;
    try { await accept(await api.get('/device/approval')); }
    catch (error) { report(error); if ([409,410].includes(error.status)) clearInterval(timer); }
    finally { polling = false; }
  };
  const onMessage = event => {
    if (event.origin === location.origin && event.source === popup && event.data?.type === 'device-approval-return') void poll();
  };
  const endContext = () => { void modal?.close({force:true}); };
  try {
    modal = openChildModal({title:'Supervisor approval',content,size:'sm',initialFocus:'first-field',onClose:()=>{
      closed = true; clearInterval(timer); window.removeEventListener('message',onMessage);
      window.removeEventListener('auth:context-ending',endContext);
      modal.panel?.querySelector('form')?.reset();
      try { popup?.close(); } catch { /* provider may not allow it */ }
      if (approval && !result && sameAuthentication(context)) void api.post('/device/approval/cancel',{approval_id:approval.id}).catch(()=>{});
    }});
    window.addEventListener('auth:context-ending',endContext);
    window.addEventListener('message',onMessage);
    const form = modal.panel.querySelector('form'), submit = modal.panel.querySelector('[data-approval-submit]');
    modal.panel.querySelector('[data-approval-cancel]').onclick = () => modal.close({force:true});
    form.addEventListener('submit',async event => {
      event.preventDefault(); if (busy || !approval) return;
      busy = true; submit.disabled = true;
      modal.panel.querySelector('[data-approval-error]').hidden = true;
      try {
        const response = secondFactor
          ? await api.post('/auth/2fa/verify',{code:form.elements.code.value,approval_id:approval.id})
          : await api.post('/auth/login',{username:form.elements.username.value,password:form.elements.password.value,approval_id:approval.id});
        await accept(response);
      } catch (error) { report(error); }
      finally { busy = false; if (!closed) submit.disabled = false; }
    });
    try {
      const started = await api.post(`/device/tasks/${task.id}/approval/begin`,{status:'done',...taskRevision(task),...(parent?{expected_parent_revision:parent.revision}:{})});
      approval = started.approval;
      if (closed || !sameAuthentication(context)) {
        if (sameAuthentication(context)) await api.post('/device/approval/cancel',{approval_id:approval.id}).catch(()=>{});
        return null;
      }
      submit.disabled = false;
      modal.panel.querySelector('[data-approval-status]').textContent = 'Approval expires after 2 minutes. No personal session is opened.';
      const config = await api.get('/auth/oidc/config');
      if (closed) return null;
      const sso = modal.panel.querySelector('[data-approval-sso]');
      sso.hidden = !config.enabled;
      if (config.password_login_enabled === false) { form.querySelector('[data-approval-password]').hidden = true; submit.hidden = true; }
      sso.onclick = () => {
        popup = window.open(`/api/v1/auth/oidc/start?approval_id=${encodeURIComponent(approval.id)}`,'vidamia-action-approval','popup,width=540,height=700');
        if (!popup) report(new Error('Allow the sign-in window to open, then try again.'));
      };
      timer = setInterval(poll,2000);
    } catch (error) { report(error); }
    await modal.closed;
    return sameAuthentication(context) ? result : null;
  } finally { currentApproval = null; }
}
