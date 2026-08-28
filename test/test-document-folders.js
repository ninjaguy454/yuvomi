/**
 * Modul: Dokument-Ordner-Routen (#453)
 * Zweck: Umbenennen (PUT) und Löschen (DELETE) von Dokumentordnern inkl.
 *        ON DELETE SET NULL-Invariante: Dokumente behalten ihre Zeile.
 * Ausführen: npm run test:document-folders
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'document-folders-test-secret';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: documentsRouter } = await import('../server/routes/documents.js');

const moduleDatabase = get();
const suiteDatabase = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(suiteDatabase);
moduleDatabase.close();

// created_by ist NOT NULL REFERENCES users(id) — echten Admin für alle Tests seeden.
const ADMIN_ID = seedUser();

test.after(() => suiteDatabase.close());

function applyMigration(db, migration) {
  if (typeof migration.up === 'function') migration.up(db);
  else db.exec(migration.up);
  if (typeof migration.afterUp === 'function') migration.afterUp(db);
  db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
    .run(migration.version, migration.description);
}

function buildMigratedDatabase(migrations) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
  for (const migration of migrations) applyMigration(db, migration);
  return db;
}

function createHarness({ userId = ADMIN_ID, role = 'admin' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authUserId = userId;
    req.authRole = role;
    req.session = { userId, role };
    next();
  });
  app.use('/api/v1/documents', documentsRouter);
  const server = http.createServer(app);
  return {
    async call(method, pathname, body) {
      if (!server.listening) {
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      }
      const base = `http://127.0.0.1:${server.address().port}/api/v1/documents`;
      const res = await fetch(`${base}${pathname}`, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    close() {
      return new Promise((resolve) => (server.listening ? server.close(resolve) : resolve()));
    },
  };
}

function seedUser() {
  return get().prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, 'hash', 'admin')
  `).run(`folder-admin-${randomUUID()}`, 'Folder Admin').lastInsertRowid;
}

test('PUT /folders/:id renames a folder', async () => {
  const h = createHarness();
  try {
    const created = await h.call('POST', '/folders', { name: 'Vorher' });
    assert.equal(created.status, 201);
    const id = created.body.data.id;

    const renamed = await h.call('PUT', `/folders/${id}`, { name: 'Nachher' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.data.name, 'Nachher');

    const list = await h.call('GET', '/folders');
    assert.ok(list.body.data.some((f) => f.id === id && f.name === 'Nachher'));
  } finally {
    await h.close();
  }
});

test('PUT /folders/:id rejects empty name (400) and unknown id (404)', async () => {
  const h = createHarness();
  try {
    const created = await h.call('POST', '/folders', { name: `Ordner-${randomUUID()}` });
    const id = created.body.data.id;

    const empty = await h.call('PUT', `/folders/${id}`, { name: '   ' });
    assert.equal(empty.status, 400);

    const missing = await h.call('PUT', '/folders/999999', { name: 'Egal' });
    assert.equal(missing.status, 404);
  } finally {
    await h.close();
  }
});

test('DELETE /folders/:id removes the folder but keeps its documents (folder_id → NULL)', async () => {
  const h = createHarness();
  try {
    const userId = ADMIN_ID;
    const created = await h.call('POST', '/folders', { name: `Löschbar-${randomUUID()}` });
    const folderId = created.body.data.id;

    // Dokument direkt in den Ordner legen (FK-Verhalten ist DB-Ebene).
    const docId = get().prepare(`
      INSERT INTO family_documents
        (name, original_name, mime_type, file_size, content_data, category, visibility, status, folder_id, created_by)
      VALUES (?, ?, 'text/plain', 10, ?, 'other', 'family', 'active', ?, ?)
    `).run('Police', 'police.txt', Buffer.from('bytes'), folderId, userId).lastInsertRowid;

    const del = await h.call('DELETE', `/folders/${folderId}`);
    assert.equal(del.status, 200);
    assert.equal(del.body.data.id, folderId);

    // Ordner weg …
    const list = await h.call('GET', '/folders');
    assert.ok(!list.body.data.some((f) => f.id === folderId));

    // … Dokument bleibt, ohne Ordnerbindung.
    const doc = get().prepare('SELECT id, folder_id FROM family_documents WHERE id = ?').get(docId);
    assert.ok(doc, 'document row must still exist');
    assert.equal(doc.folder_id, null);
  } finally {
    await h.close();
  }
});

test('DELETE /folders/:id returns 404 for unknown id', async () => {
  const h = createHarness();
  try {
    const del = await h.call('DELETE', '/folders/999999');
    assert.equal(del.status, 404);
  } finally {
    await h.close();
  }
});

// --------------------------------------------------------
// Ein Ordner darf in einem Ordner liegen (#785)
// --------------------------------------------------------

/** Legt einen Ordner an und gibt seine Zeile zurueck. */
async function mkFolder(h, name, parentId) {
  const res = await h.call('POST', '/folders', { name, parent_id: parentId });
  assert.equal(res.status, 201, `anlegen von ${name} schlug fehl: ${JSON.stringify(res.body)}`);
  return res.body.data;
}

test('ein Ordner kann unter einem anderen liegen', async () => {
  const h = createHarness();
  try {
    const wohnung = await mkFolder(h, `Wohnung-${randomUUID()}`);
    const miete = await mkFolder(h, 'Miete', wohnung.id);

    assert.equal(miete.parent_id, wohnung.id);

    const list = await h.call('GET', '/folders');
    const found = list.body.data.find((f) => f.id === miete.id);
    assert.equal(found.parent_id, wohnung.id, 'die Liste muss parent_id mitliefern - sonst baut niemand den Baum');
  } finally {
    await h.close();
  }
});

test('derselbe Name darf unter verschiedenen Eltern stehen', async () => {
  const h = createHarness();
  try {
    // Das ist der Grund fuer den Tabellen-Neubau in v164: mit dem alten
    // globalen UNIQUE(name) waere der zweite Aufruf ein 409 gewesen, und ein
    // Baum, in dem jeder Name nur einmal im Haushalt vorkommen darf, ist keiner.
    const auto = await mkFolder(h, `Auto-${randomUUID()}`);
    const wohnung = await mkFolder(h, `Wohnung-${randomUUID()}`);

    const a = await mkFolder(h, 'Rechnungen', auto.id);
    const b = await mkFolder(h, 'Rechnungen', wohnung.id);

    assert.notEqual(a.id, b.id);
  } finally {
    await h.close();
  }
});

test('derselbe Name unter DEMSELBEN Elternteil bleibt abgewiesen', async () => {
  const h = createHarness();
  try {
    const auto = await mkFolder(h, `Auto-${randomUUID()}`);
    await mkFolder(h, 'Rechnungen', auto.id);

    const zweite = await h.call('POST', '/folders', { name: 'Rechnungen', parent_id: auto.id });
    assert.equal(zweite.status, 409);
  } finally {
    await h.close();
  }
});

test('ein Ordner kann nicht in sich selbst oder in sein eigenes Kind wandern', async () => {
  const h = createHarness();
  try {
    // Ohne diese Absage schneidet der Zweig sich vom Baum ab: er waere in
    // keiner Ansicht mehr erreichbar, aber weiter da.
    const oben = await mkFolder(h, `Oben-${randomUUID()}`);
    const mitte = await mkFolder(h, 'Mitte', oben.id);
    const unten = await mkFolder(h, 'Unten', mitte.id);

    assert.equal((await h.call('PUT', `/folders/${oben.id}`, { parent_id: oben.id })).status, 400);
    assert.equal((await h.call('PUT', `/folders/${oben.id}`, { parent_id: mitte.id })).status, 400);
    assert.equal((await h.call('PUT', `/folders/${oben.id}`, { parent_id: unten.id })).status, 400,
      'auch der ENKEL ist ein eigener Nachfahre - eine Pruefung nur auf das direkte Kind reicht nicht');

    // Die Gegenprobe: nach oben verschieben bleibt erlaubt.
    assert.equal((await h.call('PUT', `/folders/${unten.id}`, { parent_id: oben.id })).status, 200);
  } finally {
    await h.close();
  }
});

test('umbenennen allein laesst den Ordner stehen, wo er ist', async () => {
  const h = createHarness();
  try {
    // Ein Feld, das nicht mitkommt, ist keine Ansage. Ohne diese Trennung
    // naehme jedes Umbenennen den Ordner an die Wurzel mit.
    const oben = await mkFolder(h, `Oben-${randomUUID()}`);
    const kind = await mkFolder(h, 'Kind', oben.id);

    const res = await h.call('PUT', `/folders/${kind.id}`, { name: 'Anders' });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.name, 'Anders');
    assert.equal(res.body.data.parent_id, oben.id);
  } finally {
    await h.close();
  }
});

test('parent_id: null holt einen Ordner an die Wurzel zurueck', async () => {
  const h = createHarness();
  try {
    const oben = await mkFolder(h, `Oben-${randomUUID()}`);
    const kind = await mkFolder(h, `Kind-${randomUUID()}`, oben.id);

    const res = await h.call('PUT', `/folders/${kind.id}`, { parent_id: null });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.parent_id, null);
  } finally {
    await h.close();
  }
});

test('die Tiefe ist begrenzt - und der ganze Zweig zaehlt mit', async () => {
  const h = createHarness();
  try {
    // Fuenf Ebenen sind erlaubt, die sechste nicht.
    let parent = null;
    const chain = [];
    for (let i = 0; i < 5; i += 1) {
      const folder = await mkFolder(h, `Ebene${i}-${randomUUID()}`, parent);
      chain.push(folder);
      parent = folder.id;
    }
    const zuTief = await h.call('POST', '/folders', { name: 'Ebene5', parent_id: parent });
    assert.equal(zuTief.status, 400);

    // Und ein dreistufiger Zweig passt nicht mehr unter Ebene 3: gezaehlt wird
    // die HOEHE des verschobenen Teilbaums, nicht nur der eine Ordner.
    const zweigWurzel = await mkFolder(h, `Zweig-${randomUUID()}`);
    const zweigMitte = await mkFolder(h, 'ZweigMitte', zweigWurzel.id);
    await mkFolder(h, 'ZweigBlatt', zweigMitte.id);

    const zuTiefVerschoben = await h.call('PUT', `/folders/${zweigWurzel.id}`, { parent_id: chain[2].id });
    assert.equal(zuTiefVerschoben.status, 400,
      'drei Ebenen unter Ebene 3 waeren sechs - eine Pruefung nur auf den Ordner selbst uebersaehe das');
  } finally {
    await h.close();
  }
});

test('ein Ordner zeigt auch die Dokumente seiner Unterordner', async () => {
  const h = createHarness();
  try {
    const wohnung = await mkFolder(h, `Wohnung-${randomUUID()}`);
    const miete = await mkFolder(h, 'Miete', wohnung.id);

    // Direkt in die Tabelle: der Upload-Weg braucht eine echte Datei, und die
    // Frage hier ist die Filterung, nicht das Hochladen.
    const insert = get().prepare(`
      INSERT INTO family_documents (name, category, status, visibility, original_name,
                                    mime_type, file_size, content_data, folder_id, created_by)
      VALUES (?, 'home', 'active', 'family', 'x.pdf', 'application/pdf', 1, 'x', ?, ?)
    `);
    insert.run(`Mietvertrag-${randomUUID()}`, miete.id, ADMIN_ID);

    // Wer "Wohnung" oeffnet, hat das Dokument in "Wohnung/Miete" abgelegt -
    // eine leere Ansicht waere die falsche Antwort.
    const res = await h.call('GET', `/?folder_id=${wohnung.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.length, 1);
  } finally {
    await h.close();
  }
});

test('ein unbekannter Ordner zeigt nichts - nicht alles', async () => {
  const h = createHarness();
  try {
    const insert = get().prepare(`
      INSERT INTO family_documents (name, category, status, visibility, original_name,
                                    mime_type, file_size, content_data, created_by)
      VALUES (?, 'home', 'active', 'family', 'x.pdf', 'application/pdf', 1, 'x', ?)
    `);
    insert.run(`Ohne-Ordner-${randomUUID()}`, ADMIN_ID);

    // Der gefaehrliche Ausgang waere, dass eine leere Teilbaumliste zu "kein
    // Filter" wird und die Antwort ALLE Dokumente zeigt - also mehr, nicht
    // weniger, als gefragt war.
    const res = await h.call('GET', '/?folder_id=999999');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, []);
  } finally {
    await h.close();
  }
});

test('ein geloeschter Ordner nimmt seinen Zweig mit - aber kein Dokument', async () => {
  const h = createHarness();
  try {
    const wohnung = await mkFolder(h, `Wohnung-${randomUUID()}`);
    const miete = await mkFolder(h, 'Miete', wohnung.id);

    const name = `Mietvertrag-${randomUUID()}`;
    get().prepare(`
      INSERT INTO family_documents (name, category, status, visibility, original_name,
                                    mime_type, file_size, content_data, folder_id, created_by)
      VALUES (?, 'home', 'active', 'family', 'x.pdf', 'application/pdf', 1, 'x', ?, ?)
    `).run(name, miete.id, ADMIN_ID);

    const res = await h.call('DELETE', `/folders/${wohnung.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.removed_folders, 2, 'die Antwort muss sagen, was mitging');
    assert.equal(res.body.data.unfiled_documents, 1);

    // Der Unterordner ist weg (CASCADE) ...
    const list = await h.call('GET', '/folders');
    assert.ok(!list.body.data.some((f) => f.id === miete.id));

    // ... das Dokument nicht. Das ist die aeltere Zusicherung dieser Route und
    // die Untergrenze des ganzen Moduls: kein Loeschen kostet ein Dokument.
    const doc = get().prepare('SELECT folder_id FROM family_documents WHERE name = ?').get(name);
    assert.ok(doc, 'das Dokument darf nicht mitgeloescht werden');
    assert.equal(doc.folder_id, null, 'es landet unter "ohne Ordner"');
  } finally {
    await h.close();
  }
});

test('ein Modulordner behaelt seinen Schluessel, wenn er verschoben wird', async () => {
  const h = createHarness();
  try {
    // Der Schluessel traegt die IDENTITAET (v157), nicht die Position - sonst
    // verloeren sechs Module ihren Ablageort, sobald jemand aufraeumt.
    const ablage = await mkFolder(h, `Ablage-${randomUUID()}`);
    const belege = get().prepare(
      'INSERT INTO family_document_folders (name, module_key, created_by) VALUES (?, ?, ?)',
    ).run(`Belege-${randomUUID()}`, 'budget', ADMIN_ID);

    const res = await h.call('PUT', `/folders/${belege.lastInsertRowid}`, { parent_id: ablage.id });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.module_key, 'budget');
    assert.equal(res.body.data.parent_id, ablage.id);
  } finally {
    await h.close();
  }
});
