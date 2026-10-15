/** New audit state only. Existing awards, balances and incomplete work stay untouched. */
export function addTaskScoringCompletionSchema(d){
  d.exec(`CREATE TABLE task_scoring_completion_events (
    settlement_id INTEGER NOT NULL REFERENCES task_scoring_settlements(id),
    sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence>0),
    active INTEGER NOT NULL CHECK(active IN (0,1)),
    task_id INTEGER NOT NULL,
    task_revision INTEGER NOT NULL,
    actor_user_id INTEGER,
    status TEXT NOT NULL CHECK(status IN ('open','in_progress','done')),
    entries_json TEXT NOT NULL CHECK(json_valid(entries_json) AND json_type(entries_json)='array'),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY(settlement_id,sequence)
  ) WITHOUT ROWID;
  CREATE TRIGGER trg_task_scoring_completion_events_immutable_update BEFORE UPDATE ON task_scoring_completion_events
    BEGIN SELECT RAISE(ABORT,'Task completion reward events are immutable'); END;
  CREATE TRIGGER trg_task_scoring_completion_events_immutable_delete BEFORE DELETE ON task_scoring_completion_events
    BEGIN SELECT RAISE(ABORT,'Task completion reward events are immutable'); END;`);
}
