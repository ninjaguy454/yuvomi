/** Durable, conservative coverage for authorized Task list refreshes.
 * An untracked global Task-clock advance creates a gap and forces a full read.
 * No trigger writes one row per affected Task. */
import {createHmac,timingSafeEqual} from 'node:crypto';

const FORMAT=1,MAX_EVENTS=256,KEEP_EVENTS=512;
export const MAX_TASK_LIST_WINDOW_IDS=600;
const clockStatement=d=>d.prepare('SELECT version FROM task_change_clock WHERE id=1');
export const captureTaskListClock=d=>Number(clockStatement(d).get()?.version||0);
const schemaVersion=d=>{
  try{return Number(d.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version||0);}
  catch(error){if(/no such table: schema_migrations/i.test(error.message))return 0;throw error;}
};

/** Only ordinary, self-contained Task trees can be covered by one root ID.
 * Linked helper, workflow, series and generated work keep the reset fallback. */
export function trackableTaskListRoot(d,taskId){
  let row=d.prepare('SELECT id,parent_task_id FROM tasks WHERE id=?').get(taskId);
  const seen=new Set();
  while(row?.parent_task_id){
    if(seen.has(row.id))return null;
    seen.add(row.id);row=d.prepare('SELECT id,parent_task_id FROM tasks WHERE id=?').get(row.parent_task_id);
  }
  if(!row)return null;
  const excluded=d.prepare(`WITH RECURSIVE tree(id) AS (
      SELECT ? UNION SELECT t.id FROM tasks t JOIN tree ON t.parent_task_id=tree.id
    ) SELECT 1 FROM tree JOIN tasks t ON t.id=tree.id WHERE
      t.is_recurring=1 OR t.recurrence_origin_id IS NOT NULL
      OR t.rotation_group IS NOT NULL OR t.assignment_group_json IS NOT NULL
      OR (t.rotation_bindings_json IS NOT NULL AND t.rotation_bindings_json!='[]')
      OR EXISTS(SELECT 1 FROM task_activity_bindings x WHERE x.task_id=t.id)
      OR EXISTS(SELECT 1 FROM task_activity_support_tasks x WHERE x.source_task_id=t.id OR x.task_id=t.id)
      OR EXISTS(SELECT 1 FROM task_supervision_actions x WHERE x.source_task_id=t.id OR x.action_task_id=t.id OR x.counterpart_task_id=t.id)
      OR EXISTS(SELECT 1 FROM workflow_instance_tasks x WHERE x.task_id=t.id)
      OR EXISTS(SELECT 1 FROM trip_tasks x WHERE x.task_id=t.id)
      OR EXISTS(SELECT 1 FROM meal_execution_tasks x WHERE x.task_id=t.id)
      OR EXISTS(SELECT 1 FROM task_action_links x WHERE x.task_id=t.id)
      OR EXISTS(SELECT 1 FROM task_claim_eligibility x WHERE x.task_id=t.id)
      OR EXISTS(SELECT 1 FROM task_rotation_occurrences x WHERE x.task_id=t.id OR x.owner_task_id=t.id)
      OR EXISTS(SELECT 1 FROM task_rotation_periods x WHERE x.task_id=t.id)
      OR EXISTS(SELECT 1 FROM task_incomplete_closures x WHERE x.task_id=t.id)
    LIMIT 1`).get(row.id);
  return excluded?null:row.id;
}

function secret(){
  const value=process.env.SESSION_SECRET;
  if(!value)throw new Error('Task list cursors require the session secret.');
  return value;
}
function signed(body){return createHmac('sha256',secret()).update(body).digest('base64url');}
function reset(reason){return {reset_required:true,reason};}
function validIds(values,max=MAX_TASK_LIST_WINDOW_IDS){return Array.isArray(values)&&values.length<=max
  &&values.every(id=>Number.isSafeInteger(id)&&id>0)&&new Set(values).size===values.length;}

export function taskListCursor(d,{actor,query,ids,authority='',nextStartAt=null,clock=captureTaskListClock(d)}){
  if(!Number.isSafeInteger(Number(actor))||Number(actor)<=0||typeof query!=='string'||!validIds(ids))
    throw new TypeError('Invalid Task list cursor context.');
  const start=nextStartAt==null?null:Number(nextStartAt);
  if(start!=null&&(!Number.isSafeInteger(start)||start<0))throw new TypeError('Invalid Task list start boundary.');
  const body=Buffer.from(JSON.stringify({v:FORMAT,m:schemaVersion(d),a:Number(actor),q:query,x:authority,c:clock,s:start,ids})).toString('base64url');
  const cursor=`${body}.${signed(body)}`;
  // The transport is an ordinary GET URL. Large windows use the full-list
  // contract until a paged/header transport is available.
  return cursor.length<=6000?cursor:null;
}

/** Call at the END of a covered mutation transaction. A no-op creates no row. */
export function recordTaskListDelta(d,beforeClock,rootIds){
  if(!d.inTransaction)throw new Error('Task list delta must commit with the Task mutation.');
  const afterClock=captureTaskListClock(d);
  if(afterClock===beforeClock)return false;
  if(!Number.isSafeInteger(beforeClock)||beforeClock<0||afterClock<beforeClock||!validIds(rootIds,128)||!rootIds.length)
    throw new TypeError('Invalid Task list mutation coverage.');
  const row=d.prepare('INSERT INTO task_list_delta_events(before_clock,after_clock,root_ids_json) VALUES(?,?,?)')
    .run(beforeClock,afterClock,JSON.stringify(rootIds));
  // Delete at most once per 64 events. Older cursors reset, never silently skip.
  if(Number(row.lastInsertRowid)%64===0)d.prepare('DELETE FROM task_list_delta_events WHERE seq<=?')
    .run(Number(row.lastInsertRowid)-KEEP_EVENTS);
  return true;
}

/** The caller must keep this read and restricted hydration in one DB snapshot. */
export function readTaskListDelta(d,{cursor,actor,query,authority='',now=Date.now()}){
  if(typeof cursor!=='string'||cursor.length>50000)return reset('invalid_cursor');
  const [body,signature,...extra]=cursor.split('.');
  if(extra.length||!body||!signature||!/^[-_A-Za-z0-9]+$/.test(body))return reset('invalid_cursor');
  const expected=signed(body),left=Buffer.from(signature),right=Buffer.from(expected);
  if(left.length!==right.length||!timingSafeEqual(left,right))return reset('invalid_cursor');
  let payload;
  try{payload=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));}
  catch{return reset('invalid_cursor');}
  if(payload?.v!==FORMAT||payload.a!==Number(actor)||payload.q!==query||payload.x!==authority||!validIds(payload.ids)
    ||!Number.isSafeInteger(payload.c)||payload.c<0)return reset('cursor_mismatch');
  if(payload.m!==schemaVersion(d))return reset('schema_changed');
  if(payload.s!=null&&(!Number.isSafeInteger(payload.s)||payload.s<0||now>=payload.s))return reset('start_boundary');
  const current=captureTaskListClock(d);
  if(payload.c>current)return reset('future_cursor');
  if(payload.c===current)return {reset_required:false,version:current,changed_ids:[],known_ids:payload.ids,next_start_at:payload.s};
  const rows=d.prepare(`SELECT before_clock,after_clock,root_ids_json FROM task_list_delta_events
    WHERE after_clock>? ORDER BY seq LIMIT ?`).all(payload.c,MAX_EVENTS+1);
  if(rows.length>MAX_EVENTS)return reset('cursor_expired');
  let covered=payload.c;const ids=new Set();
  for(const row of rows){
    if(row.before_clock!==covered||row.after_clock<=covered)return reset('untracked_change');
    covered=row.after_clock;
    let changed;
    try{changed=JSON.parse(row.root_ids_json);}catch{return reset('invalid_journal');}
    if(!validIds(changed,128))return reset('invalid_journal');
    for(const id of changed)ids.add(id);
    if(ids.size>128)return reset('delta_too_large');
  }
  if(covered!==current)return reset('untracked_change');
  return {reset_required:false,version:current,changed_ids:[...ids],known_ids:payload.ids,next_start_at:payload.s};
}
