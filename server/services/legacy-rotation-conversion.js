/** Map safe legacy Task cohorts to reusable Group identities. The old cohort
 * cursor and slot remain the assignment adapter: replacing them with one
 * Group cursor would give every Task in a cycle the same person. */
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
// SQLite NOCASE folds ASCII only; use the same equivalence for cohort keys.
const keyOf=value=>typeof value==='string'?value.replace(/[A-Z]/g,letter=>letter.toLowerCase()):'';
const ids=value=>Array.isArray(value)&&value.length&&value.every(id=>Number.isSafeInteger(Number(id))&&Number(id)>0)
  ?value.map(Number):null;

function soloFuturePlan(d,cohort,roster){
  if(cohort.tasks.some(task=>Number(task.rotation_slot||0)!==0))return null;
  const placeholders=cohort.tasks.map(()=>'?').join(',');
  const occurrences=d.prepare(`SELECT o.task_id,o.series_id,o.generation,o.state,t.assigned_to,t.status,t.rotation_index
    FROM task_recurrence_occurrences o JOIN tasks t ON t.id=o.task_id
    WHERE o.task_id IN (${placeholders}) ORDER BY o.generation DESC,o.task_id DESC`)
    .all(...cohort.tasks.map(task=>task.id));
  if(occurrences.length!==cohort.tasks.length||new Set(occurrences.map(row=>row.series_id)).size!==1
    ||occurrences.some(row=>row.state!=='materialized'))return null;
  const frontier=occurrences[0];
  if(!['open','in_progress'].includes(frontier.status)
    ||frontier.assigned_to!==roster[Number(frontier.rotation_index||0)%roster.length]
    ||occurrences.filter(row=>row.generation===frontier.generation).length!==1)return null;
  const existing=d.prepare(`SELECT definition_json FROM task_recurrence_definitions
    WHERE series_id=? AND effective_generation<=? ORDER BY id DESC LIMIT 1`)
    .get(frontier.series_id,frontier.generation+1);
  if(!existing)return null;
  const definition=JSON.parse(existing.definition_json);
  if(keyOf(definition?.task?.rotation_group)!==keyOf(cohort.sourceKey)
    ||!same(ids(definition.rotation_user_ids),roster)
    ||definition.task.assignment_group_json||definition.binding)return null;
  return {frontier,definition};
}

export function convertLegacyRotationGroups(d){
  d.exec(`CREATE TABLE IF NOT EXISTS legacy_rotation_group_mappings (
    source_key TEXT NOT NULL PRIMARY KEY COLLATE NOCASE,
    group_id INTEGER NOT NULL UNIQUE REFERENCES rotation_groups(id) ON DELETE RESTRICT,
    roster_json TEXT NOT NULL CHECK(json_valid(roster_json)),
    is_current INTEGER NOT NULL DEFAULT 1 CHECK(is_current IN (0,1)),
    compatibility_mode TEXT NOT NULL DEFAULT 'synchronized_slots'
      CHECK(compatibility_mode IN ('synchronized_slots','converted_independent')),
    created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );`);
  const cohorts=new Map();
  for(const task of d.prepare(`SELECT id,rotation_group,rotation_slot,rotation_index,rotation_cycle,
      assignment_mode,is_recurring,parent_task_id,assignment_group_json
      FROM tasks WHERE rotation_group IS NOT NULL AND trim(rotation_group)<>'' ORDER BY id`).all()){
    const key=keyOf(task.rotation_group);
    if(!cohorts.has(key))cohorts.set(key,{sourceKey:task.rotation_group,name:task.rotation_group.trim(),tasks:[],definitions:[],subtask:false});
    cohorts.get(key).tasks.push(task);
  }
  if(!cohorts.size)return;
  for(const row of d.prepare('SELECT id,definition_json FROM task_recurrence_definitions ORDER BY id').all()){
    const definition=JSON.parse(row.definition_json);
    const root=cohorts.get(keyOf(definition?.task?.rotation_group));
    if(root)root.definitions.push({id:row.id,roster:ids(definition.rotation_user_ids),slot:Number(definition.task.rotation_slot||0)});
    for(const action of definition?.subtasks||[]){
      const cohort=cohorts.get(keyOf(action?.task?.rotation_group));if(cohort)cohort.subtask=true;
    }
  }
  const taskRoster=d.prepare('SELECT user_id FROM task_rotation_members WHERE task_id=? ORDER BY sort_order');
  const household=new Set(d.prepare(`SELECT id FROM users u WHERE NOT EXISTS
      (SELECT 1 FROM split_expense_guest_users g WHERE g.user_id=u.id)
      AND NOT EXISTS (SELECT 1 FROM housekeeping_workers w WHERE w.user_id=u.id)`).all().map(row=>row.id));
  const occupied=d.prepare('SELECT 1 FROM rotation_groups WHERE household_key=? AND name=? COLLATE NOCASE');
  const mapped=d.prepare('SELECT group_id FROM legacy_rotation_group_mappings WHERE source_key=?');
  for(const [key,cohort] of cohorts){
    if(mapped.get(cohort.sourceKey))continue;
    const rosters=cohort.tasks.map(task=>taskRoster.all(task.id).map(row=>row.user_id));
    const roster=rosters[0];
    if(cohort.subtask||!roster||roster.length<2||new Set(roster).size!==roster.length
      ||roster.some(id=>!household.has(id))||rosters.some(list=>!same(list,roster))
      ||cohort.tasks.some(task=>task.parent_task_id||task.assignment_mode!=='round_robin'||!task.is_recurring
        ||task.assignment_group_json||!Number.isInteger(Number(task.rotation_slot))
        ||task.rotation_slot<0||task.rotation_slot>=roster.length)
      ||cohort.definitions.some(def=>!same(def.roster,roster)||!Number.isInteger(def.slot)
        ||def.slot<0||def.slot>=roster.length))continue;
    const cycles=new Map();
    for(const task of cohort.tasks){
      const cycle=Number(task.rotation_cycle||0),slot=Number(task.rotation_slot||0),index=Number(task.rotation_index||0);
      if(!cycles.has(cycle))cycles.set(cycle,{index,slots:new Set()});
      const state=cycles.get(cycle);
      if(state.index!==index||state.slots.has(slot)){cohort.conflict=true;break;}
      state.slots.add(slot);
    }
    if(cohort.conflict)continue;
    const solo=soloFuturePlan(d,cohort,roster);
    // A legacy key may contain a private Task title. The new Group catalogue
    // must not disclose it to users who cannot view that Task.
    const neutral=`Imported Task Rotation ${cohort.tasks[0].id}`;
    let name=neutral,suffix=1;
    while(occupied.get('household',name)){
      const tail=` (imported ${suffix++})`;
      name=`${neutral.slice(0,120-tail.length)}${tail}`;
    }
    const groupId=Number(d.prepare('INSERT INTO rotation_groups(name,description,active) VALUES(?,?,1)')
      .run(name,'Imported from a synchronized recurring Task cohort. Its saved slot offsets remain in effect.').lastInsertRowid);
    const insert=d.prepare('INSERT INTO rotation_group_members(group_id,user_id,sort_order) VALUES(?,?,?)');
    roster.forEach((id,index)=>insert.run(groupId,id,index));
    d.prepare('INSERT INTO legacy_rotation_group_mappings(source_key,group_id,roster_json,compatibility_mode) VALUES(?,?,?,?)')
      .run(cohort.sourceKey,groupId,JSON.stringify(roster),solo?'converted_independent':'synchronized_slots');
    if(solo){
      const config={group_id:groupId,start_mode:'first',direction:'first_to_last'};
      const cursorKey=`group-assignment:series:${solo.frontier.series_id}:root:${groupId}:first:first_to_last`;
      d.prepare('INSERT INTO assignment_rotation_state(rotation_key,cursor_user_id,occurrence_count) VALUES(?,?,?)')
        .run(cursorKey,solo.frontier.assigned_to,Math.max(1,Number(solo.frontier.generation)+1));
      const next=structuredClone(solo.definition);
      next.task={...next.task,assignment_mode:'fixed',rotation_group:null,rotation_slot:0,
        assignment_group_json:JSON.stringify(config)};
      next.rotation_user_ids=[];
      next.assigned_user_ids=[solo.frontier.assigned_to];
      d.prepare(`INSERT INTO task_recurrence_definitions(series_id,effective_generation,definition_json,source_task_id)
        VALUES(?,?,?,?)`).run(solo.frontier.series_id,solo.frontier.generation+1,JSON.stringify(next),solo.frontier.task_id);
      d.prepare('UPDATE task_recurrence_series SET revision=revision+1 WHERE series_id=?').run(solo.frontier.series_id);
    }
    d.prepare(`UPDATE rotation_compatibility_review SET status='resolved'
      WHERE source_type='task' AND source_value=? COLLATE NOCASE`).run(cohort.sourceKey);
    for(const definition of cohort.definitions)d.prepare(`UPDATE rotation_compatibility_review SET status='resolved'
      WHERE source_type='recurrence_definition' AND source_id=?`).run(definition.id);
  }
}

export function mappedLegacyRotationGroup(d,sourceKey){
  if(!sourceKey)return null;
  if(!d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_rotation_group_mappings'").get())return null;
  return d.prepare('SELECT group_id,compatibility_mode FROM legacy_rotation_group_mappings WHERE source_key=? COLLATE NOCASE AND is_current=1')
    .get(sourceKey)||null;
}

export function mappedLegacyRotationGroups(d){
  if(!d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_rotation_group_mappings'").get())return new Map();
  return new Map(d.prepare(`SELECT m.source_key,m.group_id,m.compatibility_mode,g.name
    FROM legacy_rotation_group_mappings m JOIN rotation_groups g ON g.id=m.group_id
    WHERE m.is_current=1`).all().map(row=>[keyOf(row.source_key),row]));
}

/** A current legacy occurrence can still be edited for its whole series.
 * Carry the already converted future assignment across that edit while the
 * concrete current occurrence retains its original legacy definition. */
export function convertedLegacyFutureDefinition(d,sourceKey,seriesId,nextGeneration,current){
  const mapping=mappedLegacyRotationGroup(d,sourceKey);
  if(mapping?.compatibility_mode!=='converted_independent'
    ||current?.task?.assignment_mode!=='round_robin'
    ||keyOf(current.task.rotation_group)!==keyOf(sourceKey))return null;
  const roster=JSON.parse(d.prepare('SELECT roster_json FROM legacy_rotation_group_mappings WHERE group_id=?')
    .get(mapping.group_id).roster_json);
  if(!same(ids(current.rotation_user_ids),roster))return null;
  const row=d.prepare(`SELECT definition_json FROM task_recurrence_definitions
    WHERE series_id=? AND effective_generation<=? ORDER BY id DESC LIMIT 1`).get(seriesId,nextGeneration);
  if(!row)return null;
  const prior=JSON.parse(row.definition_json);
  let config;
  try{config=JSON.parse(prior.task.assignment_group_json);}catch{return null;}
  if(Number(config?.group_id)!==mapping.group_id||prior.task.assignment_mode!=='fixed')return null;
  const future=structuredClone(current);
  future.task={...future.task,assignment_mode:'fixed',rotation_group:null,rotation_slot:0,
    assignment_group_json:prior.task.assignment_group_json};
  future.rotation_user_ids=[];
  future.assigned_user_ids=prior.assigned_user_ids;
  return future;
}

/** A deliberate legacy Task/series edit may make a prior mapping obsolete.
 * Keep the Group/history, but stop presenting it as the current cohort. */
export function refreshLegacyRotationGroupMapping(d,sourceKey){
  if(!sourceKey||!d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_rotation_group_mappings'").get())return;
  const mapping=d.prepare('SELECT * FROM legacy_rotation_group_mappings WHERE source_key=? COLLATE NOCASE').get(sourceKey);
  if(!mapping)return;
  const roster=JSON.parse(mapping.roster_json);
  const tasks=d.prepare(`SELECT id,rotation_slot,assignment_mode,is_recurring,assignment_group_json FROM tasks
    WHERE rotation_group=? COLLATE NOCASE`).all(sourceKey);
  const members=d.prepare('SELECT user_id FROM task_rotation_members WHERE task_id=? ORDER BY sort_order');
  let valid=tasks.length>0&&tasks.every(task=>task.assignment_mode==='round_robin'&&task.is_recurring
    &&!task.assignment_group_json&&Number(task.rotation_slot)>=0&&Number(task.rotation_slot)<roster.length
    &&same(members.all(task.id).map(row=>row.user_id),roster));
  if(valid)for(const row of d.prepare(`SELECT definition_json FROM task_recurrence_definitions
      WHERE json_extract(definition_json,'$.task.rotation_group')=? COLLATE NOCASE`).all(sourceKey)){
    const definition=JSON.parse(row.definition_json);
    if(!same(ids(definition.rotation_user_ids),roster)){
      valid=false;break;
    }
  }
  d.prepare('UPDATE legacy_rotation_group_mappings SET is_current=? WHERE group_id=?').run(valid?1:0,mapping.group_id);
  d.prepare(`UPDATE rotation_compatibility_review SET status=? WHERE source_type='task' AND source_value=? COLLATE NOCASE`)
    .run(valid?'resolved':'requires_review',sourceKey);
  d.prepare(`UPDATE rotation_compatibility_review SET status=? WHERE source_type='recurrence_definition' AND source_value=? COLLATE NOCASE`)
    .run(valid?'resolved':'requires_review',sourceKey);
}
