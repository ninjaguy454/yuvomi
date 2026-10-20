/** Records legacy Rotation definitions that cannot be represented by a simple
 * Group assignment without changing who is next. Source rows remain canonical
 * until an explicit, reviewed conversion can preserve their semantics. */
export function addGroupCompatibilityReviewSchema(d) {
  d.exec(`CREATE TABLE IF NOT EXISTS rotation_compatibility_review (
    id INTEGER PRIMARY KEY,
    source_type TEXT NOT NULL,
    source_id INTEGER NOT NULL,
    reason TEXT NOT NULL,
    source_value TEXT,
    status TEXT NOT NULL DEFAULT 'requires_review' CHECK(status IN ('requires_review','resolved')),
    recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(source_type,source_id,reason)
  );`);
  // A text cohort key can couple several Tasks while rotation_slot gives each
  // a different member in one turn. Group assignment has one selected member;
  // replacing the key would alter a recurring series and its persisted cursor.
  d.exec(`INSERT OR IGNORE INTO rotation_compatibility_review(source_type,source_id,reason,source_value)
    SELECT 'task',id,CASE WHEN coalesce(rotation_slot,0)<>0 THEN 'legacy_cohort_with_slot' ELSE 'legacy_cohort_cursor' END,rotation_group
    FROM tasks WHERE rotation_group IS NOT NULL AND trim(rotation_group)<>'';
    INSERT OR IGNORE INTO rotation_compatibility_review(source_type,source_id,reason,source_value)
    SELECT 'activity_template',id,'legacy_cursor_without_membership',rotation_group
    FROM activity_templates WHERE rotation_group IS NOT NULL AND trim(rotation_group)<>'';
    INSERT OR IGNORE INTO rotation_compatibility_review(source_type,source_id,reason,source_value)
    SELECT 'recurrence_definition',id,
      CASE WHEN coalesce(CAST(json_extract(definition_json,'$.task.rotation_slot') AS INTEGER),0)<>0
        THEN 'legacy_cohort_with_slot' ELSE 'legacy_cohort_cursor' END,
      json_extract(definition_json,'$.task.rotation_group')
    FROM task_recurrence_definitions
    WHERE json_type(definition_json,'$.task.rotation_group')='text'
      AND trim(json_extract(definition_json,'$.task.rotation_group'))<>'';
    INSERT OR IGNORE INTO rotation_compatibility_review(source_type,source_id,reason,source_value)
    SELECT 'recurrence_subtasks',definition.id,'legacy_subtask_cohort',
      (SELECT json_group_array(json_object('action_key',json_extract(action.value,'$.action_key'),
        'rotation_group',json_extract(action.value,'$.task.rotation_group'),
        'rotation_slot',json_extract(action.value,'$.task.rotation_slot')))
       FROM json_each(definition.definition_json,'$.subtasks') action
       WHERE json_type(action.value,'$.task.rotation_group')='text'
         AND trim(json_extract(action.value,'$.task.rotation_group'))<>'')
    FROM task_recurrence_definitions definition
    WHERE EXISTS(SELECT 1 FROM json_each(definition.definition_json,'$.subtasks') action
      WHERE json_type(action.value,'$.task.rotation_group')='text'
        AND trim(json_extract(action.value,'$.task.rotation_group'))<>'');
    INSERT OR IGNORE INTO rotation_compatibility_review(source_type,source_id,reason,source_value)
    SELECT 'meal_rule',id,'legacy_meal_cursor',
      json_object('chooser',rotation_group,'cook',cook_rotation_group,'supervisor',supervisor_rotation_group)
    FROM meal_plan_rules WHERE rotation_group IS NOT NULL OR cook_rotation_group IS NOT NULL OR supervisor_rotation_group IS NOT NULL;
    INSERT OR IGNORE INTO rotation_compatibility_review(source_type,source_id,reason,source_value)
    SELECT 'meal_schedule_slot',id,'legacy_meal_cursor',rotation_group
    FROM meal_schedule_slots WHERE rotation_group IS NOT NULL AND trim(rotation_group)<>'';
    INSERT OR IGNORE INTO rotation_compatibility_review(source_type,source_id,reason,source_value)
    SELECT 'shared_schedule_version',id,'group_level_eligibility',config_json
    FROM rotation_group_schedule_versions
    WHERE usage_mode='shared' AND json_type(config_json,'$.eligibility')='object'
      AND json_extract(config_json,'$.eligibility')<>'{}';`);
}
