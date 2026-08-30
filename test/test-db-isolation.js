/**
 * Modul: Test-Isolation gegen streunende Datenbankdateien
 * Zweck: server/db.js ruft init() beim Import auf. Eine Suite, die das Modul
 *        (auch nur mittelbar) lädt, ohne DB_PATH zu setzen, öffnet damit die
 *        echte Datei im Repo-Wurzelverzeichnis: sie legt yuvomi.db an und
 *        nimmt in den nächsten Lauf mit, was der vorige hinterlassen hat.
 *        Dieser Test verfolgt die relativen Importe jeder Test-Suite und
 *        verlangt DB_PATH genau dort, wo db.js wirklich erreicht wird.
 * Ausführen: node --test test/test-db-isolation.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, resolve, relative, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DB_MODULE = resolve(ROOT, 'server/db.js');

const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));

// Nur relative Spezifizierer: alles andere zeigt auf node_modules oder
// Node-Builtins und kann db.js nicht ziehen.
const STATIC_IMPORT  = /\bfrom\s+['"](\.[^'"]+)['"]/g;        // import x from './y.js'
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"](\.[^'"]+)['"]/g; // await import('./y.js')

/**
 * Sammelt transitiv alle relativ importierten Dateien ab `entry`.
 * @param {boolean} staticOnly - nur statischen Importen folgen. Die laufen bei
 *   ESM vor jedem Anweisungscode des Moduls, weshalb eine Zuweisung an
 *   process.env dann zu spät käme.
 */
function reachableFiles(entry, staticOnly = false) {
  const patterns = staticOnly ? [STATIC_IMPORT] : [STATIC_IMPORT, DYNAMIC_IMPORT];
  const seen = new Set();
  const queue = [entry];

  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);

    const src = readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      for (const match of src.matchAll(pattern)) {
        queue.push(resolve(dirname(file), match[1]));
      }
    }
  }
  return seen;
}

/**
 * Setzt die Suite DB_PATH selbst - und zwar wirksam? Verlangt einen nicht
 * leeren Wert (db.js behandelt '' wie nicht gesetzt) und eine Zuweisung, die
 * vor jedem dynamischen Import steht, über den db.js geladen wird.
 * Erreicht ein statischer Import db.js, kann keine Zuweisung mehr helfen.
 */
function setsDbPathInTime(entry) {
  if (reachableFiles(entry, true).has(DB_MODULE)) return false;

  const src = readFileSync(entry, 'utf8');
  // Die rechte Seite ist oft ein berechneter Pfad (join(os.tmpdir(), …)), nicht
  // bloß ein Literal. Abgelehnt wird nur der nachweislich wirkungslose Fall:
  // der leere String, den db.js wie "nicht gesetzt" behandelt.
  //
  // ZWEITE FORM: `freshTestDbPath()` aus test/tmp-db.js. Sie setzt DB_PATH
  // ebenfalls, nur eine Datei weiter - und räumt zusätzlich die Datei eines
  // abgebrochenen Vorlaufs weg, bevor sie sie öffnet. Dieser Guard prüfte
  // vorher die SCHREIBWEISE und nicht die Regel: als die neun Datei-Suiten auf
  // den Helfer umzogen, meldete er sie alle als Verstoß, obwohl sie DB_PATH
  // strenger setzen als zuvor. Was zählt, ist "gesetzt, bevor db.js lädt".
  const assignment = /process\.env\.DB_PATH\s*=\s*([^;\n]+)|freshTestDbPath\s*\(\s*['"][^'"]+['"]\s*\)/.exec(src);
  if (!assignment) return false;
  if (assignment[1] !== undefined && /^(['"])\s*\1$/.test(assignment[1].trim())) return false;

  const loadPositions = [...src.matchAll(DYNAMIC_IMPORT)]
    .filter((m) => reachableFiles(resolve(dirname(entry), m[1])).has(DB_MODULE))
    .map((m) => m.index);

  return loadPositions.every((pos) => assignment.index < pos);
}

/**
 * Jeder einzelne Node-Aufruf einer Test-Datei in einem npm-Skript.
 * Das Sammelskript `test` verkettet Suiten mit &&, teils über `npm run`,
 * teils direkt als `node …/test-x.js` - beide Formen müssen geprüft werden,
 * denn das Env-Prefix gilt in einer Kette immer nur für seinen eigenen Befehl.
 */
function nodeInvocations(command) {
  return command
    .split('&&')
    .map((segment) => segment.trim())
    .filter((segment) => /(^|\s)node\s/.test(segment))
    .map((segment) => {
      const match = segment.match(/(test\/[\w.-]+\.m?js)/);
      return match ? { segment, entry: resolve(ROOT, match[1]) } : null;
    })
    .filter(Boolean);
}

test('jede Suite, die server/db.js lädt, setzt DB_PATH', () => {
  const offenders = [];

  for (const [name, command] of Object.entries(pkg.scripts)) {
    if (name !== 'test' && !name.startsWith('test:')) continue;

    for (const { segment, entry } of nodeInvocations(command)) {
      if (!reachableFiles(entry).has(DB_MODULE)) continue;

      // Zwei gleichwertige Wege: als Env-Prefix vor dem Aufruf, oder in der
      // Suite selbst gesetzt, bevor sie db.js lädt.
      if (/\bDB_PATH=[^\s'"]/.test(segment)) continue;
      if (setsDbPathInTime(entry)) continue;

      offenders.push(`${name} → ${relative(ROOT, entry)}`);
    }
  }

  assert.deepStrictEqual(
    offenders, [],
    'Diese Suiten laden server/db.js ohne DB_PATH und legen dadurch eine echte '
    + `yuvomi.db im Repo an. Setze DB_PATH=:memory: davor:\n  ${offenders.join('\n  ')}`
  );
});

test('die Reihenfolgeprüfung erkennt wirkungslose Zuweisungen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuvomi-dbguard-'));
  const dbPath = relative(dir, DB_MODULE).replaceAll('\\', '/');
  const write = (name, body) => {
    const file = join(dir, name);
    writeFileSync(file, body);
    return file;
  };

  try {
    // Statischer Import: läuft bei ESM vor jeder Anweisung, die Zuweisung
    // danach kommt zu spät und darf die Suite nicht freisprechen.
    const tooLate = write('too-late.js',
      `import * as db from '${dbPath}';\nprocess.env.DB_PATH = ':memory:';\n`);
    assert.strictEqual(setsDbPathInTime(tooLate), false, 'statischer Import zuerst');

    // Dynamischer Import nach der Zuweisung: so ist es richtig.
    const inTime = write('in-time.js',
      `process.env.DB_PATH = ':memory:';\nconst db = await import('${dbPath}');\n`);
    assert.strictEqual(setsDbPathInTime(inTime), true, 'Zuweisung vor dem Laden');

    // Dynamischer Import vor der Zuweisung: ebenfalls zu spät.
    const wrongOrder = write('wrong-order.js',
      `const db = await import('${dbPath}');\nprocess.env.DB_PATH = ':memory:';\n`);
    assert.strictEqual(setsDbPathInTime(wrongOrder), false, 'Zuweisung nach dem Laden');

    // Leerer Wert: db.js behandelt ihn wie nicht gesetzt.
    const empty = write('empty.js',
      `process.env.DB_PATH = '';\nconst db = await import('${dbPath}');\n`);
    assert.strictEqual(setsDbPathInTime(empty), false, 'leerer Wert ist wirkungslos');

    // Berechneter Pfad: gängige Form in den Route-Tests, muss zählen.
    const computed = write('computed.js',
      `process.env.DB_PATH = join(tmpdir(), 'x.db');\nconst db = await import('${dbPath}');\n`);
    assert.strictEqual(setsDbPathInTime(computed), true, 'berechneter Pfad zählt');

    // Der Helfer setzt DB_PATH eine Datei weiter - er zählt genauso, sonst
    // meldet der Guard eine Suite als Verstoß, die es strenger macht als die
    // Form, die er kennt.
    const viaHelper = write('helper.js',
      `import { freshTestDbPath } from './tmp-db.js';\nfreshTestDbPath('x');\nconst db = await import('${dbPath}');\n`);
    assert.strictEqual(setsDbPathInTime(viaHelper), true, 'freshTestDbPath zählt');

    // Aber auch er hilft nicht, wenn db.js schon statisch geladen wurde.
    const helperTooLate = write('helper-late.js',
      `import * as db from '${dbPath}';\nimport { freshTestDbPath } from './tmp-db.js';\nfreshTestDbPath('x');\n`);
    assert.strictEqual(setsDbPathInTime(helperTooLate), false, 'statischer Import schlägt auch den Helfer');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('der Importverfolger erkennt db.js überhaupt', () => {
  // Schutz gegen einen Guard, der nur deshalb grün ist, weil er nichts findet:
  // eine Suite, die db.js nachweislich lädt, muss auch als solche erkannt werden.
  const known = resolve(ROOT, 'test/test-holidays.js');
  assert.ok(existsSync(known), 'Referenz-Suite fehlt');
  assert.ok(
    reachableFiles(known).has(DB_MODULE),
    'test-holidays.js importiert server/db.js, der Verfolger sieht es aber nicht'
  );
});
