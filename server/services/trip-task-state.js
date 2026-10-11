/** Minimal read/lifecycle hooks without importing a database singleton. */
const exists=d=>!!d.prepare("SELECT 1 FROM sqlite_master WHERE name='trip_task_groups' AND type='table'").get();
export function tripTaskState(d,id) {
 if(!exists(d))return null;
 if(d.prepare('SELECT 1 FROM retired_trip_tasks WHERE task_id=?').get(id))return {state:'deleted',step_state:'deleted'};
 return d.prepare(`WITH RECURSIVE ancestry(id) AS (SELECT ? UNION SELECT t.parent_task_id FROM tasks t JOIN ancestry a ON a.id=t.id WHERE t.parent_task_id IS NOT NULL)
 SELECT g.state, s.state AS step_state FROM trip_task_groups g
 LEFT JOIN trip_task_steps s ON s.trip_id=g.trip_id AND s.task_id IN (SELECT id FROM ancestry)
 WHERE g.parent_task_id IN (SELECT id FROM ancestry) LIMIT 1`).get(id)||null;
}
export function isTripStep(d,id) {
 return exists(d)&&!!d.prepare('SELECT 1 FROM trip_task_steps WHERE task_id=?').get(id);
}
export function assertTripTaskActive(d,id) {
 const state=tripTaskState(d,id);
 if(state&&(state.state!=='active'||state.step_state&&state.step_state!=='active'))
  throw Object.assign(new Error('This Trip work was cancelled or retired. Review the Trip before changing its progress.'),{status:409,code:409,details:{reason:'trip_work_retired'}});
}
export function tripReminderActive(d,id) {
 const task=d.prepare('SELECT status,archived_at FROM tasks WHERE id=?').get(id);
 const state=tripTaskState(d,id);
 if(!state)return true;
 const retired=d.prepare(`WITH RECURSIVE ancestry AS (SELECT id,parent_task_id,status,archived_at FROM tasks WHERE id=?
   UNION SELECT t.id,t.parent_task_id,t.status,t.archived_at FROM tasks t JOIN ancestry a ON t.id=a.parent_task_id)
   SELECT 1 FROM ancestry WHERE archived_at IS NOT NULL OR status IN ('done','expired','skipped') LIMIT 1`).get(id);
 return state.state==='active'&&(!state.step_state||state.step_state==='active')&&task&&!retired;
}
export function markTripTaskOverrides(d,id,fields) {
 if(!exists(d))return;
 const step=d.prepare('SELECT * FROM trip_task_steps WHERE task_id=?').get(id);
 if(!step)return;
 const aliases={assigned_to:'assigned_user_ids',location:'location'};
 const managed=['title','description','priority','due_date','due_time','assigned_user_ids','location','is_optional'];
 const set=new Set(JSON.parse(step.overrides_json));
 for(const key of fields.map(k=>aliases[k]||k))if(managed.includes(key))set.add(key);
 d.prepare('UPDATE trip_task_steps SET overrides_json=? WHERE task_id=?').run(JSON.stringify([...set]),id);
}
