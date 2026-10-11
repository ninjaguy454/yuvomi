/** Append-only schema for prize delivery work. No historical Task backfill. */
export function addRewardFulfillmentSchema(d) {
  d.exec(`CREATE TABLE IF NOT EXISTS reward_fulfillment_task_links (
    redemption_id INTEGER PRIMARY KEY REFERENCES reward_redemptions(id) ON DELETE RESTRICT,
    task_id INTEGER NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );`);
  d.exec(`CREATE TABLE IF NOT EXISTS reward_redemption_undos (
    redemption_id INTEGER PRIMARY KEY REFERENCES reward_redemptions(id) ON DELETE RESTRICT,
    prior_status TEXT NOT NULL CHECK(prior_status IN ('pending','fulfilled')),
    prior_decided_by INTEGER, prior_decided_at TEXT,
    actor_user_id INTEGER NOT NULL, actor_name TEXT NOT NULL, reason TEXT NOT NULL,
    refund_ledger_id INTEGER NOT NULL UNIQUE REFERENCES reward_ledger(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );
  CREATE TABLE IF NOT EXISTS reward_redemption_undo_requests (
    actor_user_id INTEGER NOT NULL, request_key TEXT NOT NULL, request_fingerprint TEXT NOT NULL,
    redemption_id INTEGER REFERENCES reward_redemptions(id) ON DELETE SET NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('undone','already_refunded')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    PRIMARY KEY(actor_user_id,request_key)
  );
  CREATE TRIGGER IF NOT EXISTS trg_reward_undo_immutable_update BEFORE UPDATE ON reward_redemption_undos
    BEGIN SELECT RAISE(ABORT,'Redemption Undo history is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS trg_reward_undo_immutable_delete BEFORE DELETE ON reward_redemption_undos
    BEGIN SELECT RAISE(ABORT,'Redemption Undo history is immutable'); END;`);
}
