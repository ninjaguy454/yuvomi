import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.TZ = 'UTC';
process.env.SESSION_SECRET ??= 'reader-mode-test-session-secret-32chars';

const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { default: readerRouter } = await import('../server/routes/reader.js');
function apply(database, migration) { if (typeof migration.up === 'function') migration.up(database); else database.exec(migration.up); if (migration.afterUp) migration.afterUp(database); }
const database = new Database(':memory:');
database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT '')");
for (const migration of ALL_MIGRATIONS) apply(database, migration);
_setTestDatabase(database);
const userId = Number(database.prepare("INSERT INTO users (username,display_name,password_hash,role,family_role) VALUES ('reader','Reader','x','member','parent')").run().lastInsertRowid);
database.prepare("INSERT INTO tasks (title,category,priority,status,created_by,is_recurring,assignment_mode,rotation_index,points,visibility,countdown,locked) VALUES ('Reader task','misc','none','open',?,0,'fixed',0,0,'all',0,0)").run(userId);
database.prepare("INSERT INTO meals (date,meal_type,title,scope,source,selection_status,created_by) VALUES ('2032-01-02','dinner','Reader meal','household','manual','selected',?)").run(userId);

const app = express(); app.use(express.urlencoded({ extended: true }));
app.use((req, _res, next) => { req.session = { userId, role: 'member' }; next(); });
app.use('/reader', readerRouter);
const server = http.createServer(app); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
test.after(() => { server.close(); database.close(); });

test('Reader mode renders useful HTML without JavaScript', async () => {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/reader?view=tasks`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Yuvomi Reader/);
  assert.match(html, /Reader task/);
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /reader\.css/);
});

