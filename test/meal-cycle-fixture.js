import Database from 'better-sqlite3-multiple-ciphers';
import { addMealCycleSchema } from '../server/services/meal-cycle-schema.js';

export function cycleFixture() {
  const d = new Database(':memory:');
  d.pragma('foreign_keys=ON');
  d.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY, role TEXT, family_role TEXT);
    CREATE TABLE access_permissions(subject_type TEXT,subject_id TEXT,resource_type TEXT,resource_key TEXT,access TEXT);
    CREATE TABLE access_capabilities(subject_type TEXT,subject_id TEXT,capability_key TEXT,access TEXT);
    CREATE TABLE sync_config(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE housekeeping_workers(user_id INTEGER);
    CREATE TABLE split_expense_guest_users(user_id INTEGER);
    CREATE TABLE shopping_lists(id INTEGER PRIMARY KEY);
    CREATE TABLE tasks(id INTEGER PRIMARY KEY);
    CREATE TABLE meals(id INTEGER PRIMARY KEY);
    INSERT INTO users VALUES(1,'admin','parent'),(2,'member','parent'),(3,'member','child');
    INSERT INTO shopping_lists VALUES(1);
    INSERT INTO sync_config VALUES('household_timezone','Europe/Berlin');`);
  addMealCycleSchema(d);
  return d;
}

export function validCycleSettings(overrides = {}) {
  return {enabled:true,timezone:'Europe/Berlin',cadence:'weekly',first_period_start:'2026-10-05',
    creation:{day_offset:-3,time:'09:00'},response:{day_offset:-3,time:'20:00'},
    confirmation:{day_offset:-2,time:'20:00'},shopping:{day_offset:-1,time:'10:00'},
    coordinator_id:1,shopping_assignee_id:1,shopping_list_id:1,finalization_mode:'manual',...overrides};
}
