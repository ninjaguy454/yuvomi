/** Additive migration; shipped cycle schema is intentionally unchanged. */
export function addMealCycleFinalizationSchema(d) {
  d.exec(`
    ALTER TABLE meal_grocery_runs ADD COLUMN meal_ids_json TEXT
      CHECK(meal_ids_json IS NULL OR (json_valid(meal_ids_json) AND json_type(meal_ids_json)='array'));
    CREATE TABLE meal_cycle_gap_acknowledgments (
      cycle_id INTEGER NOT NULL REFERENCES meal_cycles(id),
      meal_id INTEGER NOT NULL REFERENCES meals(id),
      fingerprint TEXT NOT NULL, actor_id INTEGER NOT NULL REFERENCES users(id),
      acknowledged_at TEXT NOT NULL, PRIMARY KEY(cycle_id,meal_id)
    );
    CREATE TABLE meal_cycle_generation_failures (
      settings_revision INTEGER NOT NULL, period_start TEXT NOT NULL,
      code TEXT NOT NULL, message TEXT NOT NULL, last_attempt_at TEXT NOT NULL,
      PRIMARY KEY(settings_revision,period_start)
    );
  `);
}
