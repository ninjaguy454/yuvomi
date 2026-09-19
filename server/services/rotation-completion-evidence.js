/** Read recorded linked Task evidence, never infer real-world action order.
 * Bulk records and indistinguishable timestamps stay explicitly unordered. */
import { taskCapabilities } from './task-access.js';

export function rotationCompletionEvidence(d,occurrenceId,{viewer=null,cache=new Map()}={}) {
  const key=`completion-evidence:${occurrenceId}:${typeof viewer==='object'?viewer?.authUserId:viewer}`;
  if(cache.has(key))return cache.get(key);
  const rows=d.prepare(`WITH RECURSIVE owners(id) AS (
    SELECT DISTINCT owner_task_id FROM task_rotation_occurrences WHERE occurrence_id=? AND owner_task_id IS NOT NULL
  ), descendants(id) AS (
    SELECT t.id FROM tasks t JOIN owners o ON t.parent_task_id=o.id
    UNION SELECT t.id FROM tasks t JOIN descendants p ON t.parent_task_id=p.id
  ) SELECT e.*,t.status AS task_status FROM task_activity_events e JOIN descendants c ON c.id=e.action_task_id
    JOIN tasks t ON t.id=c.id WHERE e.event_type='completed' ORDER BY e.created_at,e.id`).all(occurrenceId);
  const visibility=new Map();
  if(viewer!=null) {
    const ids=[...new Set(rows.map(record=>record.action_task_id))];
    for(let start=0;start<ids.length;start+=500) {
      const batch=ids.slice(start,start+500);
      for(const task of d.prepare(`SELECT * FROM tasks WHERE id IN (${batch.map(()=>'?').join(',')})`).all(...batch))
        visibility.set(task.id,taskCapabilities(d,viewer,task).view);
    }
  }
  const groups=new Map();
  for(const record of rows) {
    if(viewer!=null&&!visibility.get(record.action_task_id))continue;
    const details=JSON.parse(record.details_json);
    const event={id:record.id,task_id:record.action_task_id,title:details.title||'Task completion',recorded_at:record.created_at,
      member_id:details.assigned_user_id??null,bulk:details.completion_source==='bulk',source:details.completion_source||'unclassified'};
    if(!groups.has(event.recorded_at))groups.set(event.recorded_at,[]);
    groups.get(event.recorded_at).push(event);
  }
  const result=[...groups].map(([recorded_at,events])=>({recorded_at,unordered:events.length>1||events.some(event=>event.source!=='individual'),events}));
  cache.set(key,result);return result;
}
