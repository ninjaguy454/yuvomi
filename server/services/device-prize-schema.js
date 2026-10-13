/** Append-only shared-display purchase receipts and bounded one-action proofs. */
export function addDevicePrizeSchema(d) {
  d.exec(`CREATE TABLE IF NOT EXISTS device_prize_redemption_requests (
    device_id INTEGER NOT NULL REFERENCES household_devices(id) ON DELETE RESTRICT,
    request_key TEXT NOT NULL, request_fingerprint TEXT NOT NULL,
    outcome TEXT NOT NULL DEFAULT 'purchased' CHECK(outcome IN ('purchased','abandoned')),
    redemption_id INTEGER REFERENCES reward_redemptions(id) ON DELETE SET NULL,
    source_device_name TEXT NOT NULL,
    authenticated_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    PRIMARY KEY(device_id,request_key)
  );
  CREATE TABLE IF NOT EXISTS device_prize_approvals (
    id TEXT PRIMARY KEY,
    credential_id INTEGER NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL, context_key TEXT NOT NULL, device_revision INTEGER NOT NULL,
    request_key TEXT NOT NULL, request_fingerprint TEXT NOT NULL,
    recipient_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    catalog_id INTEGER REFERENCES reward_catalog(id) ON DELETE SET NULL,
    recipient_name TEXT NOT NULL, reward_name TEXT NOT NULL,
    expected_cost INTEGER NOT NULL CHECK(expected_cost>=0), note TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','cancelled')),
    actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    redemption_id INTEGER REFERENCES reward_redemptions(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, completed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_device_prize_approval_credential_status ON device_prize_approvals(credential_id,status);`);
}
