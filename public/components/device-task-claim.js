import { api } from '/api.js';
import { openChildModal } from '/components/modal.js';
import { esc } from '/utils/html.js';
import { taskRevision } from '/utils/task-state.js';
import { isDevicePrincipal } from '/utils/device-context.js';

/** Selecting a recipient is local to this claim; it never changes identity. */
export async function claimTask(task) {
  if (!isDevicePrincipal()) return api.post(`/automation/tasks/${task.id}/claim`,taskRevision(task));
  let recipient = null;
  const modal = openChildModal({title:'Claim Task',content:`<form data-device-claim><p>Who is taking responsibility for this Task?</p><p class="text-muted">This selects a recipient for this claim only. It does not sign them in.</p><label for="device-claim-member">Household member</label><select id="device-claim-member" class="input" data-immediate-action required><option value="">Choose a member</option>${(task.claim_candidates||[]).map(member=>`<option value="${Number(member.id)}">${esc(member.display_name)}</option>`).join('')}</select><div class="modal-panel__footer"><button type="button" class="btn btn--secondary" data-claim-cancel>Cancel</button><button type="submit" class="btn btn--primary">Claim Task</button></div></form>`});
  modal.panel.querySelector('[data-claim-cancel]').onclick=()=>modal.close({force:true});
  modal.panel.querySelector('form').onsubmit=async event=>{event.preventDefault();recipient=Number(modal.panel.querySelector('select').value)||null;if(recipient)await modal.close({force:true});};
  await modal.closed;
  return recipient ? api.post(`/automation/tasks/${task.id}/claim`,{...taskRevision(task),user_id:recipient}) : null;
}
