/** Devices are principals, never household members. No existing browser is converted. */
export const DEVICE_SCHEMA_SQL = `
CREATE TABLE household_devices (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
 revision INTEGER NOT NULL DEFAULT 1, permissions_json TEXT NOT NULL CHECK(json_valid(permissions_json)),
 scope_json TEXT NOT NULL CHECK(json_valid(scope_json)), preferences_json TEXT NOT NULL CHECK(json_valid(preferences_json)),
 idle_seconds INTEGER NOT NULL DEFAULT 120 CHECK(idle_seconds BETWEEN 30 AND 300),
 maximum_seconds INTEGER NOT NULL DEFAULT 600 CHECK(maximum_seconds BETWEEN 60 AND 1800),
 paired_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')), last_seen_at TEXT, revoked_at TEXT
);
CREATE TABLE device_credentials (
 id INTEGER PRIMARY KEY, device_id INTEGER NOT NULL REFERENCES household_devices(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE, context_key TEXT NOT NULL, revoked_at TEXT,
 temporary_sid TEXT, temporary_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
 temporary_started_at INTEGER, temporary_idle_at INTEGER, login_intent_at INTEGER,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_device_credentials_device ON device_credentials(device_id);
CREATE TABLE device_pairings (
 id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL,
 device_id INTEGER REFERENCES household_devices(id) ON DELETE CASCADE,
 approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL, consumed_at INTEGER,
 created_at INTEGER NOT NULL
);
ALTER TABLE task_completions ADD COLUMN source_device_id INTEGER REFERENCES household_devices(id) ON DELETE SET NULL;
ALTER TABLE task_completions ADD COLUMN source_device_name TEXT;
CREATE TABLE device_audit_events (
 id INTEGER PRIMARY KEY, device_id INTEGER REFERENCES household_devices(id) ON DELETE SET NULL,
 actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, event_type TEXT NOT NULL,
 details_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(details_json)),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE device_session_tombstones (sid TEXT PRIMARY KEY, revoked_at INTEGER NOT NULL);
`;

/** Existing Tasks require a human creator. Widen only that nullable attribution
 * slot so a device can author work without impersonation. Preserve every row,
 * reference, index, trigger and AUTOINCREMENT high-water mark. */
export function addDeviceSchema(d) {
  d.exec(DEVICE_SCHEMA_SQL);
  const quote=name=>'"'+name.replaceAll('"','""')+'"';
  const original=d.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get().sql;
  const expanded=original.replace(/(created_by\s+INTEGER)\s+NOT\s+NULL/i,'$1');
  if(expanded===original)throw new Error('Task creator constraint was not found; refusing incomplete device migration.');
  const indexes=d.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='tasks' AND sql IS NOT NULL").all();
  const triggers=d.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all();
  const sequence=d.prepare("SELECT seq FROM sqlite_sequence WHERE name='tasks'").get()?.seq||0;
  const legacy=d.pragma('legacy_alter_table',{simple:true});
  try {
    d.pragma('legacy_alter_table=ON');
    for(const trigger of triggers)d.exec('DROP TRIGGER '+quote(trigger.name));
    d.exec(expanded.replace(/^CREATE TABLE\s+(?:"tasks"|tasks)/i,'CREATE TABLE tasks_devices_new'));
    d.exec('INSERT INTO tasks_devices_new SELECT * FROM tasks; DROP TABLE tasks; ALTER TABLE tasks_devices_new RENAME TO tasks;');
    d.prepare("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='tasks'").run(sequence);
    for(const index of indexes)d.exec(index.sql);
    for(const trigger of triggers)d.exec(trigger.sql);
  }finally {d.pragma('legacy_alter_table='+ (legacy?'ON':'OFF'));}
  d.exec('ALTER TABLE tasks ADD COLUMN source_device_id INTEGER REFERENCES household_devices(id) ON DELETE SET NULL; ALTER TABLE tasks ADD COLUMN source_device_name TEXT;');
}
