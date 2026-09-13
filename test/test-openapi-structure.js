/**
 * OpenAPI structure guard.
 *
 * Sichert die modulare Aufteilung von server/openapi.js: jede
 * server/openapi/paths/<modul>.js muss in paths/index.js importiert und in
 * buildPaths() gespreadet sein, jedes Fragment nicht leer, und kein Pfad-Key
 * darf über zwei Modul-Dateien kollidieren. Verhindert, dass eine kuenftig
 * angelegte Modul-Datei still aus der Spec faellt.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { buildPaths } from '../server/openapi/paths/index.js';
import { buildOpenApiSpec } from '../server/openapi.js';

const pathsDir = new URL('../server/openapi/paths/', import.meta.url);
const indexSrc = readFileSync(new URL('index.js', pathsDir), 'utf8');
const moduleFiles = readdirSync(pathsDir)
  .filter((f) => f.endsWith('.js') && f !== 'index.js')
  .sort();

test('Task and alternate write contracts expose required revisions and safe append/create exceptions',()=>{
  const paths=buildOpenApiSpec({},'release').paths;
  for(const [path,method] of [
    ['/api/v1/tasks/{id}','put'],['/api/v1/tasks/{id}','delete'],
    ['/api/v1/tasks/{id}/status','patch'],['/api/v1/tasks/{id}/archive','patch'],
    ['/api/v1/tasks/{id}/check','patch'],['/api/v1/tasks/{id}/documents','put'],
    ['/api/v1/tasks/{id}/comments/{commentId}','patch'],['/api/v1/tasks/{id}/comments/{commentId}','delete'],
    ['/api/v1/tasks/{id}/location/promote','post'],['/api/v1/tasks/{id}/supervisor','post'],
    ['/api/v1/automation/tasks/{id}/claim','post'],['/api/v1/automation/tasks/{id}/assignment','put'],
  ]){
    const operation=paths[path][method],schema=operation.requestBody.content['application/json'].schema;
    assert.ok(schema.required.includes('expected_revision'),`${method} ${path}`);
    assert.equal(schema.properties.expected_revision.minimum,1);
    if(!path.endsWith('/supervisor'))assert.ok(schema.properties.expected_parent_revision);
    assert.ok(operation.responses[428]);assert.ok(operation.responses[409]);
  }
  const supervisor=paths['/api/v1/tasks/{id}/supervisor'].post;
  assert.ok(supervisor.requestBody.content['application/json'].schema.properties.expected_source_revision);
  assert.match(supervisor.description,/canonical source Task/);
  for(const path of ['/api/v1/automation/obligations/{id}/respond','/api/v1/housekeeping/visits/{id}/pay']){
    const schema=paths[path].post.requestBody.content['application/json'].schema;
    assert.ok(schema.properties.expected_revision);assert.ok(!schema.required.includes('expected_revision'),'Task-less actions remain valid');
  }
  assert.ok(!paths['/api/v1/tasks'].post.requestBody.content['application/json'].schema.required?.includes('expected_revision'));
  assert.match(paths['/api/v1/tasks'].post.description,/top-level Task needs no revision/);
  assert.match(paths['/api/v1/tasks/{id}/comments'].post.description,/does not require Task revision/);
});

async function fragmentOf(file) {
  const mod = await import(new URL(file, pathsDir));
  const fnNames = Object.keys(mod).filter((k) => typeof mod[k] === 'function');
  assert.equal(fnNames.length, 1, `${file} muss genau eine Pfad-Funktion exportieren`);
  return { fn: fnNames[0], frag: mod[fnNames[0]]() };
}

test('es existiert eine plausible Zahl an Modul-Dateien', () => {
  assert.ok(moduleFiles.length >= 20, `unerwartet wenige Modul-Dateien: ${moduleFiles.length}`);
});

test('jede Modul-Datei ist importiert, gespreadet und liefert gueltige Pfade', async () => {
  for (const file of moduleFiles) {
    const { fn, frag } = await fragmentOf(file);
    assert.ok(indexSrc.includes(`from './${file}'`), `${file} wird in paths/index.js nicht importiert`);
    assert.ok(indexSrc.includes(`...${fn}()`), `${fn}() wird in buildPaths() nicht gespreadet`);
    const keys = Object.keys(frag);
    assert.ok(keys.length > 0, `${file} liefert ein leeres Pfad-Fragment`);
    for (const key of keys) {
      assert.ok(key.startsWith('/'), `${file}: ungueltiger Pfad-Key ${key}`);
    }
  }
});

test('keine Pfad-Kollision ueber Modul-Dateien (keine still verlorenen Routen)', async () => {
  let fragTotal = 0;
  const seen = new Set();
  for (const file of moduleFiles) {
    const { frag } = await fragmentOf(file);
    for (const key of Object.keys(frag)) {
      assert.ok(!seen.has(key), `Pfad ${key} kommt in mehreren Modul-Dateien vor`);
      seen.add(key);
      fragTotal += 1;
    }
  }
  const combined = Object.keys(buildPaths()).length;
  assert.equal(combined, fragTotal, 'buildPaths() Pfad-Zahl weicht von der Summe der Fragmente ab');
});

test('buildOpenApiSpec spiegelt buildPaths() vollstaendig', () => {
  const spec = buildOpenApiSpec({}, 'test');
  assert.deepEqual(Object.keys(spec.paths), Object.keys(buildPaths()));
  assert.ok(spec.tags.length > 0, 'tags fehlen in der Spec');
  assert.ok(Object.keys(spec.components.schemas).length > 0, 'schemas fehlen in der Spec');
});

test('personal inbox operations document session-only access and valid response references', () => {
  const spec = buildOpenApiSpec({}, 'test');
  const paths = Object.entries(spec.paths).filter(([path]) => path.startsWith('/api/v1/notifications/inbox') || path === '/api/v1/notifications/preferences');
  assert.equal(paths.length, 5);
  function checkReferences(value) {
    if (!value || typeof value !== 'object') return;
    if (value.$ref?.startsWith('#/')) {
      const target = value.$ref.slice(2).split('/').reduce((node, key) => node?.[key], spec);
      assert.notEqual(target, undefined, `Unresolved notification reference ${value.$ref}`);
    }
    for (const nested of Object.values(value)) checkReferences(nested);
  }
  for (const [, operations] of paths) {
    for (const operation of Object.values(operations)) {
      assert.deepEqual(operation.security, [{ cookieAuth: [] }]);
      checkReferences(operation);
    }
  }
});

test('kein Pfad-Parameter mit Namens-Bedeutung ist als Zahl deklariert', () => {
  // idParam() setzt hart `type: integer`; fuer Namen und Schluessel gibt es
  // stringPathParam(). Wird der falsche Helfer genommen, ist die Spec still
  // falsch: ein Client, der daraus generiert, weigert sich bei
  // `PUT /tasks/tags/Garten` oder schickt eine Zahl. Aufgefallen ist das beim
  // Tag-Endpunkt (#586), der das Muster von der Kategorie-Zeile daneben geerbt
  // hatte - beide waren betroffen, in Tasks wie in Contacts.
  //
  // Die Regel greift in der wirksamen Richtung: ein numerischer Parameter heisst
  // `id`, endet auf `Id` oder benennt eine POSITION. Umgekehrt darf ein `id`
  // durchaus ein String sein (Modul-IDs sind Slugs), deshalb wird nur die
  // Zahl-Seite geprueft.
  //
  // Warum ein Index dazugehoert und keine Ausnahme ist: der Guard faengt einen
  // frei waehlbaren NAMEN, der faelschlich als Zahl deklariert wurde - ein Tag
  // heisst "Garten", ein Modul traegt einen Slug. Ein Index ist kein Bezeichner,
  // sondern eine Stelle in einer Folge; er ist per Definition eine Zahl und
  // kann gar kein Wort sein. Wer hier etwas ergaenzt, muss dasselbe zeigen
  // koennen.
  const NUMERIC_BY_NATURE = /^(position|index)$/;
  const paths = buildPaths();
  const offenders = [];

  for (const [path, operations] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      for (const parameter of operation.parameters ?? []) {
        if (parameter.in !== 'path') continue;
        if (parameter.schema?.type !== 'integer') continue;
        if (/^id$|Id$/.test(parameter.name)) continue;
        if (NUMERIC_BY_NATURE.test(parameter.name)) continue;
        offenders.push(`${method.toUpperCase()} ${path} -> {${parameter.name}}`);
      }
    }
  }

  assert.deepEqual(offenders, [],
    `Diese Pfad-Parameter tragen einen Namen, sind aber als integer deklariert:\n${offenders.join('\n')}`);
});
