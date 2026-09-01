/**
 * Migration 10023: Meal menu-change opt-ins reuse the Reminder pipeline.
 * The reminders rebuild must retain both assigned-event provenance and
 * notification delivery history while adding the Meal origin.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.SESSION_SECRET ||= 'meal-change-notification-migration-test';
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'yuvomi-meal-notify-')), 'unused.db');
const { FORK_MIGRATIONS } = await import('../server/db.js');
const migration = FORK_MIGRATIONS.find((candidate) => candidate.version === 10023);

function preMigrationDatabase() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL);
    CREATE TABLE meal_person_decisions (
      id INTEGER PRIMARY KEY,
      meal_id INTEGER NOT NULL,
      beneficiary_user_id INTEGER NOT NULL,
      participation TEXT NOT NULL
    );
    CREATE TABLE reminders (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type   TEXT NOT NULL CHECK(entity_type IN (
        'task', 'event', 'subscription', 'inventory_item',
        'inventory_tracked_date', 'pantry_item'
      )),
      entity_id     INTEGER NOT NULL,
      remind_at     TEXT NOT NULL,
      dismissed     INTEGER NOT NULL DEFAULT 0,
      created_by    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      pushed_at     TEXT,
      assigned_from INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE TABLE notification_channels (
      id INTEGER PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE notification_deliveries (
      id INTEGER PRIMARY KEY,
      reminder_id INTEGER NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      target_key TEXT NOT NULL,
      status TEXT NOT NULL,
      UNIQUE(reminder_id, provider, target_key)
    );
    CREATE INDEX idx_reminders_entity ON reminders(entity_type, entity_id);
    CREATE INDEX idx_reminders_remind ON reminders(remind_at);
    CREATE INDEX idx_reminders_user ON reminders(created_by);
    CREATE INDEX idx_reminders_assigned_from ON reminders(assigned_from);

    INSERT INTO users (id, username) VALUES (1, 'alex'), (2, 'sam');
    INSERT INTO meal_person_decisions (id, meal_id, beneficiary_user_id, participation)
      VALUES (1, 77, 2, 'not_participating');
    INSERT INTO reminders (
      id, entity_type, entity_id, remind_at, created_by, assigned_from
    ) VALUES (1, 'event', 9, '2026-08-31T09:00:00Z', 1, 2);
    INSERT INTO notification_deliveries (
      id, reminder_id, provider, target_key, status
    ) VALUES (1, 1, 'ntfy', 'channel:1', 'sent');
  `);
  return database;
}

function migratedDatabase() {
  const database = preMigrationDatabase();
  database.pragma('foreign_keys = OFF');
  database.exec(migration.up);
  database.pragma('foreign_keys = ON');
  return database;
}

test('10023 is the guarded Meal notification migration', () => {
  assert.equal(migration?.description,
    'Meal menu-change opt-ins through the existing reminder pipeline');
  assert.equal(migration?.foreignKeysOff, true);
});

test('10023 preserves reminder delivery history and adds a safe decision default', () => {
  const database = migratedDatabase();
  assert.deepEqual(database.prepare(`
    SELECT id, entity_type, entity_id, created_by, assigned_from
      FROM reminders ORDER BY id
  `).all(), [{ id: 1, entity_type: 'event', entity_id: 9, created_by: 1, assigned_from: 2 }]);
  assert.deepEqual(database.prepare(`
    SELECT id, reminder_id, provider, status FROM notification_deliveries
  `).all(), [{ id: 1, reminder_id: 1, provider: 'ntfy', status: 'sent' }]);
  assert.equal(database.prepare(`
    SELECT notify_on_menu_change FROM meal_person_decisions WHERE id = 1
  `).get().notify_on_menu_change, 0);
  assert.throws(
    () => database.prepare('UPDATE meal_person_decisions SET notify_on_menu_change = 2 WHERE id = 1').run(),
    /CHECK constraint failed/,
  );
  assert.deepEqual(database.pragma('foreign_key_check'), []);
  database.close();
});

test('10023 accepts Meal reminders, rejects unknown origins and deduplicates undelivered changes', () => {
  const database = migratedDatabase();
  database.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
    VALUES ('meal', 77, '2026-08-31T10:00:00Z', 2)
  `).run();
  assert.throws(
    () => database.prepare(`
      INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
      VALUES ('meal', 77, '2026-08-31T10:01:00Z', 2)
    `).run(),
    /UNIQUE constraint failed/,
  );
  database.prepare(`
    UPDATE reminders SET pushed_at = '2026-08-31T10:00:02Z'
     WHERE entity_type = 'meal' AND entity_id = 77
  `).run();
  database.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
    VALUES ('meal', 77, '2026-08-31T10:05:00Z', 2)
  `).run();
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM reminders
     WHERE entity_type = 'meal' AND entity_id = 77 AND created_by = 2
  `).get().count, 2, 'a later change may notify again after the first was delivered');
  assert.throws(
    () => database.prepare(`
      INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
      VALUES ('meal_menu', 77, '2026-08-31T10:10:00Z', 2)
    `).run(),
    /CHECK constraint failed/,
  );
  database.close();
});
