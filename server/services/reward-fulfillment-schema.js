/** Append-only schema for prize delivery work. No historical Task backfill. */
export function addRewardFulfillmentSchema(d) {
  // Historical IDs remain as tombstones when the existing member deletion
  // cascade removes recipient redemptions/ledger. Validate them on creation,
  // while retaining the Task/audit after that deliberate account deletion.
  d.exec(`CREATE TABLE IF NOT EXISTS reward_fulfillment_task_links (
    redemption_id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );`);
  d.exec(`CREATE TABLE IF NOT EXISTS reward_redemption_undos (
    redemption_id INTEGER PRIMARY KEY,
    prior_status TEXT NOT NULL CHECK(prior_status IN ('pending','fulfilled')),
    prior_decided_by INTEGER, prior_decided_at TEXT,
    actor_user_id INTEGER NOT NULL, actor_name TEXT NOT NULL, reason TEXT NOT NULL,
    refund_ledger_id INTEGER NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );
  CREATE TABLE IF NOT EXISTS reward_redemption_undo_requests (
    actor_user_id INTEGER NOT NULL, request_key TEXT NOT NULL, request_fingerprint TEXT NOT NULL,
    redemption_id INTEGER REFERENCES reward_redemptions(id) ON DELETE SET NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('undone','already_refunded')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    PRIMARY KEY(actor_user_id,request_key)
  );
  CREATE TRIGGER IF NOT EXISTS trg_reward_delivery_source_insert BEFORE INSERT ON reward_fulfillment_task_links
    WHEN NOT EXISTS(SELECT 1 FROM reward_redemptions WHERE id=NEW.redemption_id)
    BEGIN SELECT RAISE(ABORT,'Prize delivery requires a redemption'); END;
  CREATE TRIGGER IF NOT EXISTS trg_reward_undo_source_insert BEFORE INSERT ON reward_redemption_undos
    WHEN NOT EXISTS(SELECT 1 FROM reward_redemptions r JOIN reward_ledger l ON l.redemption_id=r.id
      WHERE r.id=NEW.redemption_id AND l.id=NEW.refund_ledger_id AND l.type='reversal'
      AND l.user_id=r.user_id AND l.delta=r.cost)
    BEGIN SELECT RAISE(ABORT,'Redemption Undo requires its refund'); END;
  CREATE TRIGGER IF NOT EXISTS trg_reward_undo_immutable_update BEFORE UPDATE ON reward_redemption_undos
    BEGIN SELECT RAISE(ABORT,'Redemption Undo history is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS trg_reward_undo_immutable_delete BEFORE DELETE ON reward_redemption_undos
    BEGIN SELECT RAISE(ABORT,'Redemption Undo history is immutable'); END;`);
}
