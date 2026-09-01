/**
 * Modul: Notification-Channel-Test
 * Zweck: Gotify/ntfy Kanalverwaltung, Provider-Mapping, Reminder-Fan-out und Admin-Routen.
 * Ausführen: node --experimental-sqlite test/test-notifications.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import express from 'express';
import { MIGRATIONS } from '../server/db.js';

function notificationMigration() {
  return MIGRATIONS.find((m) => m.version === 60);
}

function makeDb({ withNotificationTables = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      -- resolvePermissions() liest das Rollen-Profil ueber family_role.
      family_role TEXT
    );
    -- Der Vorrats-Voll-Sync fragt beide Rechte-Achsen (#467): sync_config fuer
    -- die haushaltweite Abschaltung, access_permissions je Empfaenger. Fehlt
    -- eine der Tabellen, scheitert er still im try/catch von
    -- processDueNotifications - genau deshalb prueft der Test die WIRKUNG.
    CREATE TABLE IF NOT EXISTS sync_config (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS access_permissions (
      subject_type  TEXT NOT NULL,
      subject_id    TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_key  TEXT NOT NULL,
      access        TEXT NOT NULL,
      PRIMARY KEY (subject_type, subject_id, resource_type, resource_key)
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE calendar_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL
    );
    CREATE TABLE budget_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      amount REAL,
      currency TEXT,
      next_payment_date TEXT
    );
    CREATE TABLE inventory_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      purchase_date TEXT,
      warranty_months INTEGER
    );
    CREATE TABLE inventory_item_dates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      date TEXT NOT NULL,
      reminder_offset_days INTEGER NOT NULL DEFAULT 30
    );
    CREATE TABLE pantry_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 1,
      expires_on TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE TABLE meals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT
    );
    CREATE TABLE reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL CHECK(entity_type IN ('task','event','subscription','inventory_item','inventory_tracked_date','pantry_item','meal')),
      entity_id INTEGER NOT NULL,
      remind_at TEXT NOT NULL,
      dismissed INTEGER NOT NULL DEFAULT 0,
      pushed_at TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE TABLE push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_agent TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      last_used_at TEXT
    );
  `);
  if (withNotificationTables) {
    db.exec(notificationMigration().up);
  }
  db.prepare("INSERT INTO users (id, username, role) VALUES (1, 'alice', 'admin'), (2, 'bob', 'member')").run();
  return db;
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function indexExists(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(name));
}

function pastIso() {
  return new Date(Date.now() - 60_000).toISOString();
}

function futureIso() {
  return new Date(Date.now() + 3_600_000).toISOString();
}

async function call(app, method, path, body) {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  await new Promise((resolve) => server.close(resolve));
  return { status: res.status, json };
}

test('migration 60 creates notification tables and indexes', () => {
  const db = makeDb({ withNotificationTables: false });
  const migration = notificationMigration();
  assert.equal(migration?.version, 60);
  db.exec(migration.up);
  assert.equal(tableExists(db, 'notification_channels'), true);
  assert.equal(tableExists(db, 'notification_deliveries'), true);
  assert.equal(indexExists(db, 'idx_notification_channels_provider'), true);
  assert.equal(indexExists(db, 'idx_notification_deliveries_retry'), true);
});

test('channel store serializes public data without secrets', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const db = makeDb();
  const store = createNotificationChannelStore({ db });
  const created = store.createChannel({
    provider: 'gotify',
    name: 'Household Gotify',
    enabled: true,
    config: { baseUrl: 'https://gotify.example.test', priority: 5 },
    secrets: { appToken: 'secret-token' },
  });
  assert.equal(created.provider, 'gotify');
  assert.equal(created.enabled, true);
  assert.deepEqual(created.config, { baseUrl: 'https://gotify.example.test', priority: 5 });
  assert.equal(created.secrets, undefined);
  assert.equal(created.secretSet, true);
});

test('channel store validates providers, URLs, and required secrets', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const store = createNotificationChannelStore({ db: makeDb() });
  assert.throws(() => store.createChannel({ provider: 'gotify', name: 'Bad', config: {}, secrets: { appToken: 'x' } }), /base URL/i);
  assert.throws(() => store.createChannel({ provider: 'gotify', name: 'Bad', config: { baseUrl: 'https://gotify.test' }, secrets: {} }), /app token/i);
  assert.throws(() => store.createChannel({ provider: 'ntfy', name: 'Bad', config: { baseUrl: 'https://ntfy.test' }, secrets: {} }), /topic/i);
  assert.throws(() => store.createChannel({ provider: 'ntfy', name: 'Bad', config: { baseUrl: 'https://ntfy.test', topic: 'family', authType: 'token' }, secrets: {} }), /token/i);
  assert.throws(() => store.createChannel({ provider: 'gotify', name: 'Bad', config: { baseUrl: 'file:///tmp/x' }, secrets: { appToken: 'x' } }), /scheme/i);
  assert.throws(() => store.createChannel({ provider: 'webhook', name: 'Bad', config: { baseUrl: 'javascript:alert(1)' } }), /scheme/i);
  assert.throws(() => store.createChannel({ provider: 'smtp', name: 'Bad', config: {}, secrets: {} }), /provider/i);
});

test('channel updates preserve secrets when omitted and clear them explicitly', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const db = makeDb();
  const store = createNotificationChannelStore({ db });
  const created = store.createChannel({
    provider: 'ntfy',
    name: 'ntfy',
    enabled: true,
    config: { baseUrl: 'https://ntfy.example.test', topic: 'family', authType: 'token' },
    secrets: { token: 'keep-token' },
  });
  store.updateChannel(created.id, { name: 'ntfy renamed', config: { priority: 'high' } });
  const kept = db.prepare('SELECT secret_json FROM notification_channels WHERE id = ?').get(created.id);
  assert.deepEqual(JSON.parse(kept.secret_json), { token: 'keep-token', username: '', password: '' });

  store.updateChannel(created.id, { clearSecrets: ['token'], config: { authType: 'none' } });
  const cleared = db.prepare('SELECT secret_json FROM notification_channels WHERE id = ?').get(created.id);
  assert.equal(JSON.parse(cleared.secret_json).token, '');
});

test('gotify provider maps reminder payload to Gotify request', async () => {
  const { gotifyProvider } = await import('../server/services/notification-providers/gotify.js');
  const calls = [];
  const result = await gotifyProvider.send({
    channel: {
      config: { baseUrl: 'https://gotify.example.test', priority: 5 },
      secrets: { appToken: 'secret-token' },
    },
    payload: { title: 'Yuvomi', body: 'Müll rausbringen', url: '/reminders' },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ id: 7 }) };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, 'https://gotify.example.test/message?token=secret-token');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.body.get('title'), 'Yuvomi');
  assert.equal(calls[0].options.body.get('message'), 'Müll rausbringen');
  assert.equal(calls[0].options.body.get('priority'), '5');
  assert.match(calls[0].options.body.get('extras'), /client::notification/);
});

test('ntfy provider maps reminder payload with bearer auth', async () => {
  const { ntfyProvider } = await import('../server/services/notification-providers/ntfy.js');
  const calls = [];
  await ntfyProvider.send({
    channel: {
      config: { baseUrl: 'https://ntfy.example.test', topic: 'family-reminders', priority: 'default', authType: 'token' },
      secrets: { token: 'token-value' },
    },
    payload: { title: 'Yuvomi', body: 'Müll rausbringen', url: '/reminders' },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, text: async () => 'ok' };
    },
  });
  assert.equal(calls[0].url, 'https://ntfy.example.test/family-reminders');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Title, 'Yuvomi');
  assert.equal(calls[0].options.headers.Priority, 'default');
  assert.equal(calls[0].options.headers.Click, '/reminders');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer token-value');
  assert.equal(calls[0].options.body, 'Müll rausbringen');
});

test('webhook provider posts a JSON notification with optional bearer auth', async () => {
  const { webhookProvider } = await import('../server/services/notification-providers/webhook.js');
  const calls = [];
  await webhookProvider.send({
    channel: {
      config: { baseUrl: 'https://hooks.example.test/yuvomi' },
      secrets: { token: 'hook-secret' },
    },
    payload: { title: 'Yuvomi', body: 'Task', url: '/reminders', tag: 'reminder-1', priority: 'default' },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 204 };
    },
  });
  assert.equal(calls[0].url, 'https://hooks.example.test/yuvomi');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.authorization, 'Bearer hook-secret');
  assert.equal(calls[0].options.headers['content-type'], 'application/json');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.event, 'notification');
  assert.equal(body.notification.body, 'Task');
  assert.match(body.sentAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('webhook payload template shapes the body for services with their own schema (#692)', async () => {
  const { webhookProvider } = await import('../server/services/notification-providers/webhook.js');
  const calls = [];
  await webhookProvider.send({
    channel: {
      config: {
        baseUrl: 'https://discord.test/api/webhooks/1/abc',
        payloadTemplate: '{"content": "{{title}} - {{body}}", "url": "{{url}}"}',
      },
      secrets: {},
    },
    payload: { title: 'Yuvomi', body: 'Müll rausbringen', url: '/tasks', tag: 'reminder-1' },
    fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true, status: 204 }; },
  });

  // Discord verlangt `content`; der Standardbody kaeme als 400 zurueck.
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    content: 'Yuvomi - Müll rausbringen',
    url: '/tasks',
  });
});

test('webhook template escapes values instead of breaking the JSON around them (#692)', async () => {
  // Der eigentliche Grund fuer JSON.stringify beim Einsetzen: ein Titel mit
  // Anfuehrungszeichen oder Zeilenumbruch zerrisse eine naive Ersetzung, und zwar
  // erst bei der Zustellung - der Empfaenger sieht nur ein 400.
  const { webhookProvider } = await import('../server/services/notification-providers/webhook.js');
  const calls = [];
  await webhookProvider.send({
    channel: {
      config: { baseUrl: 'https://hooks.test/x', payloadTemplate: '{"content": "{{title}}: {{body}}"}' },
      secrets: {},
    },
    payload: { title: 'Er sagte "hallo"', body: 'Zeile 1\nZeile 2 \\ Ende', url: null, tag: null },
    fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true, status: 204 }; },
  });

  assert.deepEqual(JSON.parse(calls[0].options.body), {
    content: 'Er sagte "hallo": Zeile 1\nZeile 2 \\ Ende',
  });
});

test('webhook without a template keeps sending the Yuvomi-shaped body (#692)', async () => {
  const { webhookProvider } = await import('../server/services/notification-providers/webhook.js');
  const calls = [];
  await webhookProvider.send({
    channel: { config: { baseUrl: 'https://hooks.test/x', payloadTemplate: '' }, secrets: {} },
    payload: { title: 'Yuvomi', body: 'Task' },
    fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true, status: 204 }; },
  });

  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.event, 'notification');
  assert.equal(body.notification.body, 'Task');
});

test('channel store rejects a template that would only fail on delivery (#692)', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const db = makeDb();
  // `db`, nicht `database`: der Store destrukturiert { db }. Mit dem falschen
  // Schluessel faellt er still auf die globale Verbindung zurueck und der Test
  // prueft eine andere Datenbank als die, die er sich gerade gebaut hat.
  const store = createNotificationChannelStore({ db });
  const base = { provider: 'webhook', name: 'Hook', config: { baseUrl: 'https://hooks.test/x' } };

  // Kein JSON: faellt im Formular auf, nicht nachts um drei.
  assert.throws(
    () => store.createChannel({ ...base, config: { ...base.config, payloadTemplate: '{"content": {{title}}' } }),
    /valid JSON/i,
  );
  // Platzhalter, den niemand fuellen kann - sonst stuende er woertlich im Body.
  assert.throws(
    () => store.createChannel({ ...base, config: { ...base.config, payloadTemplate: '{"content": "{{titel}}"}' } }),
    /\{\{titel\}\}/,
  );
  // Ein Wert mit Anfuehrungszeichen darf die Pruefung nicht durchrutschen lassen:
  // die Probewerte tragen genau diese Zeichen.
  const ok = store.createChannel({ ...base, config: { ...base.config, payloadTemplate: '{"content": "{{title}}"}' } });
  assert.equal(ok.config.payloadTemplate, '{"content": "{{title}}"}');
  // Leer bleibt erlaubt und bedeutet Standardbody.
  const plain = store.createChannel({ ...base, name: 'Plain', config: { baseUrl: 'https://hooks.test/y' } });
  assert.equal(plain.config.payloadTemplate, '');
});

test('ein Platzhalter mit Sonderzeichen wird gemeldet, nicht durchgewinkt (#692)', async () => {
  // Die Pruefung sagt zu, Unbekanntes abzulehnen. Mit einem gemeinsamen \w+ galt
  // diese Zusage nur fuer Wortzeichen: {{task-title}} war fuer Erkennung UND
  // Ersetzung unsichtbar und ging woertlich an den Empfaenger.
  const { unknownTemplatePlaceholders } = await import('../server/services/notification-providers/webhook.js');
  assert.deepEqual(unknownTemplatePlaceholders('{"text":"{{task-title}}"}'), ['task-title']);
  assert.deepEqual(unknownTemplatePlaceholders('{"text":"{{ title }}"}'), [' title ']);
  assert.deepEqual(unknownTemplatePlaceholders('{"text":"{{item.name}}"}'), ['item.name']);
  assert.deepEqual(unknownTemplatePlaceholders('{"text":"{{title}} {{body}}"}'), []);

  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const store = createNotificationChannelStore({ db: makeDb() });
  assert.throws(
    () => store.createChannel({
      provider: 'webhook', name: 'Hook',
      config: { baseUrl: 'https://hooks.test/x', payloadTemplate: '{"text":"{{task-title}}"}' },
    }),
    /\{\{task-title\}\}/,
  );
});

test('ein Webhook behaelt den Schraegstrich am Ende seines Endpunkts (#692)', async () => {
  // Bei Gotify/ntfy ist die URL eine Basis, an die der Provider seinen Pfad
  // haengt - da ist der Slash Rauschen. Beim Webhook IST sie der Endpunkt, und
  // ein Empfaenger darf /hooks/x/ von /hooks/x unterscheiden.
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const store = createNotificationChannelStore({ db: makeDb() });

  const hook = store.createChannel({
    provider: 'webhook', name: 'Hook', config: { baseUrl: 'https://hooks.test/services/T/B/' },
  });
  assert.equal(hook.config.baseUrl, 'https://hooks.test/services/T/B/');

  const gotify = store.createChannel({
    provider: 'gotify', name: 'G', config: { baseUrl: 'https://gotify.test/' }, secrets: { appToken: 'x' },
  });
  assert.equal(gotify.config.baseUrl, 'https://gotify.test', 'die Basis behaelt ihr bisheriges Verhalten');
});

test('die OpenAPI-Provider-Liste kennt jeden angebotenen Kanal (#692)', async () => {
  // Der Provider stand in NOTIFICATION_PROVIDERS, aber nicht im Schema: ein
  // generierter Client haette provider:"webhook" abgelehnt, bevor er ihn sendet.
  // Als Regel formuliert, nicht als Liste - der naechste Provider faellt sonst
  // in dieselbe Luecke.
  const { NOTIFICATION_PROVIDERS } = await import('../server/services/notification-channels.js');
  const source = readFileSync(new URL('../server/openapi/schemas.js', import.meta.url), 'utf8');
  // Nur die beiden Notification-Schemata: `provider` gibt es auch im DMS-Schema,
  // und das kennt paperless/papra, nicht gotify.
  const enums = ['NotificationChannel', 'NotificationChannelInput'].map((name) => {
    const at = source.indexOf(`        ${name}: {`);
    assert.ok(at !== -1, `Schema ${name} muss es geben`);
    const block = source.slice(at, at + 2000);
    const m = /provider: \{ type: 'string', enum: \[([^\]]+)\] \}/.exec(block);
    assert.ok(m, `${name} muss ein provider-Enum tragen`);
    return m[1].split(',').map((s) => s.trim().replace(/'/g, ''));
  });
  for (const values of enums) {
    for (const { id } of NOTIFICATION_PROVIDERS) {
      assert.ok(values.includes(id), `OpenAPI-Enum kennt "${id}" nicht: ${values.join(', ')}`);
    }
  }
});

test('providers throw sanitized HTTP errors', async () => {
  const { gotifyProvider } = await import('../server/services/notification-providers/gotify.js');
  await assert.rejects(() => gotifyProvider.send({
    channel: {
      config: { baseUrl: 'https://gotify.example.test', priority: 5 },
      secrets: { appToken: 'secret-token' },
    },
    payload: { title: 'Yuvomi', body: 'Body', url: '/reminders' },
    fetchImpl: async () => ({ ok: false, status: 403 }),
  }), (err) => {
    assert.match(err.message, /authentication/i);
    assert.doesNotMatch(err.message, /secret-token/);
    return true;
  });
});

test('notification processor fans out and deduplicates reminder deliveries', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const { processDueNotifications } = await import('../server/services/notifications.js');
  const db = makeDb();
  const store = createNotificationChannelStore({ db });
  store.createChannel({ provider: 'gotify', name: 'Gotify', enabled: true, config: { baseUrl: 'https://gotify.test' }, secrets: { appToken: 'g' } });
  store.createChannel({ provider: 'ntfy', name: 'ntfy', enabled: true, config: { baseUrl: 'https://ntfy.test', topic: 'family' }, secrets: {} });
  db.prepare("INSERT INTO tasks (id, title, created_by) VALUES (1, 'Müll rausbringen', 1)").run();
  db.prepare("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (1, 'https://push/ok', 'p', 'a')").run();
  db.prepare("INSERT INTO reminders (id, entity_type, entity_id, remind_at, created_by) VALUES (1, 'task', 1, ?, 1)")
    .run('2026-06-19T09:59:00.000Z');
  const calls = { webpush: 0, gotify: 0, ntfy: 0 };
  const providers = {
    gotify: { id: 'gotify', send: async () => { calls.gotify += 1; return { ok: true, status: 200 }; } },
    ntfy: { id: 'ntfy', send: async () => { calls.ntfy += 1; return { ok: true, status: 200 }; } },
  };
  const pushService = { sendPushToUser: async () => { calls.webpush += 1; return 1; } };

  const first = await processDueNotifications({ database: db, channelStore: store, pushService, providers, now: new Date() });
  assert.deepEqual(first, { due: 1, attempted: 3, sent: 3, failed: 0, skipped: 0 });
  assert.deepEqual(calls, { webpush: 1, gotify: 1, ntfy: 1 });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notification_deliveries WHERE status = 'sent'").get().c, 3);
  assert.notEqual(db.prepare('SELECT pushed_at FROM reminders WHERE id = 1').get().pushed_at, null);

  const second = await processDueNotifications({ database: db, channelStore: store, pushService, providers, now: new Date() });
  assert.equal(second.due, 0);
  assert.deepEqual(calls, { webpush: 1, gotify: 1, ntfy: 1 });
});

test('subscription reminders carry name, amount and renewal date as body (#581)', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const { processDueNotifications } = await import('../server/services/notifications.js');
  const db = makeDb();
  const store = createNotificationChannelStore({ db });
  store.createChannel({ provider: 'ntfy', name: 'ntfy', enabled: true, config: { baseUrl: 'https://ntfy.test', topic: 'family' }, secrets: {} });
  db.prepare("INSERT INTO budget_subscriptions (id, name, amount, currency, next_payment_date) VALUES (1, 'Netflix', 12.99, 'EUR', '2026-06-22')").run();
  db.prepare("INSERT INTO reminders (id, entity_type, entity_id, remind_at, created_by) VALUES (1, 'subscription', 1, ?, 1)")
    .run('2026-06-19T09:59:00.000Z');
  const payloads = [];
  const providers = {
    ntfy: { id: 'ntfy', send: async ({ payload }) => { payloads.push(payload); return { ok: true, status: 200 }; } },
  };
  const pushService = { sendPushToUser: async () => 0 };

  await processDueNotifications({ database: db, channelStore: store, pushService, providers, now: new Date() });
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].body, 'Netflix - 12.99 EUR - 2026-06-22');
  // Der Titel nennt die Herkunft, nicht den App-Namen (Block 2): ein Siegel
  // kann eine Systembenachrichtigung nicht tragen, der Titel schon.
  assert.equal(payloads[0].title, 'Subscriptions');
});

test('a notification names its origin in the title, in the household language', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const { processDueNotifications } = await import('../server/services/notifications.js');
  const db = makeDb();
  const store = createNotificationChannelStore({ db });
  store.createChannel({ provider: 'ntfy', name: 'ntfy', enabled: true, config: { baseUrl: 'https://ntfy.test', topic: 'family' }, secrets: {} });
  // Die Datensprache des Haushalts, wie sie auch der Geburtstags-Titel liest.
  // `sync_config` legt inzwischen makeDb() an - der Vorrats-Voll-Sync liest
  // dort die haushaltweite Modul-Abschaltung.
  db.prepare("INSERT INTO sync_config (key, value) VALUES ('language', 'de')").run();
  db.prepare("INSERT INTO tasks (id, title, created_by) VALUES (1, 'Müll rausbringen', 1)").run();
  db.prepare("INSERT INTO calendar_events (id, title) VALUES (2, 'Zahnarzt')").run();
  db.prepare("INSERT INTO budget_subscriptions (id, name) VALUES (3, 'Netflix')").run();
  for (const [id, type, entity] of [[1, 'task', 1], [2, 'event', 2], [3, 'subscription', 3]]) {
    db.prepare('INSERT INTO reminders (id, entity_type, entity_id, remind_at, created_by) VALUES (?, ?, ?, ?, 1)')
      .run(id, type, entity, '2026-06-19T09:59:00.000Z');
  }
  const payloads = [];
  const providers = {
    ntfy: { id: 'ntfy', send: async ({ payload }) => { payloads.push(payload); return { ok: true, status: 200 }; } },
  };
  const pushService = { sendPushToUser: async () => 0 };

  await processDueNotifications({ database: db, channelStore: store, pushService, providers, now: new Date() });

  const titles = payloads.map((p) => p.title);
  assert.deepEqual(titles, ['Aufgaben', 'Kalender', 'Abonnements'],
    'Jede Meldung nennt ihr Herkunftsmodul im Titel, uebersetzt in die Datensprache des Haushalts.');
  // Und der Body bleibt die Sache selbst - der Titel ersetzt ihn nicht.
  assert.deepEqual(payloads.map((p) => p.body), ['Müll rausbringen', 'Zahnarzt', 'Netflix']);
});

test('Meal-change reminders reuse the existing delivery pipeline and link back to Meals', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const { processDueNotifications } = await import('../server/services/notifications.js');
  const db = makeDb();
  const store = createNotificationChannelStore({ db });
  store.createChannel({
    provider: 'ntfy',
    name: 'ntfy',
    enabled: true,
    config: { baseUrl: 'https://ntfy.test', topic: 'family' },
    secrets: {},
  });
  db.prepare("INSERT INTO meals (id, title) VALUES (1, 'Vegetable tacos and cilantro rice')").run();
  db.prepare("INSERT INTO reminders (id, entity_type, entity_id, remind_at, created_by) VALUES (1, 'meal', 1, ?, 1)")
    .run('2026-06-19T09:59:00.000Z');
  const payloads = [];
  const providers = {
    ntfy: {
      id: 'ntfy',
      send: async ({ payload }) => {
        payloads.push(payload);
        return { ok: true, status: 200 };
      },
    },
  };

  await processDueNotifications({
    database: db,
    channelStore: store,
    pushService: { sendPushToUser: async () => 0 },
    providers,
    now: new Date('2026-06-19T10:00:00.000Z'),
  });

  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].title, 'Meals');
  assert.equal(payloads[0].body, 'Vegetable tacos and cilantro rice');
  assert.equal(payloads[0].url, '/meals');
});

test('subscription reminders degrade to the bare name when amount or date are missing (#581)', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const { processDueNotifications } = await import('../server/services/notifications.js');
  const db = makeDb();
  const store = createNotificationChannelStore({ db });
  store.createChannel({ provider: 'ntfy', name: 'ntfy', enabled: true, config: { baseUrl: 'https://ntfy.test', topic: 'family' }, secrets: {} });
  db.prepare("INSERT INTO budget_subscriptions (id, name) VALUES (1, 'Netflix')").run();
  db.prepare("INSERT INTO reminders (id, entity_type, entity_id, remind_at, created_by) VALUES (1, 'subscription', 1, ?, 1)")
    .run('2026-06-19T09:59:00.000Z');
  const payloads = [];
  const providers = {
    ntfy: { id: 'ntfy', send: async ({ payload }) => { payloads.push(payload); return { ok: true, status: 200 }; } },
  };
  const pushService = { sendPushToUser: async () => 0 };

  await processDueNotifications({ database: db, channelStore: store, pushService, providers, now: new Date() });
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].body, 'Netflix');
});

test('inventory warranty reminders carry item name and warranty end as body', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const { processDueNotifications } = await import('../server/services/notifications.js');
  const db = makeDb();
  const store = createNotificationChannelStore({ db });
  store.createChannel({ provider: 'ntfy', name: 'ntfy', enabled: true, config: { baseUrl: 'https://ntfy.test', topic: 'family' }, secrets: {} });
  db.prepare("INSERT INTO inventory_items (id, name, purchase_date, warranty_months) VALUES (1, 'Waschmaschine', '2024-07-22', 24)").run();
  db.prepare("INSERT INTO reminders (id, entity_type, entity_id, remind_at, created_by) VALUES (1, 'inventory_item', 1, ?, 1)")
    .run('2026-06-19T09:59:00.000Z');
  const payloads = [];
  const providers = {
    ntfy: { id: 'ntfy', send: async ({ payload }) => { payloads.push(payload); return { ok: true, status: 200 }; } },
  };
  const pushService = { sendPushToUser: async () => 0 };

  await processDueNotifications({ database: db, channelStore: store, pushService, providers, now: new Date() });
  assert.equal(payloads.length, 1);
  // Regression: ohne den inventory_item-Zweig im entity_title-CASE kam hier der
  // Fallback-Body 'Reminder' an, also eine Notification ohne jede Sachinfo.
  assert.equal(payloads[0].body, 'Waschmaschine - 2026-07-22');
  // Title-Herkunfts-Regel (v2.6.0): der Titel nennt das Modul, nicht mehr
  // pauschal den App-Namen (vgl. task/event/subscription oben).
  assert.equal(payloads[0].title, 'Inventory');
});

test('inventory warranty reminders degrade to the bare item name without warranty data', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const { processDueNotifications } = await import('../server/services/notifications.js');
  const db = makeDb();
  const store = createNotificationChannelStore({ db });
  store.createChannel({ provider: 'ntfy', name: 'ntfy', enabled: true, config: { baseUrl: 'https://ntfy.test', topic: 'family' }, secrets: {} });
  db.prepare("INSERT INTO inventory_items (id, name) VALUES (1, 'Waschmaschine')").run();
  db.prepare("INSERT INTO reminders (id, entity_type, entity_id, remind_at, created_by) VALUES (1, 'inventory_item', 1, ?, 1)")
    .run('2026-06-19T09:59:00.000Z');
  const payloads = [];
  const providers = {
    ntfy: { id: 'ntfy', send: async ({ payload }) => { payloads.push(payload); return { ok: true, status: 200 }; } },
  };
  const pushService = { sendPushToUser: async () => 0 };

  await processDueNotifications({ database: db, channelStore: store, pushService, providers, now: new Date() });
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].body, 'Waschmaschine');
});

test('inventory tracked-date reminders carry item name, label and date as body', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const { processDueNotifications } = await import('../server/services/notifications.js');
  const db = makeDb();
  const store = createNotificationChannelStore({ db });
  store.createChannel({ provider: 'ntfy', name: 'ntfy', enabled: true, config: { baseUrl: 'https://ntfy.test', topic: 'family' }, secrets: {} });
  db.prepare("INSERT INTO inventory_items (id, name) VALUES (1, 'Auto')").run();
  db.prepare("INSERT INTO inventory_item_dates (id, item_id, label, date, reminder_offset_days) VALUES (1, 1, 'TÜV', '2027-03-01', 30)").run();
  db.prepare("INSERT INTO reminders (id, entity_type, entity_id, remind_at, created_by) VALUES (1, 'inventory_tracked_date', 1, ?, 1)")
    .run('2026-06-19T09:59:00.000Z');
  const payloads = [];
  const providers = {
    ntfy: { id: 'ntfy', send: async ({ payload }) => { payloads.push(payload); return { ok: true, status: 200 }; } },
  };
  const pushService = { sendPushToUser: async () => 0 };

  await processDueNotifications({ database: db, channelStore: store, pushService, providers, now: new Date() });
  assert.equal(payloads.length, 1);
  // Regression: ohne den inventory_tracked_date-Zweig im entity_title-CASE kaeme
  // hier der Fallback-Body 'Reminder' an, also eine Notification ohne jede Sachinfo.
  assert.equal(payloads[0].body, 'Auto · TÜV - 2027-03-01');
  // Title-Herkunfts-Regel (v2.6.0): der Titel nennt das Modul, nicht mehr
  // pauschal den App-Namen (vgl. task/event/subscription oben).
  assert.equal(payloads[0].title, 'Inventory');
});

// --------------------------------------------------------------------------
// DER PUSH-LAUF ZIEHT DEN VORRAT NACH
//
// Der Router legt die Erinnerung beim Speichern an - aber ein Vorrat, der schon
// vor #811 im Regal stand, wurde nie gespeichert. Ohne diesen Test prueft nichts,
// dass processDueNotifications den Voll-Sync ueberhaupt AUFRUFT: die Suite in
// test-pantry-expiry-reminders.js ruft ihn selbst auf und bliebe gruen, waehrend
// der Bestand im Betrieb nie meldet.
//
// Der Fehler ist hier zusaetzlich still: der Aufruf steht in try/catch, damit
// eine kaputte Zeile die Zustellung nicht verliert. Genau deshalb muss ein Test
// die WIRKUNG pruefen und nicht das Ausbleiben eines Fehlers - der Voll-Sync
// scheiterte in dieser Suite eine Weile an einer unvollstaendigen Fixture, ohne
// dass ein einziger Haken rot wurde.
// --------------------------------------------------------------------------
test('processDueNotifications legt fehlende Vorrats-Erinnerungen nach', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const { processDueNotifications } = await import('../server/services/notifications.js');
  const db = makeDb();
  const store = createNotificationChannelStore({ db });

  // Direkt in die Tabelle: die Lage nach einem Update, ohne Router-Schreibweg.
  db.prepare("INSERT INTO pantry_items (id, name, quantity, expires_on, created_by) VALUES (1, 'Marmelade', 2, '2099-06-01', 1)").run();
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM reminders WHERE entity_type = 'pantry_item'").get().c, 0);

  await processDueNotifications({ database: db, channelStore: store, pushService: { sendPushToUser: async () => 0 }, providers: {}, now: new Date() });

  const reminder = db.prepare("SELECT * FROM reminders WHERE entity_type = 'pantry_item' AND entity_id = 1").get();
  assert.ok(reminder, 'der Bestand meldet sonst nie - der Lauf legt nichts nach');
  // Sieben Tage vor dem MHD, dieselbe Schwelle wie der Chip in der Liste.
  assert.equal(reminder.remind_at, '2099-05-25T09:00');
});

test('pantry reminders carry the item name and its best-before date as body', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const { processDueNotifications } = await import('../server/services/notifications.js');
  const db = makeDb();
  const store = createNotificationChannelStore({ db });
  store.createChannel({ provider: 'ntfy', name: 'ntfy', enabled: true, config: { baseUrl: 'https://ntfy.test', topic: 'family' }, secrets: {} });
  // FESTES `now`, UND MHD/remind_at PASSEN EXAKT ZUSAMMEN. Beides ist noetig:
  // der Voll-Sync raeumt eine Vorwarnung ab, deren Artikel laengst abgelaufen
  // ist, und er zieht einen abweichenden Termin gerade. Nur wenn
  // `expires_on - 7 Tage` genau dem gesetzten remind_at entspricht, laesst er
  // die Zeile in Ruhe - und dann haengt der Test auch an keiner Wanduhr.
  db.prepare("INSERT INTO pantry_items (id, name, quantity, expires_on, created_by) VALUES (1, 'Joghurt', 2, '2026-08-27', 1)").run();
  db.prepare("INSERT INTO reminders (id, entity_type, entity_id, remind_at, created_by) VALUES (1, 'pantry_item', 1, ?, 1)")
    .run('2026-08-20T09:00');
  const payloads = [];
  const providers = {
    ntfy: { id: 'ntfy', send: async ({ payload }) => { payloads.push(payload); return { ok: true, status: 200 }; } },
  };
  const pushService = { sendPushToUser: async () => 0 };

  await processDueNotifications({ database: db, channelStore: store, pushService, providers, now: new Date('2026-08-20T10:00:00Z') });
  assert.equal(payloads.length, 1);
  // Regression: ohne den pantry_item-Zweig im entity_title-CASE kaeme hier der
  // Fallback-Body 'Reminder' an - eine Meldung, die nicht sagt, welcher Artikel.
  assert.equal(payloads[0].body, 'Joghurt - 2026-08-27');
  // Herkunfts-Regel: der Titel nennt das Modul, und das Ziel fuehrt dorthin -
  // beides steht in EINEM Eintrag, damit es nicht auseinanderlaufen kann.
  assert.equal(payloads[0].title, 'Pantry');
  assert.equal(payloads[0].url, '/pantry');
});

test('eine Vorrats-Erinnerung ohne Artikel wird abgeraeumt statt inhaltslos zugestellt', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const { processDueNotifications } = await import('../server/services/notifications.js');
  const db = makeDb();
  const store = createNotificationChannelStore({ db });
  store.createChannel({ provider: 'ntfy', name: 'ntfy', enabled: true, config: { baseUrl: 'https://ntfy.test', topic: 'family' }, secrets: {} });
  // Zeigt auf einen Artikel, den es nicht (mehr) gibt. Der Router raeumt beim
  // Loeschen auf; eine Zeile, die das umgangen hat, faengt der Voll-Sync ab.
  db.prepare("INSERT INTO reminders (id, entity_type, entity_id, remind_at, created_by) VALUES (1, 'pantry_item', 99, ?, 1)")
    .run('2026-06-19T09:59:00.000Z');
  const payloads = [];
  const providers = {
    ntfy: { id: 'ntfy', send: async ({ payload }) => { payloads.push(payload); return { ok: true, status: 200 }; } },
  };
  const pushService = { sendPushToUser: async () => 0 };

  await processDueNotifications({ database: db, channelStore: store, pushService, providers, now: new Date() });

  // Vorher waere hier eine Meldung mit dem Ersatztext 'Reminder' rausgegangen -
  // eine Unterbrechung, die nicht sagen kann, worum es geht.
  assert.equal(payloads.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM reminders WHERE entity_type = 'pantry_item'").get().c, 0);
});

test('inventory tracked-date reminders degrade to the bare title without a date', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const { processDueNotifications } = await import('../server/services/notifications.js');
  const db = makeDb();
  const store = createNotificationChannelStore({ db });
  store.createChannel({ provider: 'ntfy', name: 'ntfy', enabled: true, config: { baseUrl: 'https://ntfy.test', topic: 'family' }, secrets: {} });
  db.prepare("INSERT INTO inventory_items (id, name) VALUES (1, 'Auto')").run();
  db.prepare("INSERT INTO inventory_item_dates (id, item_id, label, date, reminder_offset_days) VALUES (1, 1, 'TÜV', '2027-03-01', 30)").run();
  // Reminder zeigt auf eine geloeschte Fristen-Zeile: entity_title bleibt leer,
  // damit greift der generische Fallback statt eines halbfertigen Bodys.
  db.prepare("INSERT INTO reminders (id, entity_type, entity_id, remind_at, created_by) VALUES (1, 'inventory_tracked_date', 99, ?, 1)")
    .run('2026-06-19T09:59:00.000Z');
  const payloads = [];
  const providers = {
    ntfy: { id: 'ntfy', send: async ({ payload }) => { payloads.push(payload); return { ok: true, status: 200 }; } },
  };
  const pushService = { sendPushToUser: async () => 0 };

  await processDueNotifications({ database: db, channelStore: store, pushService, providers, now: new Date() });
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].body, 'Reminder');
});

test('task reminders keep their bare title as body (#581)', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const { processDueNotifications } = await import('../server/services/notifications.js');
  const db = makeDb();
  const store = createNotificationChannelStore({ db });
  store.createChannel({ provider: 'ntfy', name: 'ntfy', enabled: true, config: { baseUrl: 'https://ntfy.test', topic: 'family' }, secrets: {} });
  db.prepare("INSERT INTO tasks (id, title, created_by) VALUES (1, 'Müll rausbringen', 1)").run();
  db.prepare("INSERT INTO reminders (id, entity_type, entity_id, remind_at, created_by) VALUES (1, 'task', 1, ?, 1)")
    .run('2026-06-19T09:59:00.000Z');
  const payloads = [];
  const providers = {
    ntfy: { id: 'ntfy', send: async ({ payload }) => { payloads.push(payload); return { ok: true, status: 200 }; } },
  };
  const pushService = { sendPushToUser: async () => 0 };

  await processDueNotifications({ database: db, channelStore: store, pushService, providers, now: new Date() });
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].body, 'Müll rausbringen');
});

test('reminders for deleted entities never send the app name as body (#581)', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const { processDueNotifications } = await import('../server/services/notifications.js');
  const db = makeDb();
  const store = createNotificationChannelStore({ db });
  store.createChannel({ provider: 'ntfy', name: 'ntfy', enabled: true, config: { baseUrl: 'https://ntfy.test', topic: 'family' }, secrets: {} });
  db.prepare("INSERT INTO reminders (id, entity_type, entity_id, remind_at, created_by) VALUES (1, 'task', 999, ?, 1)")
    .run('2026-06-19T09:59:00.000Z');
  const payloads = [];
  const providers = {
    ntfy: { id: 'ntfy', send: async ({ payload }) => { payloads.push(payload); return { ok: true, status: 200 }; } },
  };
  const pushService = { sendPushToUser: async () => 0 };

  await processDueNotifications({ database: db, channelStore: store, pushService, providers, now: new Date() });
  assert.equal(payloads.length, 1);
  assert.notEqual(payloads[0].body, payloads[0].title);
  assert.equal(payloads[0].body, 'Reminder');
});

test('notification processor retries failed external channels after backoff', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const { processDueNotifications } = await import('../server/services/notifications.js');
  const db = makeDb();
  const store = createNotificationChannelStore({ db });
  store.createChannel({ provider: 'gotify', name: 'Gotify', enabled: true, config: { baseUrl: 'https://gotify.test' }, secrets: { appToken: 'g' } });
  store.createChannel({ provider: 'ntfy', name: 'ntfy', enabled: true, config: { baseUrl: 'https://ntfy.test', topic: 'family' }, secrets: {} });
  db.prepare("INSERT INTO tasks (id, title, created_by) VALUES (1, 'Task', 1)").run();
  db.prepare("INSERT INTO reminders (id, entity_type, entity_id, remind_at, created_by) VALUES (1, 'task', 1, ?, 1)")
    .run('2026-06-19T09:59:00.000Z');
  let ntfyAttempts = 0;
  const providers = {
    gotify: { id: 'gotify', send: async () => ({ ok: true, status: 200 }) },
    ntfy: {
      id: 'ntfy',
      send: async () => {
        ntfyAttempts += 1;
        if (ntfyAttempts === 1) {
          const err = new Error('ntfy returned HTTP 500');
          err.status = 500;
          throw err;
        }
        return { ok: true, status: 200 };
      },
    },
  };
  const pushService = { sendPushToUser: async () => 0 };
  const firstNow = new Date('2026-06-19T10:00:00.000Z');
  const first = await processDueNotifications({ database: db, channelStore: store, pushService, providers, now: firstNow });
  assert.equal(first.failed, 1);
  assert.equal(db.prepare('SELECT pushed_at FROM reminders WHERE id = 1').get().pushed_at, null);
  let ntfyRow = db.prepare("SELECT * FROM notification_deliveries WHERE provider = 'ntfy'").get();
  assert.equal(ntfyRow.status, 'failed');
  assert.equal(ntfyRow.attempt_count, 1);
  assert.equal(ntfyRow.next_attempt_at > firstNow.toISOString(), true);

  await processDueNotifications({ database: db, channelStore: store, pushService, providers, now: new Date('2026-06-19T10:02:00.000Z') });
  assert.equal(ntfyAttempts, 1);

  await processDueNotifications({ database: db, channelStore: store, pushService, providers, now: new Date('2026-06-19T10:06:00.000Z') });
  ntfyRow = db.prepare("SELECT * FROM notification_deliveries WHERE provider = 'ntfy'").get();
  assert.equal(ntfyRow.status, 'sent');
  assert.notEqual(db.prepare('SELECT pushed_at FROM reminders WHERE id = 1').get().pushed_at, null);
});

test('admin notification routes manage channels and test sends', async () => {
  const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
  const { buildRouter } = await import('../server/routes/notifications.js');
  const db = makeDb();
  const store = createNotificationChannelStore({ db });
  const sent = [];
  const routeProviders = {
    gotify: { id: 'gotify', send: async ({ payload }) => { sent.push(payload); return { ok: true, status: 200 }; } },
    ntfy: { id: 'ntfy', send: async () => ({ ok: true, status: 200 }) },
    webhook: { id: 'webhook', send: async () => ({ ok: true, status: 204 }) },
  };
  const router = buildRouter({
    database: db,
    channelStore: store,
    notificationService: {
      providers: routeProviders,
      testChannel: async ({ channel, payload }) => {
        await routeProviders[channel.provider].send({ channel, payload });
        return { ok: true };
      },
    },
  });
  const makeApp = (authRole = 'admin') => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.authUserId = 1; req.authRole = authRole; next(); });
    app.use('/notifications', router);
    return app;
  };
  assert.equal((await call(makeApp('member'), 'GET', '/notifications/channels')).status, 403);

  const providers = await call(makeApp(), 'GET', '/notifications/providers');
  assert.equal(providers.status, 200);
  assert.deepEqual(providers.json.data.map((p) => p.id), ['gotify', 'ntfy', 'webhook']);

  const created = await call(makeApp(), 'POST', '/notifications/channels', {
    provider: 'gotify',
    name: 'Gotify',
    enabled: true,
    config: { baseUrl: 'https://gotify.test' },
    secrets: { appToken: 'secret' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.data.secretSet, true);
  assert.equal(created.json.data.secrets, undefined);

  const updated = await call(makeApp(), 'PUT', `/notifications/channels/${created.json.data.id}`, {
    name: 'Gotify renamed',
    config: { priority: 7 },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.data.config.priority, 7);
  assert.equal(JSON.parse(db.prepare('SELECT secret_json FROM notification_channels WHERE id = ?').get(created.json.data.id).secret_json).appToken, 'secret');

  const testSend = await call(makeApp(), 'POST', `/notifications/channels/${created.json.data.id}/test`, {});
  assert.equal(testSend.status, 200);
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /Yuvomi/);

  const deleted = await call(makeApp(), 'DELETE', `/notifications/channels/${created.json.data.id}`);
  assert.equal(deleted.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM notification_channels').get().c, 0);
});
