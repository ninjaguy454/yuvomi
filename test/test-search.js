/**
 * Modul: Such-Test (FTS5)
 * Zweck: Validiert die FTS5-Volltextsuche (Migration 44) und runSearch().
 *        Baut das Schema mit node:sqlite, prüft Migration + Trigger + Suchlogik.
 * Ausführen: node --experimental-sqlite test/test-search.js
 */

import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS_SQL } from '../server/db-schema-test.js';
import { runSearch, buildMatchQuery } from '../server/services/search.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion fehlgeschlagen'); }

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;');
db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY, description TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);`);
db.exec(MIGRATIONS_SQL[1]);
// Migration 44: FTS5 index + sync triggers. Must apply cleanly.
db.exec(MIGRATIONS_SQL[44]);
// Migration 65: health tables (medications, health_activities) the search reads from.
db.exec(MIGRATIONS_SQL[65]);
// Migration 66: FTS triggers + backfill for medications and health activities.
db.exec(MIGRATIONS_SQL[66]);

console.log('\n[Search-Test] FTS5-Volltextsuche\n');

const u1 = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('admin', 'Admin', 'x', 'admin')`).run();
const uid = u1.lastInsertRowid;
const u2 = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('other', 'Other', 'x', 'member')`).run();
const otherUid = u2.lastInsertRowid;

// Seed rows AFTER migration so AFTER INSERT triggers populate the index.
db.prepare(`INSERT INTO tasks (title, description, priority, status, created_by)
  VALUES ('Buy birthday cake', 'chocolate sponge', 'high', 'open', ?)`).run(uid);
db.prepare(`INSERT INTO tasks (title, description, priority, status, created_by)
  VALUES ('Mow the lawn', 'garden chores', 'low', 'open', ?)`).run(uid);
db.prepare(`INSERT INTO tasks (title, description, priority, status, visibility, created_by)
  VALUES ('Secret cake plan', 'hidden', 'low', 'open', 'private', ?)`).run(otherUid);
db.prepare(`INSERT INTO tasks (title, description, priority, status, visibility, created_by)
  VALUES ('Shared cake plan', 'household', 'low', 'open', 'all', ?)`).run(otherUid);

const list = db.prepare(`INSERT INTO shopping_lists (name, created_by) VALUES ('Groceries', ?)`).run(uid);
db.prepare(`INSERT INTO shopping_items (list_id, name) VALUES (?, 'cake mix')`).run(list.lastInsertRowid);

db.prepare(`INSERT INTO notes (title, content, created_by) VALUES ('Party', 'order the cake early', ?)`).run(uid);
db.prepare(`INSERT INTO contacts (name, phone, email) VALUES ('Cake Bakery', '555-1', 'hi@cake.test')`).run();
db.prepare(`INSERT INTO calendar_events (title, description, start_datetime, created_by)
  VALUES ('Cake tasting', 'pick a flavor', '2030-01-01T10:00:00Z', ?)`).run(uid);

// Health medications: own (private), foreign family-visible, foreign private.
db.prepare(`INSERT INTO medications (user_id, name, dosage_text, visibility)
  VALUES (?, 'Aspirin', '500mg tablet', 'private')`).run(uid);
db.prepare(`INSERT INTO medications (user_id, name, dosage_text, visibility)
  VALUES (?, 'Metformin', '850mg', 'family')`).run(otherUid);
db.prepare(`INSERT INTO medications (user_id, name, dosage_text, visibility)
  VALUES (?, 'Warfarin', 'secret dose', 'private')`).run(otherUid);

// Health activities: own (private), foreign family-visible, foreign private.
db.prepare(`INSERT INTO health_activities (user_id, type, performed_at, note, visibility)
  VALUES (?, 'running', '2030-01-01T08:00:00Z', 'morning jog', 'private')`).run(uid);
db.prepare(`INSERT INTO health_activities (user_id, type, performed_at, note, visibility)
  VALUES (?, 'swimming', '2030-01-02T08:00:00Z', 'lap pool', 'family')`).run(otherUid);
db.prepare(`INSERT INTO health_activities (user_id, type, performed_at, note, visibility)
  VALUES (?, 'boxing', '2030-01-03T08:00:00Z', 'private spar', 'private')`).run(otherUid);

test('Migration 44 legt FTS5-Tabelle und Trigger an, Backfill leer (Seed danach)', () => {
  const tbl = db.prepare(`SELECT name FROM sqlite_master WHERE name = 'search_index'`).get();
  assert(tbl, 'search_index sollte existieren');
  const triggers = db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_search_%'`).get();
  assert(triggers.n === 21, `Erwartet 21 Trigger (15 aus Mig. 44 + 6 aus Mig. 66), erhalten ${triggers.n}`);
});

test('buildMatchQuery erzeugt sichere Präfix-Phrasen, ignoriert Sonderzeichen', () => {
  assert(buildMatchQuery('cake') === '"cake"*', 'Einzeltoken als Präfix-Phrase');
  assert(buildMatchQuery('  ') === null, 'Leerzeichen -> null');
  assert(buildMatchQuery('a"b') === '"ab"*', 'Anführungszeichen/Sonderzeichen werden gesäubert');
  assert(buildMatchQuery('order the cake') === '"order"* AND "the"* AND "cake"*', 'Mehrere Tokens via AND');
});

test('Suche findet Aufgabe über Titel-Treffer (FTS MATCH)', () => {
  const r = runSearch(db, 'birthday', uid);
  assert(r.tasks.length === 1, `Erwartet 1 Task, erhalten ${r.tasks.length}`);
  assert(r.tasks[0].title === 'Buy birthday cake', 'Korrekte Aufgabe');
});

test('Suche respektiert die Sichtbarkeit statt fremde Aufgaben pauschal auszuschließen', () => {
  const r = runSearch(db, 'cake', uid);
  const titles = r.tasks.map((t) => t.title);
  assert(titles.includes('Buy birthday cake'), 'Eigene Aufgabe gefunden');
  assert(titles.includes('Shared cake plan'), 'Haushaltssichtbare fremde Aufgabe gefunden');
  assert(!titles.includes('Secret cake plan'), 'Private fremde Aufgabe ausgeschlossen');
});

test('Suche deckt alle Entitäten ab', () => {
  const r = runSearch(db, 'cake', uid);
  assert(r.items.some((i) => i.title === 'cake mix'), 'Einkaufsartikel gefunden');
  assert(r.notes.some((n) => n.content.includes('cake')), 'Notiz gefunden');
  assert(r.contacts.some((c) => c.title === 'Cake Bakery'), 'Kontakt gefunden');
  assert(r.events.some((e) => e.title === 'Cake tasting'), 'Termin gefunden');
});

test('Präfix-Treffer funktionieren (Teilwort)', () => {
  const r = runSearch(db, 'choc', uid);
  assert(r.tasks.some((t) => t.title === 'Buy birthday cake'), 'Beschreibung "chocolate" via Präfix');
});

test('UPDATE-Trigger hält den Index synchron', () => {
  const t = db.prepare(`INSERT INTO tasks (title, description, priority, status, created_by)
    VALUES ('Renamewip', 'tmp', 'low', 'open', ?)`).run(uid);
  db.prepare(`UPDATE tasks SET title = 'Plumbing fix' WHERE id = ?`).run(t.lastInsertRowid);
  const before = runSearch(db, 'Renamewip', uid);
  assert(before.tasks.length === 0, 'Alter Titel nicht mehr im Index');
  const after = runSearch(db, 'Plumbing', uid);
  assert(after.tasks.some((x) => x.id === Number(t.lastInsertRowid)), 'Neuer Titel im Index');
});

test('DELETE-Trigger entfernt aus dem Index', () => {
  const t = db.prepare(`INSERT INTO tasks (title, priority, status, created_by)
    VALUES ('Throwaway zebra', 'low', 'open', ?)`).run(uid);
  assert(runSearch(db, 'zebra', uid).tasks.length === 1, 'Vorher gefunden');
  db.prepare(`DELETE FROM tasks WHERE id = ?`).run(t.lastInsertRowid);
  assert(runSearch(db, 'zebra', uid).tasks.length === 0, 'Nachher nicht mehr gefunden');
});

test('Suche findet Medikament über Name (FTS MATCH)', () => {
  const r = runSearch(db, 'Aspirin', uid);
  assert(r.meds.length === 1, `Erwartet 1 Medikament, erhalten ${r.meds.length}`);
  assert(r.meds[0].title === 'Aspirin', 'Korrektes Medikament');
});

test('Suche findet Medikament über Dosistext (Präfix)', () => {
  const r = runSearch(db, 'tablet', uid);
  assert(r.meds.some((m) => m.title === 'Aspirin'), 'Dosistext "500mg tablet" via Treffer');
});

test('Suche findet Aktivität über Notiz und über Typ', () => {
  const byNote = runSearch(db, 'jog', uid);
  assert(byNote.activities.some((a) => a.note === 'morning jog'), 'Aktivität über Notiz gefunden');
  const byType = runSearch(db, 'running', uid);
  assert(byType.activities.some((a) => a.title === 'running'), 'Aktivität über Typ gefunden');
});

test('Health-Suche zeigt family-sichtbare Fremdzeilen', () => {
  const med = runSearch(db, 'Metformin', uid);
  assert(med.meds.some((m) => m.title === 'Metformin'), 'Fremdes family-Medikament sichtbar');
  const act = runSearch(db, 'swimming', uid);
  assert(act.activities.some((a) => a.title === 'swimming'), 'Fremde family-Aktivität sichtbar');
});

test('Health-Suche verbirgt fremde private Zeilen', () => {
  const med = runSearch(db, 'Warfarin', uid);
  assert(med.meds.length === 0, 'Fremdes privates Medikament ausgeschlossen');
  const act = runSearch(db, 'boxing', uid);
  assert(act.activities.length === 0, 'Fremde private Aktivität ausgeschlossen');
});

test('Health-Suchtrigger halten den Index synchron (UPDATE/DELETE)', () => {
  const m = db.prepare(`INSERT INTO medications (user_id, name, dosage_text, visibility)
    VALUES (?, 'Zolpidemtmp', 'x', 'private')`).run(uid);
  assert(runSearch(db, 'Zolpidemtmp', uid).meds.length === 1, 'Neu angelegt gefunden');
  db.prepare(`UPDATE medications SET name = 'Renamedmed' WHERE id = ?`).run(m.lastInsertRowid);
  assert(runSearch(db, 'Zolpidemtmp', uid).meds.length === 0, 'Alter Name weg');
  assert(runSearch(db, 'Renamedmed', uid).meds.length === 1, 'Neuer Name im Index');
  db.prepare(`DELETE FROM medications WHERE id = ?`).run(m.lastInsertRowid);
  assert(runSearch(db, 'Renamedmed', uid).meds.length === 0, 'Nach DELETE nicht mehr im Index');
});

test('Leere/kurze Query liefert leere Ergebnisse', () => {
  const r = runSearch(db, '', uid);
  assert(r.tasks.length === 0 && r.events.length === 0 && r.notes.length === 0
    && r.contacts.length === 0 && r.items.length === 0
    && r.meds.length === 0 && r.activities.length === 0, 'Alles leer');
});

console.log(`\n[Search-Test] Ergebnis: ${passed} bestanden, ${failed} fehlgeschlagen\n`);
if (failed > 0) process.exit(1);
