import {taskScoringRoot,taskScoringRows,taskScoringIdentity,taskRewardDefinition,recordTaskScoringSettlement} from './task-scoring.js';

/** Append-only history-safe upgrade. No ledger or existing claim is rewritten. */
export function addTaskScoringSchema(d){
  const columns=d.prepare('PRAGMA table_info(tasks)').all(),first=!columns.some(c=>c.name==='scoring_mode');
  if(first)d.exec(`ALTER TABLE tasks ADD COLUMN scoring_mode TEXT NOT NULL DEFAULT 'legacy' CHECK(scoring_mode IN ('whole_task','subtasks','legacy'));
    ALTER TABLE tasks ADD COLUMN scoring_review_required INTEGER NOT NULL DEFAULT 0 CHECK(scoring_review_required IN (0,1));`);
  d.exec(`CREATE TABLE IF NOT EXISTS task_scoring_settlements(
    id INTEGER PRIMARY KEY AUTOINCREMENT, logical_key TEXT NOT NULL,claim_key TEXT NOT NULL UNIQUE,
    task_id INTEGER NOT NULL, root_task_id INTEGER NOT NULL, root_logical_key TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('whole_task','subtasks','legacy')),points INTEGER,
    recipients_json TEXT NOT NULL DEFAULT '[]', earned_once INTEGER NOT NULL DEFAULT 0 CHECK(earned_once IN (0,1)),
    outcome TEXT NOT NULL CHECK(outcome IN ('earned','zero','no_recipients','suppressed','historical_unrewarded','historical_claim')),
    settled_at TEXT NOT NULL, visibility_json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_task_scoring_root ON task_scoring_settlements(root_task_id);
    CREATE INDEX IF NOT EXISTS idx_task_scoring_root_identity ON task_scoring_settlements(root_logical_key);
    CREATE INDEX IF NOT EXISTS idx_task_scoring_logical ON task_scoring_settlements(logical_key);
    CREATE TABLE IF NOT EXISTS task_scoring_settlement_releases(
      settlement_id INTEGER PRIMARY KEY,logical_key TEXT NOT NULL,actor_user_id INTEGER,reason TEXT NOT NULL,released_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_task_scoring_release_logical ON task_scoring_settlement_releases(logical_key);
    CREATE TRIGGER IF NOT EXISTS trg_task_scoring_release_immutable_update BEFORE UPDATE ON task_scoring_settlement_releases BEGIN SELECT RAISE(ABORT,'Task scoring releases are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_task_scoring_release_immutable_delete BEFORE DELETE ON task_scoring_settlement_releases BEGIN SELECT RAISE(ABORT,'Task scoring releases are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_task_scoring_settlement_immutable_update BEFORE UPDATE ON task_scoring_settlements BEGIN SELECT RAISE(ABORT,'Task scoring settlements are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_task_scoring_settlement_immutable_delete BEFORE DELETE ON task_scoring_settlements BEGIN SELECT RAISE(ABORT,'Task scoring settlements are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_tasks_scoring_revision AFTER UPDATE OF scoring_mode,scoring_review_required ON tasks
      WHEN NEW.scoring_mode IS NOT OLD.scoring_mode OR NEW.scoring_review_required IS NOT OLD.scoring_review_required
      BEGIN UPDATE tasks SET revision=revision+1 WHERE id=NEW.id; END;`);
  if(!first)return;
  const tasks=d.prepare('SELECT * FROM tasks ORDER BY id').all(),roots=new Map();
  for(const task of tasks){const root=taskScoringRoot(d,task.id);if(root)roots.set(root.id,root);}
  for(const root of roots.values()){
    const rows=taskScoringRows(d,root),children=rows.filter(row=>row.id!==root.id);
    const container=!!d.prepare('SELECT 1 FROM workflow_instances WHERE parent_task_id=?').get(root.id);
    const nested=children.some(row=>row.parent_task_id!==root.id),parentPositive=root.points>0,childPositive=children.some(row=>row.points>0);
    let mode=parentPositive&&childPositive||nested||container?'legacy':childPositive?'subtasks':'whole_task';
    const evidence=rows.map(row=>({task_id:row.id,
      earns:d.prepare("SELECT task_id FROM reward_ledger WHERE task_id=? AND type='earn' AND delta>0").all(row.id),
      claimed:!!d.prepare('SELECT 1 FROM reward_task_awards WHERE task_id=?').get(row.id)}));
    // A durable claim proves an award source even after recipient deletion
    // removes its ledger. Missing original terms require conservative review.
    const history=evidence.filter(row=>row.claimed||row.earns.length);
    if(evidence.some(row=>row.claimed&&!row.earns.length)||history.some(row=>mode==='whole_task'&&row.task_id!==root.id||mode==='subtasks'&&row.task_id===root.id))mode='legacy';
    d.prepare('UPDATE tasks SET scoring_mode=?,scoring_review_required=? WHERE id=?').run(mode,mode==='legacy'?1:0,root.id);
  }
  for(const task of tasks){
    const root=taskScoringRoot(d,task.id);if(!root)continue;
    const history=d.prepare("SELECT user_id,delta,created_at FROM reward_ledger WHERE task_id=? AND type='earn' ORDER BY id").all(task.id);
    const claim=d.prepare('SELECT * FROM reward_task_awards WHERE task_id=?').get(task.id);
    const completed=task.status==='done'||!!d.prepare('SELECT 1 FROM task_completions WHERE task_id=?').get(task.id)
      ||!!d.prepare("SELECT 1 FROM task_activity_events WHERE action_task_id=? AND event_type='completed'").get(task.id);
    if(!history.length&&!claim&&!completed)continue;
    const definition=taskRewardDefinition(d,task,{root}),amounts=[...new Set(history.map(row=>row.delta))];
    const settledAt=history[0]?.created_at||claim?.awarded_at||d.prepare('SELECT completed_at FROM task_completions WHERE task_id=? ORDER BY completed_at LIMIT 1').get(task.id)?.completed_at||task.updated_at||task.created_at;
    recordTaskScoringSettlement(d,{...definition,points:history.length?(amounts.length===1?amounts[0]:null):claim?null:task.points},claim?.logical_key||taskScoringIdentity(d,task.id),
      {outcome:history.length?'earned':claim?'historical_claim':'historical_unrewarded',awardedRecipients:history.map(row=>({user_id:row.user_id,points:row.delta})),settledAt,earnedOnce:!!claim||history.some(row=>row.delta>0),claimKey:JSON.stringify(['history',task.id])});
  }
  // The ledger's old Task FK may already have detached a deleted work unit.
  // A retained recurring action still proves its occurrence, but never proves
  // an amount or recipient. Preserve that lock without inventing either.
  for(const claim of d.prepare(`SELECT r.*,a.occurrence_task_id FROM reward_task_awards r
    JOIN task_recurrence_actions a ON a.task_id=r.task_id LEFT JOIN tasks t ON t.id=r.task_id WHERE t.id IS NULL`).all()){
    const root=taskScoringRoot(d,claim.occurrence_task_id);if(!root)continue;
    d.prepare("UPDATE tasks SET scoring_mode='legacy',scoring_review_required=1 WHERE id=?").run(root.id);root.scoring_mode='legacy';root.scoring_review_required=1;
    const task={id:claim.task_id,points:null,visibility:'private',created_by:null,assigned_to:null};
    recordTaskScoringSettlement(d,{task,root,mode:'legacy',points:null,targets:[],outcome:'historical_claim'},claim.logical_key||taskScoringIdentity(d,claim.task_id),
      {outcome:'historical_claim',awardedRecipients:[],settledAt:claim.awarded_at,earnedOnce:true,claimKey:JSON.stringify(['history',claim.task_id])});
  }
  // Preserve only the existing audited explicit correction exception. A bare
  // retirement/archive flag and an unlinked adjustment never authorize release.
  for(const claim of d.prepare('SELECT * FROM reward_task_awards WHERE retired_at IS NOT NULL').all()){
    const earns=d.prepare("SELECT * FROM reward_ledger WHERE task_id=? AND type='earn'").all(claim.task_id);
    if(!earns.length||!earns.every(earn=>Number(earn.delta)+Number(d.prepare(`SELECT COALESCE(SUM(l.delta),0) AS delta FROM reward_adjustment_requests a
      JOIN reward_ledger l ON l.id=a.ledger_id WHERE a.related_ledger_id=? AND l.user_id=? AND l.type='adjust'`).get(earn.id,earn.user_id).delta)===0))continue;
    d.prepare(`INSERT OR IGNORE INTO task_scoring_settlement_releases(settlement_id,logical_key,actor_user_id,reason,released_at)
      SELECT id,logical_key,NULL,?,? FROM task_scoring_settlements WHERE task_id=?`).run(claim.retirement_reason||'Historical linked correction',claim.retired_at,claim.task_id);
  }
}
