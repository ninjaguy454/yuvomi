/**
 * Tests: Pluralformen in t() (Audit-Befund nach #534)
 * Zweck: `{{count}}`-Strings waren hart im Plural formuliert - „1 Adressbücher
 *        aktiviert". t() wählt jetzt über Intl.PluralRules die passende Variante
 *        (`key_one`, `key_few`, …) und fällt auf den Basisschlüssel zurück,
 *        wenn eine Locale die Variante nicht kennt.
 * Ausführen: node test/test-i18n-plural.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const LOCALE_DIR = new URL('../public/locales/', import.meta.url);
const localeFile = (locale) => JSON.parse(readFileSync(new URL(`${locale}.json`, LOCALE_DIR), 'utf8'));

// i18n.js ist Browser-Code: Umgebung stellen, bevor das Modul geladen wird.
const store = new Map();
global.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
global.document = { documentElement: { lang: '', dir: '' } };
global.window = { dispatchEvent: () => {}, matchMedia: () => ({ matches: false }) };
global.CustomEvent = class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
global.fetch = async (url) => {
  const locale = String(url).replace('/locales/', '').replace('.json', '');
  return { ok: true, json: async () => localeFile(locale) };
};
Object.defineProperty(global, 'navigator', {
  value: { languages: ['de-DE'], language: 'de-DE' },
  writable: true,
  configurable: true,
});

const { initI18n, setLocale, t } = await import('../public/i18n.js');
await initI18n();

test('Deutsch: Singular und Plural je nach count', async () => {
  await setLocale('de');
  assert.equal(t('settings.enabledReminderListCount', { count: 1 }), '1 Erinnerungsliste aktiviert');
  assert.equal(t('settings.enabledReminderListCount', { count: 2 }), '2 Erinnerungslisten aktiviert');
  assert.equal(t('settings.enabledReminderListCount', { count: 0 }), '0 Erinnerungslisten aktiviert');
});

test('Englisch: Singular und Plural je nach count', async () => {
  await setLocale('en');
  assert.equal(t('settings.enabledReminderListCount', { count: 1 }), '1 external list enabled');
  assert.equal(t('settings.enabledReminderListCount', { count: 3 }), '3 external lists enabled');
  assert.equal(t('settings.calendarImport.success', { count: 1 }), '1 event imported.');
  assert.equal(t('settings.calendarImport.success', { count: 4 }), '4 events imported.');
});

test('Sprachen ohne Zahlflexion liefern für jede Anzahl denselben Satz', async () => {
  await setLocale('ja');
  const one = t('settings.enabledReminderListCount', { count: 1 });
  const many = t('settings.enabledReminderListCount', { count: 5 });
  assert.equal(one.replace('1', 'N'), many.replace('5', 'N'));
});

test('Polnisch: fehlende few/many-Variante fällt auf den Basisschlüssel zurück', async () => {
  await setLocale('pl');
  // pl kennt one/few/many/other; hinterlegt sind Basis + _one. Kein Absturz,
  // und das zählunabhängige „Label: N"-Muster bleibt korrekt.
  for (const count of [1, 2, 5, 22]) {
    assert.match(t('settings.enabledReminderListCount', { count }), /Włączone listy przypomnień: \d+/);
  }
});

test('„N von M"-Zähler nutzt bei einem Eintrag die Singularform', async () => {
  // Die _one-Variante ging beim Umbenennen einer früheren Runde verloren:
  // „1 von 1 Adressbüchern aktiv". t() wählt über count (= Gesamtzahl).
  await setLocale('de');
  assert.equal(
    t('settings.addressbooksEnabledOfTotal', { enabled: 1, total: 1, count: 1 }),
    '1 von 1 Adressbuch aktiv',
  );
  assert.equal(
    t('settings.addressbooksEnabledOfTotal', { enabled: 1, total: 3, count: 3 }),
    '1 von 3 Adressbüchern aktiv',
  );
  await setLocale('en');
  assert.equal(
    t('settings.calendarsEnabledOfTotal', { enabled: 0, total: 1, count: 1 }),
    '0 of 1 calendar active',
  );
  assert.equal(
    t('settings.calendarsEnabledOfTotal', { enabled: 2, total: 4, count: 4 }),
    '2 of 4 calendars active',
  );
});

test('Standard-Punkte (#578): zählende Strings nutzen die Singularform', async () => {
  // Review-Fund: die vier count-Strings des Features waren hart im Plural
  // formuliert („1 Aufgaben aktualisiert").
  await setLocale('de');
  assert.equal(t('tasks.pointsSummary', { count: 1 }), '1 Punkt');
  assert.equal(t('tasks.pointsSummary', { count: 10 }), '10 Punkte');
  assert.equal(t('settings.rewardsDefaultPointsRebased', { count: 1 }), '1 Aufgabe aktualisiert.');
  assert.equal(t('settings.rewardsDefaultPointsRebased', { count: 3 }), '3 Aufgaben aktualisiert.');
  assert.match(t('settings.rewardsDefaultPointsRebaseTitle', { count: 1, from: 10, to: 15 }), /^1 Aufgabe von 10 auf 15 /);

  await setLocale('en');
  assert.equal(t('tasks.pointsSummary', { count: 1 }), '1 point');
  assert.equal(t('tasks.pointsSummary', { count: 4 }), '4 points');
  assert.equal(t('settings.rewardsDefaultPointsRebased', { count: 1 }), '1 task updated.');
  assert.equal(t('settings.rewardsDefaultPointsRebased', { count: 2 }), '2 tasks updated.');
});

test('Garantie-Restlaufzeit (Inventar, Stufe 4): zählender String nutzt die Singularform', async () => {
  // Review-Fund: der String wurde mit `days` interpoliert. t() wählt die
  // Pluralvariante ausschließlich über einen numerischen `count` - daher stand
  // dort "in 1 Tagen".
  await setLocale('de');
  assert.equal(t('inventory.warrantyStatusExpiringSoon', { count: 1 }), 'Garantie läuft in 1 Tag ab');
  assert.equal(t('inventory.warrantyStatusExpiringSoon', { count: 12 }), 'Garantie läuft in 12 Tagen ab');

  await setLocale('en');
  assert.equal(t('inventory.warrantyStatusExpiringSoon', { count: 1 }), 'Warranty ends in 1 day');
  assert.equal(t('inventory.warrantyStatusExpiringSoon', { count: 30 }), 'Warranty ends in 30 days');
});

test('Schlüssel ohne Pluralvarianten funktionieren unverändert', async () => {
  await setLocale('de');
  assert.equal(t('common.save'), localeFile('de').common.save);
  // count-Parameter ohne passende Variante (7 → „other"): Basisschlüssel plus Interpolation.
  assert.equal(
    t('settings.enabledReminderListCount', { count: 7 }),
    '7 Erinnerungslisten aktiviert',
  );
});

test('unbekannter Schlüssel liefert den Schlüssel selbst zurück - auch mit count', async () => {
  await setLocale('de');
  assert.equal(t('gibt.es.nicht'), 'gibt.es.nicht');
  assert.equal(t('gibt.es.nicht', { count: 2 }), 'gibt.es.nicht');
});

test('jede Pluralvariante hat einen zählenden Basisschlüssel in allen Locales', () => {
  const files = readdirSync(LOCALE_DIR).filter((f) => f.endsWith('.json'));
  const flatten = (obj, prefix = '', out = new Map()) => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object') flatten(v, key, out);
      else out.set(key, v);
    }
    return out;
  };
  // Pluralvariante = Suffix einer CLDR-Kategorie UND ein {{count}} im Wert.
  // Das trennt sie von echten Enum-Werten wie `budget.accountType_other`.
  for (const file of files) {
    const entries = flatten(JSON.parse(readFileSync(new URL(file, LOCALE_DIR), 'utf8')));
    for (const [key, value] of entries) {
      if (!/_(one|two|few|many|other)$/.test(key)) continue;
      if (typeof value !== 'string' || !value.includes('{{count}}')) continue;
      const base = key.replace(/_(one|two|few|many|other)$/, '');
      assert.ok(entries.has(base), `${file}: ${key} ohne Basisschlüssel ${base}`);
      assert.match(entries.get(base), /\{\{count\}\}/, `${file}: ${base} zählt nicht`);
    }
  }
});

// ---------------------------------------------------------------------------
// Platzhalter-Ersetzung
//
// Die Werte kommen aus Nutzereingaben (Namen, Titel, Notizen). Sie werden
// eingesetzt, nicht interpretiert - weder als Regex-Rückverweis noch als
// weiterer Platzhalter.
// ---------------------------------------------------------------------------

test('Werte mit Ersetzungssyntax werden wörtlich eingesetzt', async () => {
  await setLocale('de');
  // `$&` steht in einem String-Ersatz für den Treffer, `` $` `` für den Text
  // davor. Vorher wurde aus "A $& B" ein "A {{name}} B" und `` $` `` zog den
  // halben Satz in den Namen.
  assert.equal(t('birthdays.calendarEventTitle', { name: 'A $& B' }), 'Geburtstag: A $& B');
  assert.equal(t('birthdays.calendarEventTitle', { name: 'X $` Y' }), 'Geburtstag: X $` Y');
  assert.equal(t('birthdays.calendarEventTitle', { name: "Z $' W" }), "Geburtstag: Z $' W");
  assert.equal(t('birthdays.calendarEventTitle', { name: 'P $$ Q' }), 'Geburtstag: P $$ Q');
});

test('ein Wert, der wie ein Platzhalter aussieht, wird nicht erneut ersetzt', async () => {
  await setLocale('de');
  // Nacheinander ersetzt, hätte der date-Durchgang den eingesetzten Namen
  // nochmals durchsucht und das Datum zweimal geschrieben.
  assert.equal(
    t('birthdays.calendarEventDescription', { name: '{{date}}', date: '01.01.2000' }),
    'Geburtstagserinnerung für {{date}} (01.01.2000).',
  );
});

test('unbekannte Platzhalter bleiben sichtbar stehen', async () => {
  await setLocale('de');
  // Ein vergessener Parameter soll auffallen, nicht still ein Loch hinterlassen.
  assert.equal(
    t('birthdays.calendarEventDescription', { name: 'Emma' }),
    'Geburtstagserinnerung für Emma ({{date}}).',
  );
});

test('Zahlen und Pluralformen ersetzen weiterhin normal', async () => {
  await setLocale('de');
  assert.equal(t('settings.enabledReminderListCount', { count: 1 }), '1 Erinnerungsliste aktiviert');
  assert.equal(t('settings.enabledReminderListCount', { count: 7 }), '7 Erinnerungslisten aktiviert');
});
