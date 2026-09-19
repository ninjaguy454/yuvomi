/** Optional temporal ownership; canonical Tracks still own every cursor. */
export const SHARED_ROTATION_SCHEMA_SQL = `
CREATE TABLE rotation_group_schedules (
 id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL UNIQUE REFERENCES rotation_groups(id) ON DELETE RESTRICT,
 track_id INTEGER UNIQUE REFERENCES rotation_tracks(id) ON DELETE RESTRICT,
 revision INTEGER NOT NULL DEFAULT 1, applied_version_id INTEGER,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE rotation_group_schedule_versions (
 id INTEGER PRIMARY KEY, schedule_id INTEGER NOT NULL REFERENCES rotation_group_schedules(id) ON DELETE RESTRICT,
 usage_mode TEXT NOT NULL CHECK(usage_mode IN ('independent','shared')),
 effective_date TEXT NOT NULL, timezone TEXT NOT NULL,
 config_json TEXT NOT NULL CHECK(json_valid(config_json)), members_json TEXT NOT NULL CHECK(json_valid(members_json)),
 independent_starts_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(independent_starts_json)),
 actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_rotation_schedule_version ON rotation_group_schedule_versions(schedule_id,effective_date,id);
CREATE TABLE rotation_group_independent_seeds (
 version_id INTEGER NOT NULL REFERENCES rotation_group_schedule_versions(id) ON DELETE RESTRICT,
 track_id INTEGER NOT NULL REFERENCES rotation_tracks(id) ON DELETE RESTRICT,
 next_member_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
 applied_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(version_id,track_id)
);
CREATE TABLE rotation_occurrence_supersessions (
 occurrence_id INTEGER PRIMARY KEY REFERENCES rotation_occurrences(id) ON DELETE RESTRICT,
 version_id INTEGER REFERENCES rotation_group_schedule_versions(id) ON DELETE RESTRICT,
 actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
 reason TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE rotation_group_periods (
 id INTEGER PRIMARY KEY, schedule_id INTEGER NOT NULL REFERENCES rotation_group_schedules(id) ON DELETE RESTRICT,
 version_id INTEGER NOT NULL REFERENCES rotation_group_schedule_versions(id) ON DELETE RESTRICT,
 period_date TEXT NOT NULL, starts_at TEXT NOT NULL, ends_at TEXT NOT NULL,
 occurrence_id INTEGER NOT NULL UNIQUE REFERENCES rotation_occurrences(id) ON DELETE RESTRICT,
 UNIQUE(schedule_id,period_date)
);
CREATE INDEX idx_rotation_period_due ON rotation_group_periods(ends_at,occurrence_id);
CREATE TABLE task_rotation_periods (
 id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 purpose_key TEXT NOT NULL, group_id INTEGER NOT NULL REFERENCES rotation_groups(id) ON DELETE RESTRICT,
 consumer_type TEXT, consumer_id TEXT,
 period_date TEXT NOT NULL, occurrence_id INTEGER REFERENCES rotation_occurrences(id) ON DELETE RESTRICT,
 retired_at TEXT
);
CREATE UNIQUE INDEX idx_task_rotation_period_active ON task_rotation_periods(task_id,purpose_key) WHERE retired_at IS NULL;
CREATE INDEX idx_task_rotation_period_group ON task_rotation_periods(group_id,period_date,retired_at);
`;
export function installSharedRotationChangeTriggers(d) {
  for(const table of ['rotation_group_schedules','rotation_group_schedule_versions','rotation_group_periods'])for(const operation of ['INSERT','UPDATE','DELETE'])
    d.exec(`CREATE TRIGGER trg_${table}_change_${operation.toLowerCase()} AFTER ${operation} ON ${table}
      BEGIN UPDATE rotation_change_clock SET version=version+1 WHERE id=1; UPDATE task_change_clock SET version=version+1 WHERE id=1; END;`);
  for(const operation of ['INSERT','UPDATE','DELETE']) {
    const row=operation==='DELETE'?'OLD':'NEW';
    d.exec(`CREATE TRIGGER trg_task_rotation_period_${operation.toLowerCase()} AFTER ${operation} ON task_rotation_periods
      BEGIN UPDATE tasks SET revision=revision+1 WHERE id=${row}.task_id; END;`);
  }
}
