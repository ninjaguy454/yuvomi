/** Receipts store canonical references, never previously authorized payloads. */
export function addTaskAcceptanceSchema(d){
  d.exec(`CREATE TABLE IF NOT EXISTS task_acceptance_receipts(
    principal_key TEXT NOT NULL, operation_id TEXT NOT NULL, request_hash TEXT NOT NULL,
    task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY(principal_key,operation_id));`);
}
