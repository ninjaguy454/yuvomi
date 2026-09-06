import { FORK_MIGRATIONS } from '../../server/db.js';

/** Add production inbox access fields to the focused legacy delivery fixtures. */
export function addNotificationInboxFixture(database) {
  database.exec(`
    ALTER TABLE tasks ADD COLUMN visibility TEXT NOT NULL DEFAULT 'all';
    ALTER TABLE tasks ADD COLUMN parent_task_id INTEGER;
    ALTER TABLE calendar_events ADD COLUMN visibility TEXT NOT NULL DEFAULT 'all';
    ALTER TABLE calendar_events ADD COLUMN created_by INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE calendar_events ADD COLUMN external_source TEXT;
    ALTER TABLE calendar_events ADD COLUMN subscription_id INTEGER;
    ALTER TABLE calendar_events ADD COLUMN start_datetime TEXT;
    CREATE TABLE task_assignments (task_id INTEGER, user_id INTEGER);
    CREATE TABLE event_assignments (event_id INTEGER, user_id INTEGER);
    CREATE TABLE ics_subscriptions (id INTEGER PRIMARY KEY, shared INTEGER, created_by INTEGER);
    CREATE TABLE housekeeping_workers (user_id INTEGER);
    CREATE TABLE split_expense_guest_users (user_id INTEGER);
    CREATE TABLE planning_contexts (id INTEGER PRIMARY KEY);
    CREATE TABLE trip_plans (id INTEGER PRIMARY KEY, planning_context_id INTEGER);
    CREATE TABLE meal_grocery_runs (id INTEGER PRIMARY KEY, shopping_list_id INTEGER);
    CREATE TABLE shopping_lists (id INTEGER PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS meals (id INTEGER PRIMARY KEY, title TEXT);
    ALTER TABLE meals ADD COLUMN date TEXT;
    ALTER TABLE meals ADD COLUMN planning_context_id INTEGER;
  `);
  database.exec(FORK_MIGRATIONS.find((migration) => migration.version === 10026).up);
}
