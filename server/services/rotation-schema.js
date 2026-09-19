/** Additive storage for one household's reusable groups and consumer-owned state. */
export const ROTATION_SCHEMA_SQL = `
CREATE TABLE rotation_groups (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 household_key TEXT NOT NULL DEFAULT 'household', name TEXT NOT NULL,
 description TEXT, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 revision INTEGER NOT NULL DEFAULT 1,
 created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX idx_rotation_group_name ON rotation_groups(household_key,name COLLATE NOCASE);
CREATE TABLE rotation_group_members (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 group_id INTEGER NOT NULL REFERENCES rotation_groups(id) ON DELETE RESTRICT,
 user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
 sort_order INTEGER NOT NULL CHECK(sort_order>=0), active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 joined_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 removed_at TEXT, UNIQUE(group_id,user_id)
);
CREATE INDEX idx_rotation_group_members_order ON rotation_group_members(group_id,active,sort_order,id);
CREATE TABLE rotation_tracks (
 id INTEGER PRIMARY KEY AUTOINCREMENT, household_key TEXT NOT NULL DEFAULT 'household',
 consumer_type TEXT NOT NULL, consumer_id TEXT NOT NULL, purpose_key TEXT NOT NULL, label TEXT,
 group_id INTEGER NOT NULL REFERENCES rotation_groups(id) ON DELETE RESTRICT,
 strategy TEXT NOT NULL CHECK(strategy IN ('round_robin','rotating_order','fixed_order')),
 advance_policy TEXT NOT NULL CHECK(advance_policy IN ('manual','on_finalized','on_completed')),
 advance_on_skip INTEGER NOT NULL DEFAULT 0 CHECK(advance_on_skip IN (0,1)),
 override_affects_next INTEGER NOT NULL DEFAULT 1 CHECK(override_affects_next IN (0,1)),
 eligibility_behavior TEXT NOT NULL DEFAULT 'skip_unavailable' CHECK(eligibility_behavior IN ('keep_position','skip_unavailable')),
 eligibility_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(eligibility_json)),
 next_membership_id INTEGER REFERENCES rotation_group_members(id) ON DELETE RESTRICT,
 group_revision INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 advance_count INTEGER NOT NULL DEFAULT 0, config_revision INTEGER NOT NULL DEFAULT 1, correction_revision INTEGER NOT NULL DEFAULT 0,
 created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(household_key,consumer_type,consumer_id,purpose_key)
);
CREATE TABLE rotation_occurrences (
 id INTEGER PRIMARY KEY AUTOINCREMENT, track_id INTEGER NOT NULL REFERENCES rotation_tracks(id) ON DELETE RESTRICT,
 occurrence_key TEXT NOT NULL, group_id INTEGER NOT NULL REFERENCES rotation_groups(id) ON DELETE RESTRICT,
 group_revision INTEGER NOT NULL, track_config_revision INTEGER NOT NULL, track_correction_revision INTEGER NOT NULL DEFAULT 0,
 strategy TEXT NOT NULL, config_json TEXT NOT NULL CHECK(json_valid(config_json)),
 context_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(context_json)),
 consumer_eligibility_json TEXT CHECK(consumer_eligibility_json IS NULL OR json_valid(consumer_eligibility_json)),
 members_json TEXT NOT NULL CHECK(json_valid(members_json)),
 eligible_json TEXT NOT NULL CHECK(json_valid(eligible_json)), skipped_json TEXT NOT NULL CHECK(json_valid(skipped_json)),
 original_order_json TEXT NOT NULL CHECK(json_valid(original_order_json)),
 order_json TEXT NOT NULL CHECK(json_valid(order_json)),
 next_membership_id INTEGER REFERENCES rotation_group_members(id) ON DELETE RESTRICT,
 status TEXT NOT NULL DEFAULT 'resolved' CHECK(status IN ('resolved','finalized','completed','skipped')),
 revision INTEGER NOT NULL DEFAULT 1, advanced INTEGER NOT NULL DEFAULT 0 CHECK(advanced IN (0,1)),
 advance_reason TEXT, override_actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL, overridden_at TEXT,
 resolved_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')), finalized_at TEXT,
 UNIQUE(track_id,occurrence_key)
);
CREATE INDEX idx_rotation_occurrence_history ON rotation_occurrences(track_id,id DESC);
CREATE TABLE rotation_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER REFERENCES rotation_groups(id) ON DELETE RESTRICT,
 track_id INTEGER REFERENCES rotation_tracks(id) ON DELETE RESTRICT,
 occurrence_id INTEGER REFERENCES rotation_occurrences(id) ON DELETE RESTRICT,
 actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, event_type TEXT NOT NULL,
 details_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(details_json)),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_rotation_events_occurrence ON rotation_events(occurrence_id,id);
CREATE TABLE task_rotation_occurrences (
 id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 purpose_key TEXT NOT NULL, track_id INTEGER NOT NULL REFERENCES rotation_tracks(id) ON DELETE RESTRICT,
 occurrence_id INTEGER NOT NULL REFERENCES rotation_occurrences(id) ON DELETE RESTRICT,
 owner_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL, retired_at TEXT,
 UNIQUE(task_id,purpose_key,occurrence_id)
);
CREATE UNIQUE INDEX idx_task_rotation_active ON task_rotation_occurrences(task_id,purpose_key) WHERE retired_at IS NULL;
CREATE INDEX idx_task_rotation_owner ON task_rotation_occurrences(owner_task_id,occurrence_id);
CREATE TABLE rotation_workflow_requests (
 workflow_template_id INTEGER NOT NULL REFERENCES workflow_templates(id) ON DELETE CASCADE,
 actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 request_key TEXT NOT NULL, input_hash TEXT NOT NULL,
 workflow_instance_id INTEGER REFERENCES workflow_instances(id) ON DELETE SET NULL,
 response_json TEXT, PRIMARY KEY(workflow_template_id,actor_user_id,request_key)
);
ALTER TABLE tasks ADD COLUMN rotation_bindings_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(rotation_bindings_json));
ALTER TABLE activity_templates ADD COLUMN rotation_bindings_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(rotation_bindings_json));
ALTER TABLE workflow_templates ADD COLUMN rotation_bindings_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(rotation_bindings_json));
ALTER TABLE meal_plan_rules ADD COLUMN chooser_rotation_group_id INTEGER REFERENCES rotation_groups(id) ON DELETE RESTRICT;
ALTER TABLE meal_plan_rules ADD COLUMN cook_rotation_group_id INTEGER REFERENCES rotation_groups(id) ON DELETE RESTRICT;
ALTER TABLE meal_plan_rules ADD COLUMN supervisor_rotation_group_id INTEGER REFERENCES rotation_groups(id) ON DELETE RESTRICT;
ALTER TABLE meal_occurrence_assignments ADD COLUMN rotation_occurrence_id INTEGER REFERENCES rotation_occurrences(id) ON DELETE RESTRICT;
ALTER TABLE meal_occurrence_role_assignments ADD COLUMN rotation_occurrence_id INTEGER REFERENCES rotation_occurrences(id) ON DELETE RESTRICT;
CREATE TRIGGER trg_tasks_rotation_config_revision AFTER UPDATE OF rotation_bindings_json ON tasks
 WHEN NEW.rotation_bindings_json IS NOT OLD.rotation_bindings_json
 BEGIN UPDATE tasks SET revision=revision+1 WHERE id=NEW.id; END;
CREATE TABLE rotation_change_clock(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL DEFAULT 0);
INSERT INTO rotation_change_clock(id,version) VALUES(1,0);
`;

export function installRotationChangeTriggers(d) {
  for (const table of ['rotation_groups','rotation_group_members','rotation_tracks','rotation_occurrences','rotation_events']) {
    for (const operation of ['INSERT','UPDATE','DELETE']) d.exec(`CREATE TRIGGER trg_${table}_change_${operation.toLowerCase()}
      AFTER ${operation} ON ${table} BEGIN
        UPDATE rotation_change_clock SET version=version+1 WHERE id=1;
        UPDATE task_change_clock SET version=version+1 WHERE id=1;
      END;`);
  }
  for (const operation of ['INSERT','UPDATE','DELETE']) {
    const row = operation === 'DELETE' ? 'OLD' : 'NEW';
    d.exec(`CREATE TRIGGER trg_task_rotation_binding_${operation.toLowerCase()} AFTER ${operation} ON task_rotation_occurrences
      BEGIN UPDATE tasks SET revision=revision+1 WHERE id=${row}.task_id; END;`);
  }
  for (const table of ['users','access_capabilities','access_permissions']) for(const operation of ['INSERT','UPDATE','DELETE'])
    d.exec(`CREATE TRIGGER trg_${table}_rotation_change_${operation.toLowerCase()} AFTER ${operation} ON ${table}
      BEGIN UPDATE rotation_change_clock SET version=version+1 WHERE id=1; END;`);
}
