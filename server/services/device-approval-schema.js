/** Short-lived action approvals are independent of personal login sessions. */
export function addDeviceApprovalSchema(d) {
  d.exec(`CREATE TABLE device_task_approvals (
    id TEXT PRIMARY KEY,
    credential_id INTEGER NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL, context_key TEXT NOT NULL,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    task_revision INTEGER NOT NULL, parent_task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    parent_revision INTEGER,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','cancelled')),
    actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, completed_at INTEGER
  );
  CREATE UNIQUE INDEX idx_device_task_approval_pending ON device_task_approvals(credential_id) WHERE status='pending';
  CREATE INDEX idx_device_task_approval_expiry ON device_task_approvals(expires_at);
  CREATE TABLE device_task_creation_receipts (
    device_id INTEGER NOT NULL REFERENCES household_devices(id) ON DELETE CASCADE,
    request_key TEXT NOT NULL, request_hash TEXT NOT NULL,
    task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY(device_id,request_key)
  );`);
}
