/** Add ordinary completion choices without rewriting old completion evidence. */
export function addTaskCompletionChoiceSchema(d) {
  d.exec(`ALTER TABLE tasks ADD COLUMN completion_kept_subtasks INTEGER NOT NULL DEFAULT 0 CHECK(completion_kept_subtasks IN (0,1));
    CREATE TABLE task_completion_choices (
      task_id INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      first_completed_at TEXT NOT NULL,
      recurrence_handled INTEGER NOT NULL DEFAULT 0 CHECK(recurrence_handled IN (0,1)),
      legacy_incomplete INTEGER NOT NULL DEFAULT 0 CHECK(legacy_incomplete IN (0,1)),
      completion_recorded INTEGER NOT NULL DEFAULT 1 CHECK(completion_recorded IN (0,1))
    );
    INSERT INTO task_completion_choices(task_id,first_completed_at,recurrence_handled,legacy_incomplete,completion_recorded)
      SELECT t.id,COALESCE(t.closed_incomplete_at,c.first_closed_at,t.created_at),COALESCE(c.recurrence_handled,0),1,0
      FROM tasks t LEFT JOIN task_incomplete_closures c ON c.task_id=t.id WHERE t.status='closed_incomplete';
    UPDATE tasks SET status='done',completion_kept_subtasks=1 WHERE status='closed_incomplete';
  `);
  // Keep the compatibility constraint, timestamps, receipts, recurrence anchors
  // and historical events. Migration must never call completion/reward writers.
}
