import {taskVisibilityWhere,taskReadStatement,taskReadTableExists} from './task-access.js';
import {todayKey} from '../utils/timezone.js';

function supported(d){return taskReadTableExists(d,'trip_task_groups');}

/** The next deadline is a read projection. The parent's saved deadline stays editable. */
export function attachTripTaskProjection(d,task,actor){
 if(!supported(d)||!task)return task;
 const group=taskReadStatement(d,'SELECT * FROM trip_task_groups WHERE parent_task_id=?').get(task.id);
 const step=taskReadStatement(d,'SELECT trip_id,step_key,phase,state FROM trip_task_steps WHERE task_id=?').get(task.id);
 if(step)task.trip_step=step;
 if(!group)return task;
 task.trip_group={trip_id:group.trip_id,state:group.state,revision:group.revision};
 const next=group.state==='active'?taskReadStatement(d,`SELECT c.id,c.title,c.due_date,c.due_time FROM tasks c
   WHERE c.parent_task_id=@parent AND c.archived_at IS NULL AND c.status NOT IN ('done','expired','skipped','closed_incomplete')
     AND (c.start_date IS NULL OR c.start_date<=@today)
     AND NOT EXISTS(SELECT 1 FROM trip_task_steps s WHERE s.task_id=c.id AND s.state!='active')
     AND ${taskVisibilityWhere(d,actor,'c','@me')}
   ORDER BY c.due_date IS NULL,c.due_date,COALESCE(c.due_time,'23:59:59'),c.sort_order,c.id LIMIT 1`)
   .get({parent:task.id,me:Number(actor?.authUserId??actor?.session?.userId??actor),today:todayKey(d)}):null;
 task.next_trip_step=next||null;
 task.display_due_date=next?.due_date??null;
 task.display_due_time=next?.due_time??null;
 return task;
}

/** Used before Dashboard LIMIT/aggregation, with the same child access boundary. */
export function tripDisplayDueSql(d,actor,alias='t',field='due_date'){
 if(!supported(d))return `${alias}.${field}`;
 return `CASE WHEN EXISTS(SELECT 1 FROM trip_task_groups g WHERE g.parent_task_id=${alias}.id)
 THEN (SELECT c.${field} FROM tasks c JOIN trip_task_groups g ON g.parent_task_id=c.parent_task_id
   WHERE c.parent_task_id=${alias}.id AND g.state='active' AND c.archived_at IS NULL
     AND c.status NOT IN ('done','expired','skipped','closed_incomplete') AND (c.start_date IS NULL OR c.start_date<=@today)
     AND NOT EXISTS(SELECT 1 FROM trip_task_steps s WHERE s.task_id=c.id AND s.state!='active')
     AND ${taskVisibilityWhere(d,actor,'c','@me')}
   ORDER BY c.due_date IS NULL,c.due_date,COALESCE(c.due_time,'23:59:59'),c.sort_order,c.id LIMIT 1)
 ELSE ${alias}.${field} END`;
}
