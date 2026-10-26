import { api } from '/api.js';
import { confirmOverModal } from '/components/modal.js';
import { t } from '/i18n.js';
import {captureCompletionSound,confirmCompletionSound} from '/utils/ui-sounds.js';
import {authenticationSnapshot,sameAuthentication} from '/utils/device-context.js';
import {recoverTaskStatus} from '/utils/task-status-recovery.js';

import { actionableSubtasks, structuralSubtasks } from '/utils/task-progress.js';
export { actionableSubtasks } from '/utils/task-progress.js';

export function taskRevision(task) {
  return {
    ...(Number.isInteger(task?.revision) ? { expected_revision: task.revision } : {}),
    ...(Number.isInteger(task?.parent_revision) ? { expected_parent_revision: task.parent_revision } : {}),
  };
}

/** Confirmation decisions are derived from saved state, never a second progress field. */
export function taskStatusConfirmation(task, status) {
  const structural = structuralSubtasks(task);
  const supervisionOf = (child) => child.supervision_action
    || task.supervision?.actions?.find((action) => Number(action.action_task_id) === Number(child.id));
  const delegated = structural.filter((child) => {
    const action = supervisionOf(child);
    return action?.execution_mode === 'delegated' && action.state !== 'not_required';
  });
  const pendingDelegated = delegated.filter((child) => child.status !== 'done' && !child.is_optional);
  // Progress belongs to the learner projection. A permitted helper's parent
  // completion can affect the original structure, so its confirmation must
  // explicitly include those direct responsibilities as well.
  const completesHelperWork = pendingDelegated.length > 0
    && pendingDelegated.every((child) => supervisionOf(child)?.can_complete === true && child.permissions?.complete !== false);
  const originalRoot=!task.parent_task_id&&!task.is_supervision_projection&&!task.helper_view_user_id;
  const children = (originalRoot||completesHelperWork ? structural : actionableSubtasks(task)).filter(child => !child.is_optional);
  if (status === 'done' && (children.some((child) => child.status !== 'done')
    || Number(task.scheduled_subtask_total || 0) > Number(task.scheduled_subtask_done || 0))) {
    return { flag: 'complete_remaining', message: 'Complete this Task?',
      detail: 'Choose whether to mark remaining required subtasks complete. Uncheck to keep their saved progress. Optional subtasks stay as they are. Points follow the activity’s scoring rules; required supervision still applies.',
      checkbox: originalRoot
        ? {label:'Complete remaining subtasks',checked:true}:null,
      confirmLabel: 'Complete Task' };
  }
  if (status === 'open' && (task.status === 'done' || structural.some((child) => child.status === 'done')
    || Number(task.scheduled_completed_action_count || 0) > 0
    || Number(task.scheduled_subtask_done || 0) > 0 || Number(task.scheduled_optional_subtask_done || 0) > 0)) {
    return { flag: 'reset_progress', message: 'Resetting this Task will clear its subtask progress.',
      detail: `${delegated.some((child) => child.status === 'done') ? 'Completed helper actions will also be reset. ' : ''}Completion history is retained. Cancel keeps the current progress.`,
      confirmLabel: 'Reset Task', danger: true };
  }
  return null;
}

export async function changeTaskStatus(task, status, { confirm: requestConfirmation = confirmOverModal, beforeRequest = () => {},gesture=null,soundTicket=null,signal,parentTaskId,onUncertain=()=>{} } = {}) {
  const authentication=authenticationSnapshot();
  const cue=status==='done'?(soundTicket||captureCompletionSound(gesture)):null;
  if (task.status === 'skipped') throw new Error('This occurrence was skipped and cannot be reopened or completed.');
  if (task.status === 'closed_incomplete') throw new Error('Reopen this activity from its details before changing progress.');
  if (status === 'closed_incomplete') throw new Error('Use Close without completing remaining subtasks from activity details.');
  if (status === 'skipped') throw new Error('Use Skip this occurrence from Task details.');
  if (task.status === 'expired') throw new Error('Reopen this expired Task before changing its status.');
  if (status === 'expired') throw new Error('Tasks expire automatically at their deadline.');
  const confirmation = taskStatusConfirmation(task, status);
  const body = { status, ...taskRevision(task) };
  if (confirmation) {
    let completeRemaining=true;
    const checkbox=confirmation.checkbox?{...confirmation.checkbox,onChange:checked=>{completeRemaining=checked;}}:null;
    if (!await requestConfirmation(confirmation.message, { ...confirmation, checkbox,closeOnConfirm: false })) return null;
    body[confirmation.flag] = confirmation.flag==='complete_remaining'?completeRemaining:true;
  }
  // A pending projection starts only after confirmation, with the original
  // revision still attached to the write. Cancel never paints unsaved progress.
  beforeRequest();
  const lifetime=new AbortController();
  const stop=()=>lifetime.abort();
  const endEvents=['auth:context-ending','auth:expired','auth:context-rejected','pagehide'];
  signal?.addEventListener('abort',stop,{once:true});
  if(signal?.aborted)stop();
  for(const name of endEvents)window.addEventListener(name,stop);
  try {
    const result=await recoverTaskStatus({task,body,signal:lifetime.signal,isCurrent:()=>sameAuthentication(authentication),
      write:(request,options)=>api.patch(`/tasks/${task.id}/status`,request,options),
      read:async options=>{
        // A queued checkbox already has access to this parent. Read that one
        // canonical projection so progress, points and permissions settle
        // together; production child GETs do not include their parent.
        const response=await api.get(`/tasks/${parentTaskId||task.id}`,{...options,requireFresh:true});
        if(!parentTaskId)return response;
        const child=response.data?.subtasks?.find(row=>Number(row.id)===Number(task.id));
        if(!child)throw Object.assign(new Error('This step is no longer available. Review the current Task.'),
          {status:409,outcome:'rejected',data:{reason:'queue_changed'}});
        return {data:{...child,parent_revision:response.data.revision,parent_task:response.data}};
      },
      onUncertain:error=>{
        onUncertain(error);
        window.yuvomi?.showToast('Connection interrupted. Checking this change automatically.','warning');
      }});
    confirmCompletionSound(cue,result?.data?.status==='done');
    return result;
  } finally {
    signal?.removeEventListener('abort',stop);
    for(const name of endEvents)window.removeEventListener(name,stop);
  }
}

/** Reopening is an explicit lifecycle action, separate from marking work done. */
export async function reopenExpiredTask(task, { confirm: requestConfirmation = confirmOverModal } = {}) {
  if (task.status !== 'expired' || task.archived_at || !task.permissions?.edit || !task.permissions?.change_dates) {
    throw new Error('You cannot reopen this Task. Archived Tasks must first be unarchived.');
  }
  const body = { expiration_policy: 'keep_overdue', ...taskRevision(task) };
  const confirmed = await requestConfirmation('Reopen this expired Task?', {
    detail: `${t('tasks.scoringReopen')} This occurrence switches to Keep overdue. Already-created future occurrences stay unchanged. For Repeat from completion, future occurrences will also keep overdue. You can set a new deadline and expiration policy in Edit.`,
    confirmLabel: 'Reopen Task', closeOnConfirm: false,
  });
  if (!confirmed) return null;
  return api.post(`/tasks/${task.id}/reopen`, body);
}

const pendingSkips=new Map();
/** Reuse the exact request after an unknown network outcome. No optimistic excusal. */
export async function skipTaskOccurrence(task,{confirm:requestConfirmation=confirmOverModal}={}) {
  if(!task.can_skip_occurrence||!task.permissions?.skip_occurrence||task.archived_at||task.parent_task_id)
    throw new Error('You cannot skip this occurrence.');
  const date=task.due_date||task.start_date;
  if(!await requestConfirmation(date?`Skip this occurrence on ${date}?`:'Skip this occurrence?',{
    detail:'Its unfinished work will be excused for all current assignees. No new completion points are awarded; previously earned points remain. Future occurrences keep their schedule. If one remains, the next scheduled occurrence is generated even if already overdue.',
    confirmLabel:'Skip this occurrence',closeOnConfirm:false,
  }))return null;
  const key=`${task.id}:${task.revision}`;
  const body=pendingSkips.get(key)||{expected_revision:task.revision,operation_id:globalThis.crypto.randomUUID()};
  pendingSkips.set(key,body);
  try {const result=await api.post(`/tasks/${task.id}/skip`,body);pendingSkips.delete(key);return result;}
  catch(error){if([400,403,404,409,428].includes(error.status||error.code))pendingSkips.delete(key);throw error;}
}

const pendingClosures=new Map();
/** Compatibility for older detail callers; the result is ordinary completion. */
export async function closeIncompleteTask(task,{confirm:requestConfirmation=confirmOverModal}={}) {
  if(!task.can_close_incomplete||!task.permissions?.close_incomplete||task.archived_at||task.parent_task_id||task.helper_view_user_id||!['open','in_progress'].includes(task.status))
    throw new Error('You cannot close this activity.');
  const authentication=authenticationSnapshot();
  const recurrence=task.incomplete_closure?.recurrence_handled?'Already-created future occurrences stay unchanged.'
    :task.is_recurring?`The next occurrence advances once${task.recurrence_from_completion?' from today':''}.`:'';
  if(!await requestConfirmation('Complete this activity?',{
    detail:`Unfinished subtasks keep their saved progress. Points follow the activity’s scoring rules. ${recurrence}`.trim(),
    confirmLabel:'Complete activity',closeOnConfirm:false,
  }))return null;
  if(!sameAuthentication(authentication))throw new Error('Your sign-in changed. Reopen the activity and try again.');
  for(const [key,value] of pendingClosures)if(!sameAuthentication(value.authentication))pendingClosures.delete(key);
  const key=`${authentication.epoch}:${task.id}:${task.revision}`;
  const body=pendingClosures.get(key)?.body||{expected_revision:task.revision,operation_id:globalThis.crypto.randomUUID()};
  pendingClosures.set(key,{body,authentication});
  try {const result=await api.post(`/tasks/${task.id}/close-incomplete`,body);pendingClosures.delete(key);return sameAuthentication(authentication)?result:null;}
  catch(error){if([400,403,404,409,428].includes(error.status||error.code))pendingClosures.delete(key);throw error;}
}

/** Explicitly resume saved work; this request never resets progress or successors. */
export async function reopenIncompleteTask(task,{confirm:requestConfirmation=confirmOverModal}={}) {
  if(!task.can_reopen_incomplete||!task.permissions?.close_incomplete||task.archived_at||task.parent_task_id||task.helper_view_user_id||task.status!=='closed_incomplete')
    throw new Error('You cannot reopen this activity.');
  const authentication=authenticationSnapshot();
  if(!await requestConfirmation('Reopen this activity?',{
    detail:'Saved subtask progress and earned points remain. Already-created future occurrences stay unchanged. Newly finished work uses the normal earning rules. A passed deadline switches this occurrence to Keep overdue; Reset remains a separate action.',
    confirmLabel:'Reopen activity',closeOnConfirm:false,
  }))return null;
  if(!sameAuthentication(authentication))throw new Error('Your sign-in changed. Reopen the activity details and try again.');
  for(const [key,value] of pendingClosures)if(!sameAuthentication(value.authentication))pendingClosures.delete(key);
  const key=`reopen:${authentication.epoch}:${task.id}:${task.revision}`;
  const body=pendingClosures.get(key)?.body||{expected_revision:task.revision,operation_id:globalThis.crypto.randomUUID()};
  pendingClosures.set(key,{body,authentication});
  try {const result=await api.post(`/tasks/${task.id}/reopen-incomplete`,body);pendingClosures.delete(key);return sameAuthentication(authentication)?result:null;}
  catch(error){if([400,403,404,409,428].includes(error.status||error.code))pendingClosures.delete(key);throw error;}
}
