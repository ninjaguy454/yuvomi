/** Durable occurrence identity. Task deletion must not split a recurring series.
 * This module intentionally has no database singleton or lifecycle imports so
 * the additive migration and explicit reconciliation use the same provenance. */
export const RECURRENCE_PROVENANCE_SQL = `
  CREATE TABLE task_recurrence_occurrences (
    task_id INTEGER PRIMARY KEY,
    series_id INTEGER NOT NULL,
    predecessor_task_id INTEGER,
    generation INTEGER NOT NULL,
    occurrence_key TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'materialized' CHECK(state IN ('materialized','deleted','retired')),
    retired_at TEXT,
    retirement_reason TEXT
  );
  CREATE UNIQUE INDEX idx_task_recurrence_materialized_key
    ON task_recurrence_occurrences(series_id,occurrence_key) WHERE state='materialized';
  CREATE INDEX idx_task_recurrence_frontier
    ON task_recurrence_occurrences(series_id,state,generation);
  CREATE TABLE task_recurrence_actions (
    task_id INTEGER PRIMARY KEY,
    occurrence_task_id INTEGER NOT NULL,
    action_key TEXT NOT NULL
  );
  CREATE INDEX idx_task_recurrence_actions_occurrence ON task_recurrence_actions(occurrence_task_id);
  CREATE TRIGGER trg_task_recurrence_deleted AFTER DELETE ON tasks
    BEGIN UPDATE task_recurrence_occurrences SET state='deleted' WHERE task_id=OLD.id AND state='materialized'; END;
`;

function occurrenceKey(task) { return task.due_date || task.start_date || `task:${task.id}`; }
const read = (d,id) => d.prepare('SELECT * FROM task_recurrence_occurrences WHERE task_id=?').get(id);

/** Migrate proven links only. Frozen completion series can bridge an older
 * deleted predecessor; otherwise a severed legacy chain remains independent.
 * Duplicate materialized dates are ambiguous and deliberately stop migration. */
export function backfillRecurrenceProvenance(d) {
  const rows=d.prepare(`SELECT t.*,c.series_id AS completion_series_id FROM tasks t
    LEFT JOIN task_completions c ON c.task_id=t.id WHERE t.parent_task_id IS NULL ORDER BY t.id`).all();
  const byId=new Map(rows.map(row=>[row.id,row]));
  const links=new Map();
  const find=id=>{if(!links.has(id))links.set(id,id);let root=id;while(links.get(root)!==root)root=links.get(root);
    while(links.get(id)!==id){const next=links.get(id);links.set(id,root);id=next;}return root;};
  const join=(a,b)=>{const ra=find(a),rb=find(b);if(ra!==rb)links.set(Math.max(ra,rb),Math.min(ra,rb));};
  const existing=new Map(d.prepare('SELECT * FROM task_recurrence_occurrences').all().map(row=>[row.task_id,row]));
  const successors=new Map();
  for(const row of rows) {
    if(row.recurrence_origin_id && (!existing.has(row.id)||existing.get(row.id).state==='materialized')) {
      const other=successors.get(row.recurrence_origin_id);
      if(other)throw new Error(`Recurring predecessor ${row.recurrence_origin_id} has ambiguous branches: Tasks ${other} and ${row.id}.`);
      successors.set(row.recurrence_origin_id,row.id);
      // A generated successor is always inserted after its predecessor. A
      // backwards link means a cycle or edited/ambiguous legacy provenance.
      if(row.recurrence_origin_id>=row.id)throw new Error(`Recurring Task ${row.id} has invalid predecessor ${row.recurrence_origin_id}.`);
      if(!byId.has(row.recurrence_origin_id)&&d.prepare('SELECT 1 FROM tasks WHERE id=?').get(row.recurrence_origin_id))
        throw new Error(`Recurring Task ${row.id} points to a subtask as its predecessor.`);
    }
    if(row.recurrence_origin_id)join(row.id,row.recurrence_origin_id);
    if(row.completion_series_id)join(row.id,row.completion_series_id);
    if(existing.has(row.id))join(row.id,existing.get(row.id).series_id);
  }
  const activeRoots=new Set(rows.filter(row=>row.is_recurring||row.recurrence_origin_id||existing.has(row.id)).map(row=>find(row.id)));
  const groups=new Map();
  for(const row of rows)if(activeRoots.has(find(row.id))){const key=find(row.id);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
  const insert=d.prepare(`INSERT INTO task_recurrence_occurrences(task_id,series_id,predecessor_task_id,generation,occurrence_key)
    VALUES(?,?,?,?,?)`);
  for(const [seriesId,members] of groups)for(let index=0;index<members.length;index++) {
    const row=members[index];if(existing.has(row.id))continue;
    const key=occurrenceKey(row);
    const duplicate=d.prepare("SELECT task_id FROM task_recurrence_occurrences WHERE series_id=? AND occurrence_key=? AND state='materialized'").get(seriesId,key);
    if(duplicate)throw new Error(`Recurring series ${seriesId} has ambiguous materialized occurrence ${key}: Tasks ${duplicate.task_id} and ${row.id}.`);
    insert.run(row.id,seriesId,row.recurrence_origin_id||null,index,key);
  }
}

export function registerRecurrenceOccurrence(d,taskId,{predecessorId=null}={}) {
  const present=read(d,taskId);if(present)return present;
  const task=d.prepare('SELECT * FROM tasks WHERE id=? AND parent_task_id IS NULL').get(taskId);
  if(!task||(!task.is_recurring&&!task.recurrence_origin_id&&!predecessorId))return null;
  const priorId=predecessorId||task.recurrence_origin_id;
  if(priorId) {
    const predecessor=read(d,priorId)||registerRecurrenceOccurrence(d,priorId);
    if(predecessor) {
      d.prepare(`INSERT INTO task_recurrence_occurrences(task_id,series_id,predecessor_task_id,generation,occurrence_key)
        VALUES(?,?,?,?,?)`).run(task.id,predecessor.series_id,priorId,predecessor.generation+1,occurrenceKey(task));
      return read(d,taskId);
    }
  }
  backfillRecurrenceProvenance(d);
  return read(d,taskId)||null;
}

export function recurrenceFrontier(d,taskId) {
  const occurrence=read(d,taskId)||registerRecurrenceOccurrence(d,taskId);
  if(!occurrence)return null;
  return d.prepare(`SELECT t.* FROM task_recurrence_occurrences o JOIN tasks t ON t.id=o.task_id
    WHERE o.series_id=? AND o.state='materialized' ORDER BY o.generation DESC,o.task_id DESC LIMIT 1`).get(occurrence.series_id)||null;
}

export function isRecurrenceFrontier(d,taskId) {return recurrenceFrontier(d,taskId)?.id===Number(taskId);}

/** Expiration closes the occurrence without asserting successful completion.
 * Its provenance remains materialized: archived or expired history must still
 * prevent an older occurrence from regenerating the same calendar slot. */
export function isTerminalRecurrenceOccurrence(task) {
  return Boolean(task && (task.status === 'done' || task.status === 'expired' || task.expired_at));
}

/** Original action lineage survives deletion just like occurrence lineage.
 * A copied child inherits only its explicit predecessor's identity, never its
 * title, position, skill or due date. Helper projections are not reward work. */
export function registerRecurrenceAction(d,taskId,seen=new Set()) {
  const existing=d.prepare('SELECT * FROM task_recurrence_actions WHERE task_id=?').get(taskId);if(existing)return existing;
  if(seen.has(taskId))throw new Error(`Recurring action ${taskId} has cyclic predecessor provenance.`);
  seen.add(taskId);
  const task=d.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);if(!task)return null;
  if(d.prepare(`SELECT 1 FROM task_activity_support_tasks WHERE task_id=?
    UNION ALL SELECT 1 FROM task_supervision_actions WHERE counterpart_task_id=? LIMIT 1`).get(taskId,taskId))return null;
  let root=task;const ancestors=new Set();
  while(root.parent_task_id&&!ancestors.has(root.id)) {ancestors.add(root.id);root=d.prepare('SELECT * FROM tasks WHERE id=?').get(root.parent_task_id);if(!root)return null;}
  if(root.parent_task_id)return null;
  const occurrence=read(d,root.id)||registerRecurrenceOccurrence(d,root.id);if(!occurrence)return null;
  let actionKey='root';
  if(task.id!==root.id) {
    const prior=task.recurrence_origin_id?registerRecurrenceAction(d,task.recurrence_origin_id,seen):null;
    actionKey=prior?.action_key||`action:${task.id}`;
  }
  d.prepare('INSERT INTO task_recurrence_actions(task_id,occurrence_task_id,action_key) VALUES(?,?,?)').run(taskId,root.id,actionKey);
  return d.prepare('SELECT * FROM task_recurrence_actions WHERE task_id=?').get(taskId);
}

export function rewardOccurrenceProvenance(d,taskId) {
  const action=registerRecurrenceAction(d,taskId);
  if(!action)return {logicalKey:JSON.stringify(['task',taskId]),retired:false};
  const occurrence=read(d,action.occurrence_task_id);
  return {logicalKey:JSON.stringify(['recurrence',occurrence.series_id,occurrence.occurrence_key,action.action_key]),retired:occurrence.state==='retired'};
}

export function backfillRecurrenceAwardProvenance(d) {
  for(const row of d.prepare('SELECT id FROM tasks ORDER BY id').all())registerRecurrenceAction(d,row.id);
  for(const row of d.prepare('SELECT task_id FROM reward_task_awards WHERE logical_key IS NULL ORDER BY task_id').all()) {
    const {logicalKey}=rewardOccurrenceProvenance(d,row.task_id);
    const duplicate=d.prepare('SELECT task_id FROM reward_task_awards WHERE logical_key=? AND retired_at IS NULL').get(logicalKey);
    if(duplicate)throw new Error(`Ambiguous recurring award provenance: Tasks ${duplicate.task_id} and ${row.task_id} already earned the same logical action.`);
    d.prepare('UPDATE reward_task_awards SET logical_key=? WHERE task_id=?').run(logicalKey,row.task_id);
  }
}

/** Only an explicit, fully compensated correction can release a retired
 * logical occurrence. Ordinary deletion/archive/retirement cannot farm points.
 * Historical receipt and earn rows remain intact, including their first actor. */
export function releaseCorrectedRetiredAwards(d,taskIds,{actorId,reason}={}) {
  if(!Number.isInteger(actorId)||!String(reason||'').trim())throw new Error('An actor and correction reason are required.');
  return d.transaction(()=>{
    const released=[];
    for(const id of [...new Set(taskIds.map(Number))]) {
      if(read(d,id)?.state!=='retired')throw new Error(`Occurrence ${id} must be explicitly retired before its award can be corrected.`);
      const receipts=d.prepare(`SELECT r.* FROM reward_task_awards r JOIN task_recurrence_actions a ON a.task_id=r.task_id
        WHERE a.occurrence_task_id=? AND r.retired_at IS NULL`).all(id);
      for(const receipt of receipts) {
        const earns=d.prepare("SELECT * FROM reward_ledger WHERE type='earn' AND task_id=?").all(receipt.task_id);
        if(!earns.length)throw new Error(`Award ${receipt.task_id} has no intact earning evidence; refusing to release it.`);
        for(const earn of earns) {
          const correction=d.prepare(`SELECT COALESCE(SUM(l.delta),0) AS delta FROM reward_adjustment_requests a
            JOIN reward_ledger l ON l.id=a.ledger_id WHERE a.related_ledger_id=? AND l.user_id=? AND l.type='adjust'`).get(earn.id,earn.user_id);
          if(Number(earn.delta)+Number(correction.delta)!==0)throw new Error(`Earning ${earn.id} must be fully offset by a linked adjustment before a replacement can earn points.`);
        }
        d.prepare("UPDATE reward_task_awards SET retired_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),retirement_reason=? WHERE task_id=?").run(reason,receipt.task_id);
        released.push(receipt.task_id);
      }
      if(receipts.length)d.prepare(`INSERT INTO task_activity_events(task_id,action_task_id,actor_user_id,event_type,details_json)
        VALUES(?,?,?,'recurrence_award_corrected',?)`).run(id,id,actorId,JSON.stringify({title:`Occurrence points corrected: ${reason}`,reason,award_task_ids:receipts.map(row=>row.task_id)}));
    }
    return released;
  }).immediate();
}

export function retiredRecurrenceOccurrence(d,taskId) {
  return d.prepare(`WITH RECURSIVE roots(id) AS (
    SELECT ? UNION SELECT source_task_id FROM task_activity_support_tasks WHERE task_id=?
    UNION SELECT source_task_id FROM task_supervision_actions WHERE counterpart_task_id=? OR action_task_id=?
  ), ancestry(id) AS (SELECT id FROM roots UNION SELECT t.parent_task_id FROM tasks t JOIN ancestry a ON t.id=a.id WHERE t.parent_task_id IS NOT NULL)
    SELECT o.* FROM task_recurrence_occurrences o JOIN ancestry a ON a.id=o.task_id WHERE o.state='retired' LIMIT 1`).get(taskId,taskId,taskId,taskId)||null;
}

/** Explicit repair operation; ordinary archive never changes frontier identity.
 * Preserve original status, completion evidence, rewards, comments and links.
 * No historical ownership or progress is synthesized. */
export function retireRecurrenceOccurrences(d,taskIds,{actorId,reason}={}) {
  if(!Number.isInteger(actorId)||!String(reason||'').trim())throw new Error('An actor and a retirement reason are required.');
  return d.transaction(()=>{
    const changed=[];
    for(const id of [...new Set(taskIds.map(Number))]) {
      const occurrence=read(d,id)||registerRecurrenceOccurrence(d,id);
      if(!occurrence)throw new Error(`Task ${id} is not a proven recurring occurrence.`);
      if(occurrence.state==='retired')continue;
      if(occurrence.state!=='materialized')throw new Error(`Task ${id} is no longer materialized.`);
      const task=d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
      if(!task)throw new Error(`Task ${id} no longer exists.`);
      d.prepare(`UPDATE task_recurrence_occurrences SET state='retired',retired_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),
        retirement_reason=? WHERE task_id=?`).run(reason,id);
      d.prepare(`WITH RECURSIVE roots(id) AS (SELECT ?
        UNION SELECT task_id FROM task_activity_support_tasks WHERE source_task_id=?
        UNION SELECT counterpart_task_id FROM task_supervision_actions WHERE source_task_id=? AND counterpart_task_id IS NOT NULL),
        tree(id) AS (SELECT id FROM roots UNION SELECT t.id FROM tasks t JOIN tree p ON t.parent_task_id=p.id)
        UPDATE tasks SET archived_at=COALESCE(archived_at,strftime('%Y-%m-%dT%H:%M:%SZ','now')) WHERE id IN tree`).run(id,id,id);
      d.prepare(`INSERT INTO task_activity_events(task_id,action_task_id,actor_user_id,event_type,details_json)
        VALUES(?,?,?,'recurrence_retired',?)`).run(id,id,actorId,JSON.stringify({title:`Occurrence retired: ${reason}`,reason,series_id:occurrence.series_id,occurrence_key:occurrence.occurrence_key,preserved_status:task.status}));
      changed.push(id);
    }
    return changed;
  }).immediate();
}
