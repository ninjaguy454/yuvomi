/** Empty on upgrade: receipts describe only explicitly requested new launches. */
export function addTaskTemplateLaunchSchema(d){
  d.exec(`CREATE TABLE task_template_launch_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    principal_key TEXT NOT NULL,
    request_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    activity_template_id INTEGER NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('individual','shared')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(principal_key,request_key)
  );
  CREATE TABLE task_template_launch_results (
    request_id INTEGER NOT NULL REFERENCES task_template_launch_requests(id),
    position INTEGER NOT NULL,
    task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
    PRIMARY KEY(request_id,position)
  ) WITHOUT ROWID;
  CREATE INDEX idx_task_template_launch_results_task ON task_template_launch_results(task_id);`);
}
