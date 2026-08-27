/**
 * Modul: Countdowns (#647)
 * Zweck: Die drei Zusicherungen, an denen dieses Feature hängt:
 *        1. die Formulierung schaltet an der richtigen Stelle von exakt auf grob
 *           (public/utils/countdown.js),
 *        2. das Einsammeln nimmt beide Quellen, hält die Sichtbarkeit ein und
 *           lässt Vergangenes weg (server/services/countdowns.js),
 *        3. die Markierung überlebt das, was sie überleben muss: den Sync-
 *           Rückweg beim Termin und das Zurücksetzen bei der Aufgabe.
 * Ausführen: npm run test:countdown
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'countdown-test-secret';
// Feste Zone, sonst haengt der Termin-mit-Uhrzeit-Fall unten am Rechner, auf dem
// die Suite laeuft. `serverTimeZone()` liest genau diese Variable.
process.env.TZ = 'Europe/Berlin';

const { ALL_MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { getCountdowns, nextEventDate, daysBetween } = await import('../server/services/countdowns.js');
const { MIRRORED_FIELDS } = await import('../server/services/calendar-outbound.js');
const { countdownPhrase, countdownRank, daysBetweenDateKeys } = await import('../public/utils/countdown.js');

// Die meisten Faelle interessiert nur die Liste; `total` hat seine eigenen
// Tests weiter unten.
const cd = (opts) => getCountdowns(get(), opts).items;

const moduleDatabase = get();
const suiteDatabase = buildMigratedDatabase(ALL_MIGRATIONS);
_setTestDatabase(suiteDatabase);
moduleDatabase.close();

const ALICE = seedUser('alice', 'admin');
const BOB = seedUser('bob', 'member');

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

function seedUser(prefix, role) {
  return get().prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, 'hash', ?)
  `).run(`${prefix}-${randomUUID()}`, prefix, role).lastInsertRowid;
}

function seedEvent({
  title = `Event-${randomUUID()}`, start, rule = null, countdown = 1,
  createdBy = ALICE, visibility = 'all',
} = {}) {
  return get().prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, all_day, recurrence_rule, created_by, visibility, countdown)
    VALUES (?, ?, 1, ?, ?, ?, ?)
  `).run(title, start, rule, createdBy, visibility, countdown).lastInsertRowid;
}

function seedTask({
  title = `Task-${randomUUID()}`, due, countdown = 1, status = 'open',
  createdBy = ALICE, visibility = 'all', archivedAt = null,
} = {}) {
  return get().prepare(`
    INSERT INTO tasks (title, category, priority, status, due_date, created_by, visibility, countdown, archived_at)
    VALUES (?, 'misc', 'none', ?, ?, ?, ?, ?, ?)
  `).run(title, status, due, createdBy, visibility, countdown, archivedAt).lastInsertRowid;
}

function reset() {
  get().prepare('DELETE FROM calendar_events').run();
  get().prepare('DELETE FROM tasks').run();
  get().prepare("DELETE FROM sync_config WHERE key = 'disabled_modules'").run();
}

/** Schaltet Module haushaltweit ab - wie die Admin-Seite es schreibt. */
function disableModules(...names) {
  get().prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('disabled_modules', ?)")
    .run(JSON.stringify(names));
}

// --------------------------------------------------------
// 1. Die Formulierung
// --------------------------------------------------------

test('exakt bis 30 Tage - der Fall, den der Thread ausdrücklich benannt hat', () => {
  // „10 Tage bis der Führerschein abläuft" MUSS zehn Tage bleiben und darf nicht
  // zu „ca. 2 Wochen" werden. Das ist die Grenze, an der das Feature hängt.
  assert.deepEqual(countdownPhrase(10), { key: 'dashboard.daysLeft', count: 10 });
  assert.deepEqual(countdownPhrase(30), { key: 'dashboard.daysLeft', count: 30 });
  assert.deepEqual(countdownPhrase(2), { key: 'dashboard.daysLeft', count: 2 });
});

test('heute und morgen bekommen Wörter, keine Zahl', () => {
  // „in 0 Tagen" ist keine Formulierung; beide Schlüssel tragen deshalb auch
  // kein `count` - der Aufrufer darf t() ohne Zählform rufen.
  assert.deepEqual(countdownPhrase(0), { key: 'common.today' });
  assert.deepEqual(countdownPhrase(1), { key: 'common.tomorrow' });
});

test('ab 31 Tagen wird gerundet - Wochen, Monate, Jahre', () => {
  assert.deepEqual(countdownPhrase(31), { key: 'dashboard.countdownWeeks', count: 4 });
  assert.deepEqual(countdownPhrase(60), { key: 'dashboard.countdownWeeks', count: 9 });
  assert.deepEqual(countdownPhrase(61), { key: 'dashboard.countdownMonths', count: 2 });
  assert.deepEqual(countdownPhrase(364), { key: 'dashboard.countdownMonths', count: 12 });
  assert.deepEqual(countdownPhrase(365), { key: 'dashboard.countdownYears', count: 1 });
  // Der Fall aus dem Thread: 1.247 Tage bis zum Ablauf des Führerscheins.
  assert.deepEqual(countdownPhrase(1247), { key: 'dashboard.countdownYears', count: 3 });
});

test('jede Bandgrenze ist lückenlos und monoton - keine Zahl fällt heraus', () => {
  // GEGENPROBE ZUR REGEL OBEN, und sie ist der eigentliche Guard: drei
  // einzelne Beispiele halten auch dann, wenn eine Schwelle um einen Tag
  // danebenliegt. Über den ganzen Bereich geprüft fällt eine Lücke auf.
  const ORDER = ['common.today', 'common.tomorrow', 'dashboard.daysLeft',
    'dashboard.countdownWeeks', 'dashboard.countdownMonths', 'dashboard.countdownYears'];
  let last = -1;
  const falsch = [];
  for (let d = 0; d <= 4000; d++) {
    const rang = ORDER.indexOf(countdownPhrase(d).key);
    if (rang === -1) falsch.push(`${d}: unbekannter Schluessel`);
    else if (rang < last) falsch.push(`${d}: springt zurueck auf ${ORDER[rang]}`);
    else last = rang;
  }
  assert.deepEqual(falsch, [], `Bandgrenzen nicht monoton: ${falsch.slice(0, 5).join('; ')}`);
  // Und keine Zählform darf 0 sein - „ca. 0 Jahre" wäre der Randfall bei 365.
  const nullen = [];
  for (let d = 2; d <= 4000; d++) {
    const p = countdownPhrase(d);
    if (p.count !== undefined && p.count < 1) nullen.push(d);
  }
  assert.deepEqual(nullen, [], `Zählform 0 bei: ${nullen.slice(0, 5).join(', ')}`);
});

test('Tagesdifferenz über Date.UTC - eine Zeitumstellung im Zeitraum verschiebt nichts', () => {
  // Der Anlass: die Differenz zweier LOKALER Mitternachten ist über eine
  // Sommerzeitgrenze 23 bzw. 25 Stunden lang. Beide Rechnungen (Server wie
  // Browser) müssen dieselbe ganze Zahl liefern.
  const faelle = [
    ['2026-03-28', '2026-03-30', 2],   // Umstellung auf Sommerzeit dazwischen
    ['2026-10-24', '2026-10-26', 2],   // Umstellung auf Winterzeit dazwischen
    ['2026-01-01', '2026-01-01', 0],
    ['2026-01-02', '2026-01-01', -1],
    ['2026-01-01', '2027-01-01', 365],
  ];
  for (const [from, to, erwartet] of faelle) {
    assert.equal(daysBetweenDateKeys(from, to), erwartet, `Browser: ${from} → ${to}`);
    assert.equal(daysBetween(from, to), erwartet, `Server: ${from} → ${to}`);
  }
});

// --------------------------------------------------------
// 2. Das Einsammeln
// --------------------------------------------------------

test('sammelt aus beiden Quellen und sortiert nach Nähe, nicht nach Herkunft', () => {
  reset();
  seedEvent({ title: 'Urlaub', start: '2026-09-01' });
  seedTask({ title: 'Führerschein', due: '2026-08-25' });
  seedEvent({ title: 'Disney+ verlängern', start: '2026-08-20' });

  const items = cd({ userId: ALICE, todayKey: '2026-08-17' });
  assert.deepEqual(items.map((c) => c.title), ['Disney+ verlängern', 'Führerschein', 'Urlaub']);
  assert.deepEqual(items.map((c) => c.source), ['event', 'task', 'event']);
  assert.deepEqual(items.map((c) => c.days_until), [3, 8, 15]);
});

test('nur Markiertes kommt an - ein gewöhnlicher Termin und eine gewöhnliche Aufgabe bleiben weg', () => {
  reset();
  seedEvent({ title: 'Zahnarzt', start: '2026-08-20', countdown: 0 });
  seedTask({ title: 'Müll rausbringen', due: '2026-08-18', countdown: 0 });
  assert.deepEqual(cd({ userId: ALICE, todayKey: '2026-08-17' }), []);
});

test('was vorbei ist, bleibt eine Nachfrist lang stehen - und faellt danach heraus', () => {
  // DIE REGEL HAT SICH UMGEDREHT (Critique 2026-08-17). Hier stand „was vorbei
  // ist, zaehlt nicht mehr" mit dem Argument, „ueberfaellig" gebe es fuer
  // Aufgaben schon dreimal. Fuer TERMINE gibt es das nirgends, und der
  // Anlassfall des Threads ist ein Ablaufdatum - der Countdown verschwand genau
  // in dem Moment, in dem die Konsequenz beginnt.
  reset();
  seedEvent({ title: 'Vorgestern', start: '2026-08-15' });
  seedEvent({ title: 'Heute', start: '2026-08-17' });
  seedEvent({ title: 'Genau raus', start: '2026-08-09' });   // 8 Tage her
  seedEvent({ title: 'Gerade drin', start: '2026-08-10' });  // 7 Tage her

  const items = cd({ userId: ALICE, todayKey: '2026-08-17' });
  // Ueberfaelliges zuerst, weil seine Tageszahl negativ ist - das ist die
  // Rangfolge, die die Kachel braucht, ohne eine zweite Sortierregel.
  assert.deepEqual(items.map((c) => c.title), ['Gerade drin', 'Vorgestern', 'Heute']);
  assert.deepEqual(items.map((c) => c.days_until), [-7, -2, 0]);
  assert.ok(!items.some((c) => c.title === 'Genau raus'),
    'Tag 8 liegt ausserhalb der Nachfrist und darf nicht mehr erscheinen');
});

test('eine SERIE laeuft nicht ab - sie hat ein naechstes Mal', () => {
  // Die Nachfrist gilt nur fuer Einmaliges. Wer sie einer jaehrlichen
  // Verlaengerung gaebe, schriebe „seit 3 Tagen abgelaufen" an einen Termin,
  // der in 362 Tagen wieder ansteht.
  reset();
  seedEvent({ title: 'Jaehrlich', start: '2023-08-14', rule: 'FREQ=YEARLY;INTERVAL=1' });
  const items = cd({ userId: ALICE, todayKey: '2026-08-17' });
  assert.equal(items.length, 1);
  assert.equal(items[0].date, '2027-08-14', 'die Serie zeigt nach vorn, nicht auf das letzte Vorkommen');
  assert.ok(items[0].days_until > 0);
});

test('eine ueberfaellige Aufgabe bleibt, eine ueberfaellige WIEDERKEHRENDE nicht', () => {
  reset();
  seedTask({ title: 'Einmalig ueberfaellig', due: '2026-08-15' });
  const wdh = seedTask({ title: 'Wiederkehrend ueberfaellig', due: '2026-08-15' });
  get().prepare('UPDATE tasks SET is_recurring = 1, recurrence_rule = ? WHERE id = ?')
    .run('FREQ=WEEKLY;INTERVAL=1', wdh);
  const items = cd({ userId: ALICE, todayKey: '2026-08-17' });
  assert.deepEqual(items.map((c) => c.title), ['Einmalig ueberfaellig']);
});

test('countdownRank benennt vier Raenge, und seine Grenze ist die der Formulierung', () => {
  assert.equal(countdownRank(-1), 'overdue');
  assert.equal(countdownRank(0), 'now');
  assert.equal(countdownRank(1), 'now');
  assert.equal(countdownRank(2), 'soon');
  assert.equal(countdownRank(30), 'soon');
  assert.equal(countdownRank(31), 'later');
  // DIE EIGENTLICHE ZUSICHERUNG: Rang und Formulierung duerfen nicht zwei
  // Vorstellungen von „nah" haben. Ueberall dort, wo der Text exakt zaehlt,
  // muss der Rang `now` oder `soon` sein - und umgekehrt.
  const falsch = [];
  for (let d = 0; d <= 400; d++) {
    const exakt = ['common.today', 'common.tomorrow', 'dashboard.daysLeft']
      .includes(countdownPhrase(d).key);
    const nah = ['now', 'soon'].includes(countdownRank(d));
    if (exakt !== nah) falsch.push(d);
  }
  assert.deepEqual(falsch, [], `Rang und Formulierung laufen auseinander bei: ${falsch.slice(0, 5).join(', ')}`);
});

test('ein ueberfaelliger Countdown bekommt seine eigene Formulierung', () => {
  assert.deepEqual(countdownPhrase(-1), { key: 'dashboard.countdownOverdue', count: 1 });
  assert.deepEqual(countdownPhrase(-7), { key: 'dashboard.countdownOverdue', count: 7 });
});

test('die Gesamtzahl zaehlt ueber den Schnitt hinaus', () => {
  // Der Server deckelte bei fuenf und sagte es niemandem: bei sechs markierten
  // Eintraegen war der sechste unsichtbar UND unauffindbar, und die Kachel sah
  // dabei vollstaendig aus.
  reset();
  for (let i = 1; i <= 8; i++) seedTask({ title: `Aufgabe ${i}`, due: `2026-09-0${i}` });
  const res = getCountdowns(get(), { userId: ALICE, todayKey: '2026-08-17' });
  assert.equal(res.items.length, 5, 'die Liste bleibt der Vorrat fuer die groesste Kachel');
  assert.equal(res.total, 8, 'die Gesamtzahl kennt auch, was nicht mitgeliefert wurde');
});

/* Die drei folgenden Zusicherungen kommen aus dem Review zu PR #793. Der Filter
 * für abgeschaltete Module sass allein im Browser und griff erst NACH dem
 * Schnitt auf fünf - das konnte die ganze Kachel kosten. */
test('ein abgeschaltetes Modul verdraengt die andere Quelle nicht aus dem Schnitt', () => {
  // Der gemeldete Fall, Zahl fuer Zahl: Kalender abgeschaltet, die fuenf
  // naechsten Countdowns sind Termine, dahinter steht eine markierte Aufgabe.
  // Vorher schickte der Server die fuenf Termine, der Browser warf sie weg, und
  // die Kachel verschwand aus Raster UND Anpassen-Ablage - wegen Eintraegen,
  // die der Haushalt gar nicht sehen darf.
  reset();
  for (let i = 1; i <= 5; i++) seedEvent({ title: `Termin ${i}`, start: `2026-08-2${i}` });
  seedTask({ title: 'Führerschein', due: '2029-04-01' });
  disableModules('calendar');
  const res = getCountdowns(get(), { userId: ALICE, todayKey: '2026-08-17' });
  assert.deepEqual(res.items.map((c) => c.title), ['Führerschein'],
    'die Aufgabe hinter den fuenf Terminen muss ankommen');
  assert.equal(res.total, 1, 'die Gesamtzahl zaehlt nur, was gezeigt werden darf');
});

test('sind beide Module abgeschaltet, gibt es keinen Countdown', () => {
  reset();
  seedEvent({ title: 'Urlaub', start: '2026-09-01' });
  seedTask({ title: 'Luftfilter', due: '2026-09-02' });
  disableModules('calendar', 'tasks');
  const res = getCountdowns(get(), { userId: ALICE, todayKey: '2026-08-17' });
  assert.deepEqual(res.items, []);
  assert.equal(res.total, 0);
});

test('ein unlesbarer Wert schaltet nichts ab, statt alles auszublenden', () => {
  // Die einzige sichere Auslegung: die andere Richtung liesse ein kaputtes JSON
  // stumm die halbe Kachel schlucken.
  reset();
  seedEvent({ title: 'Urlaub', start: '2026-09-01' });
  seedTask({ title: 'Luftfilter', due: '2026-09-02' });
  for (const broken of ['{kaputt', '"kalender"', 'null']) {
    get().prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('disabled_modules', ?)")
      .run(broken);
    assert.equal(getCountdowns(get(), { userId: ALICE, todayKey: '2026-08-17' }).total, 2,
      `unlesbarer Wert ${broken} darf nichts ausblenden`);
  }
});

test('eine Serie zeigt auf ihr nächstes Vorkommen, nicht auf den Start in der Vergangenheit', () => {
  // @Kyrodans Fall: „Disney+ verlängern" liegt als jährlicher Termin im
  // Kalender, sein Master-Start ist Jahre alt. Ohne Aufholen zeigte der
  // Countdown auf ein Datum in der Vergangenheit - also auf gar nichts.
  reset();
  seedEvent({ title: 'Disney+ verlängern', start: '2023-11-04', rule: 'FREQ=YEARLY;INTERVAL=1' });
  const items = cd({ userId: ALICE, todayKey: '2026-08-17' });
  assert.equal(items.length, 1);
  assert.equal(items[0].date, '2026-11-04');
  assert.equal(items[0].recurring, true);
});

test('ein ausgenommenes Vorkommen (EXDATE) wird übersprungen, nicht gezeigt', () => {
  reset();
  const id = seedEvent({ title: 'Monatlich', start: '2026-01-05', rule: 'FREQ=MONTHLY;INTERVAL=1' });
  get().prepare('INSERT INTO calendar_event_exceptions (event_id, exception_date) VALUES (?, ?)')
    .run(id, '2026-09-05');
  const items = cd({ userId: ALICE, todayKey: '2026-08-17' });
  assert.equal(items[0].date, '2026-10-05', 'die ausgenommene Instanz wurde als Ziel genommen');
});

test('Sichtbarkeit gilt auch hier: fremde private Einträge zählen für niemanden sonst herunter', () => {
  reset();
  seedEvent({ title: 'Alices Termin', start: '2026-08-20', createdBy: ALICE, visibility: 'private' });
  seedTask({ title: 'Alices Aufgabe', due: '2026-08-21', createdBy: ALICE, visibility: 'private' });
  seedEvent({ title: 'Gemeinsam', start: '2026-08-22', createdBy: ALICE, visibility: 'all' });

  const fuerAlice = cd({ userId: ALICE, todayKey: '2026-08-17' });
  assert.equal(fuerAlice.length, 3);
  const fuerBob = cd({ userId: BOB, todayKey: '2026-08-17' });
  assert.deepEqual(fuerBob.map((c) => c.title), ['Gemeinsam']);
});

test('erledigte und abgelegte Aufgaben zählen nicht mehr herunter', () => {
  reset();
  seedTask({ title: 'Erledigt', due: '2026-08-20', status: 'done' });
  seedTask({ title: 'Abgelegt', due: '2026-08-21', archivedAt: '2026-08-16T10:00:00Z' });
  seedTask({ title: 'Offen', due: '2026-08-22' });
  const items = cd({ userId: ALICE, todayKey: '2026-08-17' });
  assert.deepEqual(items.map((c) => c.title), ['Offen']);
});

test('eine markierte Aufgabe ohne Fälligkeit hat nichts, worauf sie zeigen könnte', () => {
  reset();
  seedTask({ title: 'Ohne Datum', due: null });
  assert.deepEqual(cd({ userId: ALICE, todayKey: '2026-08-17' }), []);
});

test('ein Termin mit Uhrzeit zählt auf SEINEN Kalendertag, nicht auf den UTC-Tag', () => {
  // 20.09. 23:00Z ist in Europe/Berlin der 21.09. um 01:00 - der Kalender zeigt
  // den 21., und der Countdown muss denselben Tag meinen. Der rohe Datumsanteil
  // (`slice(0,10)`) hätte hier einen Tag zu wenig gezählt.
  assert.equal(
    nextEventDate({ start_datetime: '2026-09-20T23:00:00Z', all_day: 0 }, '2026-08-17'),
    '2026-09-21',
  );
  // Ein ganztägiger Termin trägt sein Datum ohne Zeitanteil - da gibt es nichts
  // umzurechnen, und wer es täte, verschöbe ihn.
  assert.equal(
    nextEventDate({ start_datetime: '2026-09-20', all_day: 1 }, '2026-08-17'),
    '2026-09-20',
  );
  // Und die Serie erbt den lokalen Tag als Anker, sonst läge jedes Vorkommen
  // um denselben einen Tag daneben.
  assert.equal(
    nextEventDate(
      { start_datetime: '2023-09-20T23:00:00Z', all_day: 0, recurrence_rule: 'FREQ=YEARLY;INTERVAL=1' },
      '2026-08-17',
    ),
    '2026-09-21',
  );
});

test('nextEventDate gibt für einen vergangenen Einzeltermin nichts zurück', () => {
  assert.equal(nextEventDate({ start_datetime: '2026-08-16' }, '2026-08-17'), null);
  assert.equal(nextEventDate({ start_datetime: '2026-08-17' }, '2026-08-17'), '2026-08-17');
  assert.equal(nextEventDate({ start_datetime: 'kaputt' }, '2026-08-17'), null);
});

// --------------------------------------------------------
// 3. Was die Markierung überleben muss
// --------------------------------------------------------

test('die Markierung ist kein gespiegeltes Feld - sie löst keinen Push zum Anbieter aus', () => {
  // Der Thread hat genau das zugesagt: die Markierung bleibt hier und taucht
  // weder in Google noch in der Kalender-App des Telefons auf. Sie darf deshalb
  // nicht in MIRRORED_FIELDS stehen - stünde sie dort, würde ein Setzen als
  // Änderung am Termin gelesen und hochgeladen.
  assert.ok(!MIRRORED_FIELDS.includes('countdown'),
    'countdown steht in MIRRORED_FIELDS - dann wandert eine reine Anzeigeeinstellung zum Anbieter');
});

test('das Zurücksetzen einer Serie nimmt die Markierung mit (#647 + #658)', async () => {
  // DER FALL, DER DAS FEATURE FUER @jamespurnama1 TRAEGT: „immer wieder N Jahre"
  // ist eine Aufgabe, die ab ihrer Erledigung neu rechnet. Verlöre die
  // Folgeinstanz die Markierung, wäre der Countdown nach dem ersten
  // Zurücksetzen weg - und zwar lautlos, weil die Folgeaufgabe sonst
  // vollständig aussieht (dieselbe Falle wie bei Tags und
  // recurrence_from_completion).
  reset();
  const { default: tasksRouter } = await import('../server/routes/tasks.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authUserId = ALICE;
    req.authRole = 'admin';
    req.session = { userId: ALICE, role: 'admin' };
    next();
  });
  app.use('/api/v1/tasks', tasksRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/tasks`;

  try {
    const created = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Luftfilter reinigen',
        due_date: '2026-08-25',
        is_recurring: 1,
        recurrence_rule: 'FREQ=DAILY;INTERVAL=90',
        recurrence_from_completion: 1,
        countdown: 1,
      }),
    });
    const { data: task } = await created.json();
    assert.equal(task.countdown, 1, 'die Markierung kam beim Anlegen nicht an');

    const done = await fetch(`${base}/${task.id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });
    assert.equal(done.status, 200);

    const followup = get().prepare(
      'SELECT countdown, due_date FROM tasks WHERE recurrence_origin_id = ?'
    ).get(task.id);
    assert.ok(followup, 'keine Folgeinstanz angelegt');
    assert.equal(followup.countdown, 1,
      'die Folgeinstanz hat die Countdown-Markierung verloren - der Countdown wäre nach dem ersten Zurücksetzen still weg');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('ein PUT ohne das Feld löscht eine gesetzte Markierung nicht', async () => {
  // Ein Modul oder eine ältere App, die `countdown` nicht kennt, schickt beim
  // Speichern alles andere mit. Nicht mitgeschickt heisst „nicht angefasst" -
  // sonst räumte ein fremder Client die Markierung stillschweigend ab.
  reset();
  const { default: tasksRouter } = await import('../server/routes/tasks.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authUserId = ALICE;
    req.authRole = 'admin';
    req.session = { userId: ALICE, role: 'admin' };
    next();
  });
  app.use('/api/v1/tasks', tasksRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/tasks`;

  try {
    const id = seedTask({ title: 'Versicherung', due: '2026-12-01', countdown: 1 });
    const res = await fetch(`${base}/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Versicherung', due_date: '2026-12-01' }),
    });
    assert.equal(res.status, 200);
    const row = get().prepare('SELECT countdown FROM tasks WHERE id = ?').get(id);
    assert.equal(row.countdown, 1, 'ein PUT ohne das Feld hat die Markierung gelöscht');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
