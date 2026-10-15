/** Additive only: no inferred limits, assignments, recurrence or award backfill. */
export function addTaskAssigneePolicySchema(d) {
  if(!d.prepare('PRAGMA table_info(task_categories)').all().some(column=>column.name==='max_assignees'))
    d.exec(`ALTER TABLE task_categories ADD COLUMN max_assignees INTEGER
      CHECK(max_assignees IS NULL OR (typeof(max_assignees)='integer' AND max_assignees BETWEEN 1 AND 9007199254740991))`);
  d.exec(`CREATE TABLE IF NOT EXISTS task_assignee_policies (
    task_id INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    policy_version INTEGER NOT NULL CHECK(policy_version=1),
    category_key TEXT NOT NULL,
    max_assignees INTEGER CHECK(max_assignees IS NULL OR (typeof(max_assignees)='integer' AND max_assignees BETWEEN 1 AND 9007199254740991))
  );
  CREATE TABLE IF NOT EXISTS task_direct_assignees (
    task_id INTEGER NOT NULL REFERENCES task_assignee_policies(task_id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY(task_id,user_id)
  );`);
}
