/** Additive only: legacy Trips never acquire a generation record. */
export function addTripTaskSchema(d) {
 d.exec(`
 CREATE TABLE trip_task_groups (
  trip_id INTEGER PRIMARY KEY REFERENCES trip_plans(id) ON DELETE CASCADE,
  parent_task_id INTEGER UNIQUE REFERENCES tasks(id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','cancelled','deleted')),
  revision INTEGER NOT NULL DEFAULT 1,
  coordinator_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  generated_json TEXT NOT NULL DEFAULT '{}'
 );
 CREATE TABLE trip_task_steps (
  trip_id INTEGER NOT NULL REFERENCES trip_plans(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  task_id INTEGER UNIQUE REFERENCES tasks(id) ON DELETE SET NULL,
  phase TEXT NOT NULL,
  recipe_json TEXT NOT NULL,
  generated_json TEXT NOT NULL DEFAULT '{}',
  overrides_json TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','removed','cancelled','deleted')),
  PRIMARY KEY(trip_id,step_key)
 );
 CREATE TABLE trip_task_requests (
  actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_key TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  trip_id INTEGER REFERENCES trip_plans(id) ON DELETE SET NULL,
  PRIMARY KEY(actor_id,request_key)
 );
 CREATE TABLE trip_step_reminders (
  trip_id INTEGER NOT NULL,step_key TEXT NOT NULL,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reminder_id INTEGER REFERENCES reminders(id) ON DELETE SET NULL,
  offset_minutes INTEGER NOT NULL,
  generated_remind_at TEXT,
  PRIMARY KEY(trip_id,step_key,user_id),
  FOREIGN KEY(trip_id,step_key) REFERENCES trip_task_steps(trip_id,step_key) ON DELETE CASCADE
 );
 CREATE TABLE retired_trip_tasks (
  task_id INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  reason TEXT NOT NULL
 );
 CREATE TRIGGER trip_generated_task_deleted BEFORE DELETE ON tasks BEGIN
  UPDATE trip_task_groups SET state='deleted',revision=revision+1 WHERE parent_task_id=OLD.id;
  UPDATE trip_task_steps SET state='deleted' WHERE task_id=OLD.id;
 END;
 `);
}
