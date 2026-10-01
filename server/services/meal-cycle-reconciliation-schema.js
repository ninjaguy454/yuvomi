/** Immutable migration 10046. Source signals carry identities, never source records. */
export function addMealCycleReconciliationSchema(d) {
  d.exec('ALTER TABLE meal_cycles ADD COLUMN permission_fingerprint TEXT');
  d.exec(`CREATE TABLE meal_cycle_source_changes (
    id INTEGER PRIMARY KEY, cycle_id INTEGER NOT NULL REFERENCES meal_cycles(id),
    fingerprint TEXT NOT NULL, previous_fingerprint TEXT, source_revision INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','reviewed','superseded')),
    created_at TEXT NOT NULL, UNIQUE(cycle_id,fingerprint)
  );
  CREATE TABLE meal_cycle_role_corrections (
    id INTEGER PRIMARY KEY, cycle_id INTEGER NOT NULL REFERENCES meal_cycles(id),
    meal_id INTEGER NOT NULL REFERENCES meals(id), role TEXT NOT NULL,
    previous_user_id INTEGER, assigned_user_id INTEGER, source_revision INTEGER NOT NULL,
    reason TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(cycle_id,meal_id,role,source_revision)
  );`);
  const tables=['availability_periods','availability_rules','schedule_patterns','schedule_pattern_days','schedule_overrides','schedule_shift_types',
    'rotation_groups','rotation_group_members','rotation_group_schedules','rotation_group_schedule_versions','rotation_group_periods','rotation_occurrences',
    'user_skill_proficiency','skills','users','birthdays','split_expense_guest_users','housekeeping_workers','access_permissions','access_capabilities',
    'planning_contexts','planning_context_members','planning_context_meal_plans','planning_context_conflicts','planning_context_grocery_settings',
    'trip_plans','trip_participants','calendar_events','event_assignments','calendar_event_exceptions','places','sync_config',
    'meals','meal_participants','meal_person_decisions','meal_person_menu_selections','meal_menu_items','meal_menu_generations','meal_ingredients',
    'meal_occurrence_assignments','meal_occurrence_role_assignments','meal_plans','meal_plan_rules','meal_plan_rule_participants',
    'recipes','recipe_ingredients','meal_execution_settings','meal_grocery_settings'];
  const available=new Set(d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name));
  for(const table of tables.filter(t=>available.has(t)))for(const action of ['INSERT','UPDATE','DELETE']) {
    // One reusable dirty slot per source/cycle bounds queue size under bulk imports.
    // SQLite transactions make source mutation and signal inseparable.
    d.exec(`CREATE TRIGGER cycle_dirty_${table}_${action.toLowerCase()} AFTER ${action} ON ${table}
      BEGIN
        INSERT INTO meal_cycle_events(dedup_key,cycle_id,scope_json,source_revision,reason)
          SELECT 'dirty:'||id||':${table}',id,json_object('cycle_id',id,'source','${table}'),'1','source_changed'
          FROM meal_cycles WHERE period_end >= date('now','-1 day')
          ON CONFLICT(dedup_key) DO UPDATE SET source_revision=CAST(CAST(source_revision AS INTEGER)+1 AS TEXT),
            status='pending',error=NULL,processed_at=NULL;
      END;`);
  }
}
