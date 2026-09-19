/** Authoritative recurring definitions. No database singleton or lifecycle
 * imports: migration and explicit writes share these helpers; reads never
 * bootstrap or advance an occurrence. */
import { backfillRecurrenceProvenance, registerRecurrenceOccurrence, registerRecurrenceAction } from './task-recurrence-frontier.js';
import { addCalendarDays } from './activity-schedule.js';
import { nextDueAfterCompletion, nextDueAfterExpiration, nextOccurrenceAfter, parseRRule } from './recurrence.js';
import { captureTaskActivityBindingDefinition } from './task-activity-snapshot.js';
import { captureTaskRotationRendering } from './task-rotation-rendering.js';

export const TASK_SERIES_SCHEMA_SQL = `
  CREATE TABLE task_recurrence_series (
    series_id INTEGER PRIMARY KEY,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TRIGGER trg_task_series_change AFTER UPDATE OF revision ON task_recurrence_series
    WHEN NEW.revision != OLD.revision
    BEGIN UPDATE task_change_clock SET version=version+1 WHERE id=1; END;
  CREATE TABLE task_recurrence_definitions (
    id INTEGER PRIMARY KEY,
    series_id INTEGER NOT NULL REFERENCES task_recurrence_series(series_id),
    effective_generation INTEGER NOT NULL CHECK(effective_generation >= 0),
    definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
    actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    source_task_id INTEGER,
    created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX idx_task_recurrence_definitions_effective ON task_recurrence_definitions(series_id,id DESC,effective_generation);
  ALTER TABLE task_recurrence_occurrences ADD COLUMN definition_id INTEGER REFERENCES task_recurrence_definitions(id);
  ALTER TABLE task_recurrence_occurrences ADD COLUMN planned_start_date TEXT;
  ALTER TABLE task_recurrence_occurrences ADD COLUMN planned_due_date TEXT;
  ALTER TABLE task_recurrence_occurrences ADD COLUMN materialized_revision INTEGER;
  ALTER TABLE task_recurrence_occurrences ADD COLUMN materialized_state_json TEXT;
  ALTER TABLE task_recurrence_occurrences ADD COLUMN exception_reason TEXT;
  ALTER TABLE task_activity_bindings ADD COLUMN definition_snapshot_json TEXT CHECK(definition_snapshot_json IS NULL OR json_valid(definition_snapshot_json));
`;

const TASK_FIELDS = ['title','description','category','priority','start_date','start_time','due_date','due_time',
  'due_date_offset_days','is_recurring','recurrence_rule','recurrence_from_completion','assignment_mode',
  'rotation_group','rotation_slot','rotation_bindings_json','points','visibility','countdown','locked','expiration_policy','is_optional','sort_order','activity_template_checklist_item_id'];
const selectedTask = row => Object.fromEntries(TASK_FIELDS.map(key => [key, row[key] ?? (key==='rotation_bindings_json'?'[]':null)]));
const parseDefinition = row => row ? { ...row, data: JSON.parse(row.definition_json) } : null;
const occurrenceRow = (d,taskId) => d.prepare('SELECT * FROM task_recurrence_occurrences WHERE task_id=?').get(taskId) || null;

export function seriesDefinitionForGeneration(d,seriesId,generation) {
  // The latest edit wins across its complete future scope, including an older
  // effective generation superseding a previously authored later definition.
  return parseDefinition(d.prepare(`SELECT * FROM task_recurrence_definitions
    WHERE series_id=? AND effective_generation<=? ORDER BY id DESC LIMIT 1`).get(seriesId,generation));
}

export function taskSeriesState(d,taskId) {
  const occurrence=occurrenceRow(d,taskId);if(!occurrence)return null;
  const series=d.prepare('SELECT * FROM task_recurrence_series WHERE series_id=?').get(occurrence.series_id);
  if(!series)return null;
  return {...series,occurrence,definition:seriesDefinitionForGeneration(d,series.series_id,occurrence.generation)};
}

export function seriesMetadata(d,taskId) {
  const state=taskSeriesState(d,taskId);
  return state?{recurrence_series_id:state.series_id,recurrence_series_revision:state.revision}:{};
}

export function normalizeSeriesDefinition(definition) {
  const normalizeTask=task=>{
    const {start_date,due_date,...fields}=selectedTask(task);
    const lead=start_date&&due_date?(Date.parse(`${due_date}T00:00:00Z`)-Date.parse(`${start_date}T00:00:00Z`))/86400000:null;
    return {...fields,calendar_lead_days:lead};
  };
  const binding=definition.binding?structuredClone(definition.binding):null;
  if(binding?.snapshot)delete binding.snapshot.rotation_cursor_user_id;
  if(binding?.snapshot)delete binding.snapshot.rotation_rendering;
  const rendering=definition.rotation_rendering||null;
  const normalizeRendered=(task,key)=>{
    const value=normalizeTask(task);
    for(const target of rendering?.targets||[])if(target.action_key===key)value[target.field]=target.template;
    return value;
  };
  return {...definition,binding,rotation_rendering:rendering?{...rendering,targets:rendering.targets.map(({last_value,...target})=>target)}:null,
    task:normalizeRendered(definition.task,'root'),subtasks:definition.subtasks.map(({source_task_id,...child})=>({...child,task:normalizeRendered(child.task,child.action_key)}))};
}

const stableDefinitionValue=value=>Array.isArray(value)?value.map(stableDefinitionValue)
  :value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stableDefinitionValue(value[key])])):value;
export function definitionEqual(left,right) {
  return JSON.stringify(stableDefinitionValue(normalizeSeriesDefinition(left)))===JSON.stringify(stableDefinitionValue(normalizeSeriesDefinition(right)));
}

/** Concrete date translations belong to the selected occurrence. Reusable
 * times, calendar-day spans and recurrence rules retain its nominal series
 * anchor, including when a title/configuration edit is saved at the same time. */
export function normalizeSeriesSchedule(definition,occurrence) {
  const value=structuredClone(definition),relative=value.task.due_date_offset_days!=null;
  const source=relative?value.task.start_date:value.task.due_date;
  const nominal=relative?occurrence.planned_start_date:occurrence.planned_due_date;
  if(source&&nominal) {
    const delta=Date.parse(`${nominal}T00:00:00Z`)-Date.parse(`${source}T00:00:00Z`);
    const shift=date=>{
      if(!date)return null;
      const shifted=new Date(Date.parse(`${date}T00:00:00Z`)+delta).toISOString().slice(0,10);
      if(!/^\d{4}-\d{2}-\d{2}$/.test(shifted))throw Object.assign(new Error('The recurring Activity schedule is outside the supported calendar.'),{status:400});
      return shifted;
    };
    for(const task of [value.task,...value.subtasks.map(child=>child.task)]) {
      task.start_date=shift(task.start_date);task.due_date=shift(task.due_date);
    }
  }
  return value;
}

export function registerSeriesAction(d,taskId,occurrenceTaskId,actionKey) {
  const existing=d.prepare('SELECT * FROM task_recurrence_actions WHERE task_id=?').get(taskId);
  if(existing && (existing.action_key!==actionKey || existing.occurrence_task_id!==occurrenceTaskId))
    throw new Error('A recurring action cannot change its historical identity.');
  d.prepare('INSERT OR IGNORE INTO task_recurrence_actions(task_id,occurrence_task_id,action_key) VALUES(?,?,?)')
    .run(taskId,occurrenceTaskId,actionKey);
  return {task_id:taskId,occurrence_task_id:occurrenceTaskId,action_key:actionKey};
}

function extras(d,id) {
  const assignments=d.prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(id).map(row=>row.user_id);
  const primary=d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(id)?.assigned_to;
  return {
    assigned_user_ids:primary?[primary,...assignments.filter(userId=>userId!==primary)]:assignments,
    skill_ids:d.prepare('SELECT skill_id FROM task_skill_requirements WHERE task_id=? ORDER BY sort_order,skill_id').all(id).map(row=>row.skill_id),
    tags:d.prepare('SELECT tag FROM task_tags WHERE task_id=? ORDER BY tag COLLATE NOCASE').all(id).map(row=>row.tag),
  };
}

/** Captures definition only: no status, progress, points receipts, comments or
 * documents. Archived removed actions remain historical rows, not new work. */
export function captureSeriesDefinition(d,taskId) {
  const root=d.prepare('SELECT * FROM tasks WHERE id=? AND parent_task_id IS NULL').get(taskId);
  if(!root)throw new Error('Choose a top-level recurring Task.');
  const children=d.prepare(`SELECT t.* FROM tasks t WHERE t.parent_task_id=? AND t.archived_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM task_activity_support_tasks s WHERE s.task_id=t.id)
    AND NOT EXISTS(SELECT 1 FROM task_supervision_actions a WHERE a.counterpart_task_id=t.id)
    ORDER BY t.sort_order,t.id`).all(taskId);
  const binding=captureTaskActivityBindingDefinition(d,taskId,{seriesId:occurrenceRow(d,taskId)?.series_id??null});
  const location=d.prepare('SELECT * FROM task_locations WHERE task_id=?').get(taskId);
  const planning=d.prepare('SELECT place_id,presence_policy,presence_window,source FROM task_planning_context WHERE task_id=?').get(taskId);
  return {task:selectedTask(root),...extras(d,taskId),
    rotation_user_ids:d.prepare('SELECT user_id FROM task_rotation_members WHERE task_id=? ORDER BY sort_order').all(taskId).map(row=>row.user_id),
    binding:binding||null,
    rotation_rendering:captureTaskRotationRendering(d,root,binding,children),
    location:location?Object.fromEntries(Object.entries(location).filter(([key])=>!['task_id','created_at','updated_at','created_by'].includes(key))):null,
    planning:planning||null,
    subtasks:children.map(child=>({action_key:registerRecurrenceAction(d,child.id)?.action_key||`action:${child.id}`,
      source_task_id:child.id,task:selectedTask(child),...extras(d,child.id)})),
  };
}

export function recordOccurrenceDefinition(d,taskId,{definitionId,startDate,dueDate,exceptionReason=null,baseline=false}={}) {
  const task=d.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);if(!task)return null;
  const tree=baseline?d.prepare(`WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT t.id FROM tasks t JOIN tree p ON t.parent_task_id=p.id)
    SELECT t.id,t.revision,t.status,t.archived_at FROM tasks t JOIN tree ON tree.id=t.id ORDER BY t.id`).all(taskId):null;
  d.prepare(`UPDATE task_recurrence_occurrences SET definition_id=COALESCE(?,definition_id),
    planned_start_date=?,planned_due_date=?,exception_reason=?,
    materialized_revision=CASE WHEN ? THEN ? ELSE materialized_revision END,
    materialized_state_json=CASE WHEN ? THEN ? ELSE materialized_state_json END WHERE task_id=?`)
    .run(definitionId??null,startDate===undefined?task.start_date:startDate,dueDate===undefined?task.due_date:dueDate,
      exceptionReason,baseline?1:0,task.revision,baseline?1:0,tree?JSON.stringify({tasks:tree}):null,taskId);
  return occurrenceRow(d,taskId);
}

export function ensureSeriesDefinition(d,taskId) {
  const occurrence=occurrenceRow(d,taskId)||registerRecurrenceOccurrence(d,taskId);if(!occurrence)return null;
  if(!d.prepare('SELECT 1 FROM task_recurrence_series WHERE series_id=?').get(occurrence.series_id)) {
    const latest=d.prepare(`SELECT t.* FROM task_recurrence_occurrences o JOIN tasks t ON t.id=o.task_id
      WHERE o.series_id=? AND o.state='materialized' ORDER BY o.generation DESC,o.task_id DESC LIMIT 1`).get(occurrence.series_id);
    if(!latest)return null;
    d.prepare('INSERT INTO task_recurrence_series(series_id) VALUES(?)').run(occurrence.series_id);
    const definition=captureSeriesDefinition(d,latest.id);
    const info=d.prepare(`INSERT INTO task_recurrence_definitions(series_id,effective_generation,definition_json,source_task_id)
      VALUES(?,0,?,?)`).run(occurrence.series_id,JSON.stringify(definition),latest.id);
    for(const row of d.prepare(`SELECT t.id,t.start_date,t.due_date FROM task_recurrence_occurrences o JOIN tasks t ON t.id=o.task_id WHERE o.series_id=?`).all(occurrence.series_id)) {
      recordOccurrenceDefinition(d,row.id,{definitionId:Number(info.lastInsertRowid),startDate:row.start_date,dueDate:row.due_date});
    }
  }
  return taskSeriesState(d,taskId);
}

export function initializeTaskSeries(d) {
  backfillRecurrenceProvenance(d);
  for(const row of d.prepare(`SELECT t.id FROM tasks t WHERE t.parent_task_id IS NULL AND
    (t.is_recurring=1 OR EXISTS(SELECT 1 FROM task_recurrence_occurrences o WHERE o.task_id=t.id)) ORDER BY t.id`).all()) ensureSeriesDefinition(d,row.id);
}

export function appendSeriesDefinition(d,taskId,{expectedRevision,actorId=null,definition,effectiveGeneration,force=false}={}) {
  const state=ensureSeriesDefinition(d,taskId);if(!state)throw new Error('This Task is not part of a recurring series.');
  if(expectedRevision!=null && Number(expectedRevision)!==state.revision)throw Object.assign(new Error('This recurring Activity changed. Refresh before saving.'),
    {status:409,details:{reason:'series_revision_conflict',series_revision:state.revision}});
  const generation=effectiveGeneration??state.occurrence.generation;
  const previous=seriesDefinitionForGeneration(d,state.series_id,generation);
  const value=definition??captureSeriesDefinition(d,taskId);
  const json=JSON.stringify(value);
  if(!force && previous && definitionEqual(previous.data,value))return {...state,changed:false};
  const info=d.prepare(`INSERT INTO task_recurrence_definitions(series_id,effective_generation,definition_json,actor_user_id,source_task_id)
    VALUES(?,?,?,?,?)`).run(state.series_id,generation,json,actorId,taskId);
  d.prepare('UPDATE task_recurrence_series SET revision=revision+1 WHERE series_id=?').run(state.series_id);
  return {...taskSeriesState(d,taskId),changed:true,definition:parseDefinition(d.prepare('SELECT * FROM task_recurrence_definitions WHERE id=?').get(info.lastInsertRowid))};
}

export function authoritativeTaskRecurrence(d,task) {
  const occurrence=occurrenceRow(d,task?.id);
  const definition=occurrence?seriesDefinitionForGeneration(d,occurrence.series_id,occurrence.generation+1):null;
  return definition?.data.task||task;
}

/** The existing generator calls this plan; occurrence-only dates and rule
 * edits never become the next definition or its fixed calendar anchor. */
export function seriesMaterializationPlan(d,task,{completedOn,expirationAnchor=false}={}) {
  const state=ensureSeriesDefinition(d,task.id);if(!state)return null;
  const definition=seriesDefinitionForGeneration(d,state.series_id,state.occurrence.generation+1);
  const window=planSeriesOccurrence(d,definition,state.occurrence,{completedOn,expired:task.status==='expired'||expirationAnchor});
  return window?{state,definition,...window}:null;
}

/** Plan the successor of the supplied nominal occurrence, without inserting
 * or editing anything. Callers can chain returned dates to reconcile existing
 * untouched future occurrences under one selected definition. */
export function planSeriesOccurrence(d,definition,occurrence,{anchorStartDate,anchorDueDate,completedOn=null,expired=false}={}) {
  const configuration=definition?.data.task;if(!configuration?.is_recurring||!configuration.recurrence_rule)return null;
  const relative=configuration.due_date_offset_days!=null;
  const previousAnchor=relative?(anchorStartDate??occurrence.planned_start_date):(anchorDueDate??occurrence.planned_due_date);
  const definitionAnchor=relative?configuration.start_date:configuration.due_date;
  let nextAnchor;
  if(configuration.recurrence_from_completion) {
    nextAnchor=expired?null:nextDueAfterCompletion({anchorDate:previousAnchor,rule:configuration.recurrence_rule,completedOn,fromCompletion:true});
  } else if(definition.id!==occurrence.definition_id && definitionAnchor && previousAnchor) {
    // A preserved exception may still have the previous schedule. Resume the
    // newest definition's phase after that nominal slot, not its edited dates.
    const afterPrevious=addCalendarDays(previousAnchor,1);
    const threshold=expired?afterPrevious:(completedOn>afterPrevious?completedOn:afterPrevious);
    nextAnchor=nextOccurrenceAfter(definitionAnchor,configuration.recurrence_rule,threshold);
  } else {
    nextAnchor=(expired?nextDueAfterExpiration:nextDueAfterCompletion)({anchorDate:previousAnchor||definitionAnchor,
      rule:configuration.recurrence_rule,completedOn,fromCompletion:false});
  }
  // A cadence edit can move the selected concrete occurrence onto the first
  // slot of its new rule while retaining its durable nominal/award identity.
  // That slot is already represented by this Task. Skip it only with proof of
  // a this-and-future cadence change; one-off date overrides keep their anchor.
  if(nextAnchor && !configuration.recurrence_from_completion
    && occurrence.definition_id===definition.id && !occurrence.exception_reason
    && definition.source_task_id===occurrence.task_id && definition.effective_generation===occurrence.generation) {
    const selected=d.prepare('SELECT start_date,due_date FROM tasks WHERE id=?').get(occurrence.task_id);
    const concreteAnchor=relative?selected?.start_date:selected?.due_date;
    if(concreteAnchor!==previousAnchor && nextAnchor===concreteAnchor
      && cadenceChangedAtOccurrence(d,definition,occurrence))
      nextAnchor=nextOccurrenceAfter(definitionAnchor||previousAnchor,configuration.recurrence_rule,addCalendarDays(nextAnchor,1));
  }
  if(!nextAnchor)return null;
  const legacyLead=configuration.start_date&&configuration.due_date
    ? (Date.parse(`${configuration.due_date}T00:00:00Z`)-Date.parse(`${configuration.start_date}T00:00:00Z`))/86400000:null;
  const startDate=relative?nextAnchor:legacyLead!=null?new Date(Date.parse(`${nextAnchor}T00:00:00Z`)-legacyLead*86400000).toISOString().slice(0,10):null;
  const dueDate=relative?addCalendarDays(startDate,configuration.due_date_offset_days):nextAnchor;
  if(!dueDate)throw new Error('The next recurring Activity has an invalid date window.');
  return {configuration,start_date:startDate,due_date:dueDate,relative};
}

function cadenceChangedAtOccurrence(d,definition,occurrence) {
  const cadence=task=>{
    const parsed=parseRRule(task.recurrence_rule);if(!parsed)return null;
    // Equivalent RRULE serialization and termination limits do not move slots.
    return JSON.stringify([parsed.freq,parsed.interval,[...new Set(parsed.byday)].sort(),!!task.recurrence_from_completion]);
  };
  const revisions=d.prepare(`SELECT source_task_id,effective_generation,definition_json FROM task_recurrence_definitions
    WHERE series_id=? AND effective_generation<=? AND id<=? ORDER BY id DESC`)
    .all(occurrence.series_id,occurrence.generation,definition.id);
  for(let index=0;index<revisions.length-1;index++) {
    const newer=cadence(JSON.parse(revisions[index].definition_json).task);
    const older=cadence(JSON.parse(revisions[index+1].definition_json).task);
    if(newer&&older&&newer!==older)
      return revisions[index].source_task_id===occurrence.task_id && revisions[index].effective_generation===occurrence.generation;
  }
  return false;
}
