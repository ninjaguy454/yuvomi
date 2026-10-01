/** Append-only migration 10047: proposals and amended outstanding attribution. */
export function addMealCycleAdjustmentSchema(d) {
 d.exec(`CREATE TABLE meal_cycle_adjustments (
  id INTEGER PRIMARY KEY, cycle_id INTEGER NOT NULL REFERENCES meal_cycles(id),
  actor_id INTEGER NOT NULL REFERENCES users(id), status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','superseded','canceled','applied')),
  source_fingerprint TEXT NOT NULL, permission_fingerprint TEXT NOT NULL,
  protected_fingerprint TEXT NOT NULL, source_change_id INTEGER REFERENCES meal_cycle_source_changes(id),
  batches_json TEXT NOT NULL, preview_json TEXT NOT NULL, result_id INTEGER REFERENCES meal_cycle_results(id),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 );
 CREATE INDEX idx_cycle_adjustments_pending ON meal_cycle_adjustments(cycle_id,status);
 CREATE TABLE meal_grocery_output_state (
  grocery_item_id INTEGER PRIMARY KEY REFERENCES meal_grocery_items(id) ON DELETE CASCADE,
  credited_quantity REAL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)),
  shopping_json TEXT NOT NULL
 );
 CREATE TABLE meal_cycle_pending_occurrences (
  meal_id INTEGER PRIMARY KEY REFERENCES meals(id), cycle_id INTEGER NOT NULL REFERENCES meal_cycles(id),
  accepted_revision INTEGER
 );
 CREATE TABLE meal_cycle_adjustment_submissions (
  link_id INTEGER PRIMARY KEY REFERENCES meal_cycle_task_links(id),
  proposal_id INTEGER NOT NULL REFERENCES meal_cycle_adjustments(id),
  signature TEXT NOT NULL
 );`);
 // Old outputs have no trustworthy unedited baseline: treat them as protected.
}
