/** Additive household cycle persistence. Does not seed household settings or Tasks. */
export function addMealCycleSchema(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS meal_cycle_settings (
      household_key TEXT PRIMARY KEY DEFAULT 'household' CHECK(household_key='household'),
      revision INTEGER NOT NULL CHECK(revision>0),
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
      settings_json TEXT NOT NULL CHECK(json_valid(settings_json) AND json_type(settings_json)='object'),
      updated_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS meal_cycles (
      id INTEGER PRIMARY KEY,
      household_key TEXT NOT NULL DEFAULT 'household' CHECK(household_key='household'),
      period_start TEXT NOT NULL, period_end TEXT NOT NULL CHECK(period_end>=period_start),
      timezone TEXT NOT NULL,
      settings_json TEXT NOT NULL CHECK(json_valid(settings_json) AND json_type(settings_json)='object'),
      settings_revision INTEGER NOT NULL DEFAULT 0 CHECK(settings_revision>=0),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
      state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','finalized')),
      finalization_mode TEXT NOT NULL DEFAULT 'manual' CHECK(finalization_mode IN ('manual','automatic')),
      creation_at TEXT NOT NULL, response_at TEXT NOT NULL, confirmation_at TEXT NOT NULL, shopping_at TEXT NOT NULL,
      source_revision INTEGER NOT NULL DEFAULT 0 CHECK(source_revision>=0), source_fingerprint TEXT,
      attempt_status TEXT NOT NULL DEFAULT 'pending' CHECK(attempt_status IN ('pending','blocked','failed','ready','finalized','paused','review_required')),
      attempt_fingerprint TEXT, last_attempt_at TEXT, next_attempt_at TEXT,
      blockers_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(blockers_json) AND json_type(blockers_json)='array'),
      finalized_revision INTEGER, finalized_at TEXT, pending_adjustment_id INTEGER,
      created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(household_key,period_start), CHECK(finalized_revision IS NULL OR finalized_revision>0)
    );
    CREATE INDEX IF NOT EXISTS idx_meal_cycles_due ON meal_cycles(state,finalization_mode,confirmation_at);
    CREATE TABLE IF NOT EXISTS meal_cycle_memberships (
      cycle_id INTEGER NOT NULL REFERENCES meal_cycles(id) ON DELETE RESTRICT,
      meal_id INTEGER NOT NULL UNIQUE REFERENCES meals(id) ON DELETE RESTRICT,
      PRIMARY KEY(cycle_id,meal_id)
    );
    CREATE TABLE IF NOT EXISTS meal_cycle_task_links (
      id INTEGER PRIMARY KEY,
      cycle_id INTEGER NOT NULL REFERENCES meal_cycles(id) ON DELETE RESTRICT,
      purpose TEXT NOT NULL CHECK(purpose IN ('personal','review','shopping','correction','automatic_followup')),
      beneficiary_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      obligation_key TEXT NOT NULL DEFAULT 'primary',
      task_id INTEGER NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE RESTRICT,
      supersedes_link_id INTEGER REFERENCES meal_cycle_task_links(id) ON DELETE RESTRICT,
      obligations_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(obligations_json) AND json_type(obligations_json)='array'),
      submission_revision INTEGER CHECK(submission_revision IS NULL OR submission_revision>0),
      state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','superseded')),
      UNIQUE(cycle_id,purpose,beneficiary_id,obligation_key)
    );
    CREATE TABLE IF NOT EXISTS meal_cycle_requests (
      id INTEGER PRIMARY KEY,
      scope_key TEXT NOT NULL, operation TEXT NOT NULL, request_key TEXT NOT NULL,
      cycle_id INTEGER REFERENCES meal_cycles(id) ON DELETE RESTRICT,
      actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      expected_revision INTEGER NOT NULL CHECK(expected_revision>=0), payload_hash TEXT NOT NULL,
      result_json TEXT CHECK(result_json IS NULL OR (json_valid(result_json) AND json_type(result_json)='object')),
      created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(scope_key,operation,request_key)
    );
    CREATE TABLE IF NOT EXISTS meal_cycle_results (
      id INTEGER PRIMARY KEY,
      cycle_id INTEGER NOT NULL REFERENCES meal_cycles(id) ON DELETE RESTRICT,
      kind TEXT NOT NULL CHECK(kind IN ('finalization','adjustment','proposal','reschedule')),
      request_key TEXT NOT NULL, input_fingerprint TEXT NOT NULL,
      source_revision INTEGER NOT NULL DEFAULT 0 CHECK(source_revision>=0),
      input_json TEXT NOT NULL CHECK(json_valid(input_json) AND json_type(input_json)='object'),
      output_json TEXT NOT NULL CHECK(json_valid(output_json) AND json_type(output_json)='object'),
      actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT, reason TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(cycle_id,kind,request_key)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_meal_cycle_one_finalization ON meal_cycle_results(cycle_id) WHERE kind='finalization';
    CREATE TRIGGER IF NOT EXISTS meal_cycle_results_no_update BEFORE UPDATE ON meal_cycle_results
      BEGIN SELECT RAISE(ABORT,'Meal cycle results are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS meal_cycle_results_no_delete BEFORE DELETE ON meal_cycle_results
      BEGIN SELECT RAISE(ABORT,'Meal cycle results are immutable'); END;
    CREATE TABLE IF NOT EXISTS meal_cycle_events (
      id INTEGER PRIMARY KEY, dedup_key TEXT NOT NULL UNIQUE,
      cycle_id INTEGER REFERENCES meal_cycles(id) ON DELETE RESTRICT,
      scope_json TEXT NOT NULL CHECK(json_valid(scope_json) AND json_type(scope_json)='object'),
      source_revision TEXT NOT NULL, reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','processed','failed')),
      error TEXT, processed_at TEXT,
      created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_meal_cycle_events_pending ON meal_cycle_events(status,id);
  `);
}
