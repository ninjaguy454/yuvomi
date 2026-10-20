/** Concrete assignees selected from a reusable Group. The Group owns its
 * membership and order; each Activity owns this small selection policy. */
import {orderedRotationSelection,stableRotationStart} from './rotation-order.js';
import {previewSharedRotation} from './rotation-shared.js';
import {todayKey} from '../utils/timezone.js';

const fail=message=>{throw Object.assign(new Error(message),{status:400});};
export function normalizeGroupAssignment(d,value,{allowInactive=false}={}) {
  if(value==null||value==='')return null;
  if(typeof value==='string')value=JSON.parse(value);
  if(!value||typeof value!=='object'||Array.isArray(value))fail('Choose a Rotation Group.');
  const groupId=Number(value.group_id);
  if(!Number.isSafeInteger(groupId)||groupId<1)fail('Choose a Rotation Group.');
  const group=d.prepare('SELECT id,active FROM rotation_groups WHERE id=? AND household_key=?').get(groupId,'household');
  if(!group||(!allowInactive&&!group.active))fail('Choose an active Rotation Group.');
  const startMode=value.start_mode??'first',direction=value.direction??'first_to_last';
  if(!['first','random'].includes(startMode))fail('Choose first or random for the starting member.');
  if(!['first_to_last','last_to_first'].includes(direction))fail('Choose a valid rotation direction.');
  return {group_id:groupId,start_mode:startMode,direction};
}

export function groupAssignmentMembers(d,configuration) {
  return d.prepare(`SELECT m.user_id id FROM rotation_group_members m
    JOIN users u ON u.id=m.user_id
    WHERE m.group_id=? AND m.active=1 ORDER BY m.sort_order,m.id`).all(configuration.group_id).map(row=>row.id);
}

/** The caller supplies the same qualified/present candidates used for an
 * ordinary Activity. A preview never advances the cursor. */
export function chooseGroupAssignee(d,configuration,{consumerKey,eligibleIds,commit=false,dateKey=todayKey(d)}={}) {
  const config=normalizeGroupAssignment(d,configuration,{allowInactive:!commit});
  if(!config)return null;
  const order=groupAssignmentMembers(d,config);
  if(!order.length)fail('This Rotation Group has no current household members.');
  const schedule=d.prepare(`SELECT v.usage_mode FROM rotation_group_schedule_versions v
    JOIN rotation_group_schedules s ON s.id=v.schedule_id WHERE s.group_id=? AND v.effective_date<=?
    ORDER BY v.effective_date DESC,v.id DESC LIMIT 1`).get(config.group_id,dateKey);
  if(schedule?.usage_mode==='shared'){
    const period=previewSharedRotation(d,config.group_id,{dateKey});
    if(!period||period.forecast_pending)fail('This shared Rotation Group has no confirmed or forecast order for this Activity date.');
    const selected=period.member_ids.find(id=>eligibleIds.map(Number).includes(Number(id)));
    if(!selected)fail('No member in this shared Rotation period is qualified and present for this Activity.');
    return selected;
  }
  // A changed starting policy has its own cursor. Retrying the same definition
  // still resolves to the same member until it is committed.
  const key=`group-assignment:${consumerKey}:${config.group_id}:${config.start_mode}:${config.direction}`;
  const cursor=d.prepare('SELECT cursor_user_id FROM assignment_rotation_state WHERE rotation_key=?').get(key)?.cursor_user_id??null;
  const seed=config.start_mode==='random'?stableRotationStart(order,key):order[0];
  const next=cursor==null?seed:null;
  const selected=orderedRotationSelection({memberIds:order,eligibleIds,nextMemberId:next,
    previousMemberId:cursor,strategy:'rotating_order',direction:config.direction}).member_ids[0];
  if(!selected)fail('No member of this Rotation Group is qualified and present for this Activity.');
  if(commit)d.prepare(`INSERT INTO assignment_rotation_state(rotation_key,cursor_user_id,occurrence_count,updated_at)
    VALUES(?,?,1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    ON CONFLICT(rotation_key) DO UPDATE SET cursor_user_id=excluded.cursor_user_id,
      occurrence_count=assignment_rotation_state.occurrence_count+1,updated_at=excluded.updated_at`).run(key,selected);
  return selected;
}

export function recordGroupAssignment(d,taskId,configuration,userId) {
  const config=normalizeGroupAssignment(d,configuration,{allowInactive:true});
  if(!config||!userId)return;
  const old=d.prepare('SELECT group_id,selected_user_id,configuration_json FROM task_group_assignment_decisions WHERE task_id=? AND superseded_at IS NULL').get(taskId);
  const encoded=JSON.stringify(config);
  if(old&&old.group_id===config.group_id&&old.selected_user_id===userId&&old.configuration_json===encoded)return;
  d.prepare("UPDATE task_group_assignment_decisions SET superseded_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE task_id=? AND superseded_at IS NULL").run(taskId);
  d.prepare('INSERT INTO task_group_assignment_decisions(task_id,group_id,selected_user_id,configuration_json) VALUES(?,?,?,?)')
    .run(taskId,config.group_id,userId,encoded);
  d.prepare('UPDATE tasks SET assignment_group_json=? WHERE id=?').run(encoded,taskId);
}
