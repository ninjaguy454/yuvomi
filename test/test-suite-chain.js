/**
 * Modul: Test-Infrastruktur - Suite-Registry-Guard
 * Zweck: Jede Suite läuft wirklich. Beim Docs-Audit 2026-08-05 lagen fünf
 *        Suiten mit test:-Script vor, hingen aber nicht in der npm-test-Kette
 *        und liefen damit monatelang weder lokal (npm test) noch in CI - eine
 *        davon war still verrottet. Dieser Guard schließt genau dieses Loch:
 *        (1) jedes test:*-Script hängt in der test-Kette, (2) jede
 *        test/test-*.js-Datei wird von einem Script referenziert.
 * Ausführen: node --test test/test-suite-chain.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const suiteScripts = Object.keys(pkg.scripts).filter((k) => k.startsWith('test:'));

const suiteFile = (name) => pkg.scripts[name].match(/test\/[\w.-]+\.js/)?.[0];

/**
 * Eine Suite braucht einen Browser, wenn ihre Datei ihn importiert.
 *
 * DAS IST DAS KRITERIUM, NICHT DER NAME. `npm test` ist netzfrei und serverlos:
 * die Suiten importieren Route-Handler direkt gegen In-Memory-SQLite. Eine
 * Suite, die einen echten Browser gegen einen echten Serverprozess fährt,
 * gehört dort nicht hinein - und eine Namensausnahme („außer
 * test:document-guards") wäre wieder eine Allowlist, die beim zweiten Fall
 * fehlt. Geprüft wird deshalb die Bauart der Datei.
 */
/**
 * Der Einstieg der Browser-Kette - ein NAME, und trotzdem keine Namensausnahme.
 *
 * Der Docblock darüber verbietet, eine Suite nach ihrem Namen der einen oder
 * anderen Kette zuzuordnen; das entscheidet `needsBrowser()` über die Bauart.
 * Dieses Script ist aber keine Suite, sondern die KETTE selbst - es kann nicht
 * in sich hängen, so wie `pkg.scripts.test` nicht in sich hängt. Deshalb steht
 * es hier einmal benannt und nicht in einer Liste, die wachsen könnte.
 */
const BROWSER_CHAIN = 'test:document-guards';

function needsBrowser(name) {
  const file = suiteFile(name);
  if (!file) return false;
  const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  // Die IMPORT-KANTE, nicht ein Textvorkommen: eine Datei, die den Namen des
  // Browsertreibers nur in einem Kommentar oder einem Regex nennt, fährt
  // keinen Browser. Diese Datei hier ist der erste Beweis dafür - eine
  // Textsuche hielt sie für ihre eigene Ausnahme.
  const imports = [...src.matchAll(/^\s*import[^;]*from\s*'([^']+)'/gm)].map((m) => m[1]);
  return imports.some((spec) => spec === 'puppeteer' || spec.includes('document-guards-harness'));
}

function invokedScripts(script) {
  return script.split(/\s*&&\s*/).flatMap((command) => {
    const match = command.match(/^npm run ([\w:-]+)(?:\s+--.*)?$/);
    return match ? [match[1]] : [];
  });
}

/**
 * Follow npm-script edges recursively. The full suite is split into short
 * chains for Windows, so inspecting only `scripts.test` is no longer enough.
 * Exact tokens matter: `test:search` is not `test:search-diacritics`.
 */
function collectChain(entry) {
  const scripts = new Set();
  const files = new Set();
  const missing = new Set();
  const cycles = [];

  function visit(name, path = []) {
    if (path.includes(name)) {
      cycles.push([...path, name].join(' -> '));
      return;
    }
    if (scripts.has(name)) return;

    const script = pkg.scripts[name];
    if (!script) {
      missing.add(name);
      return;
    }

    scripts.add(name);
    for (const match of script.matchAll(/test\/[\w.-]+\.js/g)) files.add(match[0]);
    for (const child of invokedScripts(script)) visit(child, [...path, name]);
  }

  visit(entry);
  return { scripts, files, missing, cycles };
}

const testChain = collectChain('test');
const browserChain = collectChain(BROWSER_CHAIN);

const runsIn = (chain, name) => {
  if (chain.scripts.has(name)) return true;
  const file = suiteFile(name);
  return Boolean(file && chain.files.has(file));
};

test('jedes test:*-Script hängt in genau einer Kette', () => {
  // Die Kette ruft Suiten entweder als `npm run test:x` oder inlined sie als
  // direktes node-Kommando - dann genügt der Testdatei-Pfad als Nachweis.
  const wrong = [
    ...[...testChain.missing].map((name) => `npm test references missing script ${name}`),
    ...testChain.cycles.map((cycle) => `cycle in npm test: ${cycle}`),
    ...[...browserChain.missing].map((name) => `${BROWSER_CHAIN} references missing script ${name}`),
    ...browserChain.cycles.map((cycle) => `cycle in ${BROWSER_CHAIN}: ${cycle}`),
  ];
  for (const name of suiteScripts) {
    if (name === BROWSER_CHAIN) continue; // die Kette selbst, siehe oben
    const browser = needsBrowser(name);
    const inTestChain = runsIn(testChain, name);
    const inBrowserChain = runsIn(browserChain, name);
    if (browser && inTestChain) {
      wrong.push(`${name} fährt einen Browser und hängt trotzdem in npm test - dort ist kein Server`);
    }
    if (browser && !inBrowserChain) {
      wrong.push(`${name} needs a browser but is not reachable from ${BROWSER_CHAIN}`);
    }
    if (!browser && inBrowserChain) {
      wrong.push(`${name} does not need a browser but is reachable from ${BROWSER_CHAIN}`);
    }
    if (!browser && !inTestChain) {
      wrong.push(`${name} läuft nirgends - in die test-Kette einhängen (Schritt 3 in docs/test-suites.md)`);
    }
  }
  assert.deepEqual(wrong, [], wrong.join('\n  '));
});

test('jede npm-test-Teilkette passt sicher in die Windows-Kommandozeile', () => {
  // cmd.exe permits 8,191 characters. Leave room for npm's shell prefix,
  // quoting, and the path to the npm installation.
  const safeLimit = 7500;
  const oversized = [...testChain.scripts]
    .filter((name) => pkg.scripts[name].length > safeLimit)
    .map((name) => `${name} (${pkg.scripts[name].length})`);
  assert.deepEqual(
    oversized,
    [],
    `npm-test script exceeds the safe Windows limit: ${oversized.join(', ')}`,
  );
});

test('die Browser-Suiten laufen unter test:document-guards', () => {
  const browserSuites = suiteScripts.filter((n) => n !== BROWSER_CHAIN && needsBrowser(n));
  const entry = pkg.scripts[BROWSER_CHAIN];
  assert.ok(entry, `${BROWSER_CHAIN} fehlt - die Browser-Kette braucht einen Einstieg.`);

  // REICHWEITE VOR DEM URTEIL. `browserSuites` ist heute LEER - es gibt genau
  // eine Suite mit Browserbedarf, und das ist die Kette selbst. Die Zusicherung
  // darunter laeuft damit ueber eine leere Liste und sagt fuer sich genommen
  // nichts. Was sie traegt, ist der Nachweis, dass das Kriterium ueberhaupt
  // greift: erkennt `needsBrowser()` den Einstieg nicht mehr, ist jede zweite
  // Browser-Suite unsichtbar geworden, und die leere Liste waere eine
  // Falschmeldung statt eines Befunds.
  assert.ok(needsBrowser(BROWSER_CHAIN),
    'needsBrowser() erkennt den Browserbedarf nicht mehr - ab hier prueft dieser Test nichts');
  const missing = browserSuites.filter((n) => !runsIn(browserChain, n));
  assert.deepEqual(
    missing,
    [],
    `Browser-Suiten ohne Einstieg - an test:document-guards anhängen: ${missing.join(', ')}`,
  );
});

test('jede test/test-*.js-Datei hat ein npm-Script', () => {
  const referenced = new Set(
    Object.values(pkg.scripts).flatMap((v) => [...v.matchAll(/test\/[\w.-]+\.js/g)].map((m) => m[0])),
  );
  const orphans = readdirSync(new URL('../test', import.meta.url))
    .filter((f) => f.startsWith('test-') && f.endsWith('.js'))
    .filter((f) => !referenced.has(`test/${f}`));
  assert.deepEqual(
    orphans,
    [],
    `Testdateien ohne test:-Script - anlegen und in die Kette einhängen: ${orphans.join(', ')}`,
  );
});

/* EINE DATEI-DATENBANK IM TEMP-ORDNER IST EINE FALLE, WENN SIE LIEGEN BLEIBT.
 *
 * Neun Suiten legen ihre Datenbank als `<name>-${process.pid}.db` ab. Wer erst
 * am ENDE aufraeumt, raeumt genau dann nicht auf, wenn es zaehlt: bricht ein
 * Lauf ab, bleibt die Datei stehen. Betriebssysteme vergeben PIDs wieder, und
 * irgendwann oeffnet ein neuer Lauf die volle Datenbank eines alten - er
 * migriert sie, findet Bestandsdaten und scheitert an einem UNIQUE-Constraint,
 * den sein eigener Code nie verletzt haette.
 *
 * Gemessen am 2026-08-29: 182 verwaiste Dateien, aelteste vier Tage alt, und
 * ein roter Lauf, der isoliert nicht zu reproduzieren war. Das ist die teuerste
 * Sorte Fehlschlag - er zeigt auf die Aenderung, die gerade entsteht.
 *
 * Der Guard prueft die REIHENFOLGE-REGEL, nicht eine Liste von Dateinamen:
 * wer `DB_PATH` auf den Temp-Ordner setzt, tut das ueber `freshTestDbPath()`,
 * und die raeumt VOR dem Oeffnen weg. */
test('keine Suite baut ihren Temp-DB-Pfad von Hand zusammen', () => {
  const offenders = readdirSync(new URL('../test', import.meta.url))
    .filter((f) => f.startsWith('test-') && f.endsWith('.js'))
    .filter((f) => {
      const src = readFileSync(new URL(`../test/${f}`, import.meta.url), 'utf8');
      return /process\.env\.DB_PATH\s*=\s*path\.join\(os\.tmpdir\(\)/.test(src);
    });
  assert.deepEqual(
    offenders,
    [],
    'DB_PATH im Temp-Ordner gehoert ueber freshTestDbPath() aus test/tmp-db.js - '
    + `sonst erbt ein Lauf die Datei eines abgebrochenen mit derselben PID: ${offenders.join(', ')}`,
  );
});
