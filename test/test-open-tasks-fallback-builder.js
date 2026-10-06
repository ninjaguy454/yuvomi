import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

const builderUrl=new URL('../deploy/build-open-tasks-fallback.mjs',import.meta.url);
const helperUrl=new URL('./helpers/task-acceptance-rollback.mjs',import.meta.url);
async function builder() {
  // The legacy CLI runs immediately on import. Check its new import-safe API first.
  assert.match(fs.readFileSync(builderUrl,'utf8'),/export function buildOpenTasksFallback\(/,
    'the fallback builder must expose an import-safe rooted transformer');
  return (await import(builderUrl)).buildOpenTasksFallback;
}

const originals={
  'package.json':'{"type":"module"}\n',
  'server/services/task-offers.js':"export function taskOfferState(d,principal,task,{starts,includeFuture=false}={}){return {visible:true,claimable:true};}\nexport const unrelated = 'offers preserved';\n",
  'server/services/task-acceptance-policy.js':"function acceptanceError(message,status,code){return Object.assign(new Error(message),{status,code});}\nexport function acceptanceOptions(d,principal,id,primaryUserId){return {available:true};}\nexport const unrelated = 'policy preserved';\n",
  'server/services/task-acceptance.js':"function acceptanceError(message,status,code){return Object.assign(new Error(message),{status,code});}\nexport function acceptTask(d,principal,taskId,body){return {accepted:true};}\nexport const unrelated = 'acceptance preserved';\n",
  'server/services/note-groups.js':"export const schemaAndMembershipsUnchanged = true;\n",
  'server/services/note-layout-owner.js':"export const ownerInitializationUnchanged = true;\n",
  'server/services/note-layout-owner-schema.js':"export const ownerSchemaUnchanged = true;\n",
  'server/db.js':"export const migration10053Unchanged = true;\n",
  'public/pages/tasks.js':"export const offers = new URLSearchParams(window.location.search).get('offers') === '1';\n",
  'public/pages/notes.js':"const NOTE_GROUPS_INTERFACE_ENABLED = true;\nconst state = {compact: false, active: true};\n",
  'public/styles/notes.css':'.notes { color: teal; }\n',
  'public/styles/tasks.css':'.tasks { color: teal; }\n',
  'public/sw.js':"const CACHE_VERSION = `${APP_RELEASE}-vidamia.64`;\n",
};
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'open-tasks-fallback-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const read=file=>fs.readFileSync(path.join(root,file),'utf8');
  const write=(file,value)=>{fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),value);};
  for(const [file,value] of Object.entries(originals))write(file,value);
  const snapshot=()=>Object.fromEntries(Object.keys(originals).filter(file=>fs.existsSync(path.join(root,file))).map(file=>[file,read(file)]));
  return {root,read,write,snapshot};
}

test('rooted fallback retains the original acceptance pause and disables group presentation',async t=>{
  const f=fixture(t),before=f.snapshot(),build=await builder();
  build(f.root);
  const offers=await import(pathToFileURL(path.join(f.root,'server/services/task-offers.js')));
  const policy=await import(pathToFileURL(path.join(f.root,'server/services/task-acceptance-policy.js')));
  const acceptance=await import(pathToFileURL(path.join(f.root,'server/services/task-acceptance.js')));
  assert.deepEqual(offers.taskOfferState(null,null,null),{visible:false,claimable:false,reason:'acceptance_paused'});
  const paused=e=>e.status===503&&e.code==='acceptance_paused'&&e.message==='New task acceptance is temporarily unavailable. Existing Tasks and Notes remain available.';
  assert.throws(()=>policy.acceptanceOptions(),paused);
  assert.throws(()=>acceptance.acceptTask(),paused);
  assert.equal(offers.unrelated,'offers preserved');assert.equal(policy.unrelated,'policy preserved');assert.equal(acceptance.unrelated,'acceptance preserved');
  for(const file of ['server/services/note-groups.js','server/services/note-layout-owner.js','server/services/note-layout-owner-schema.js','server/db.js'])assert.equal(f.read(file),before[file],'fallback preserves owner backend and schema');
  assert.equal(f.read('public/pages/tasks.js'),'export const offers = false;\n');
  assert.equal(f.read('public/pages/notes.js'),'const NOTE_GROUPS_INTERFACE_ENABLED = false;\nconst state = {compact: true, active: true};\n');
  assert.equal(f.read('public/sw.js'),'const CACHE_VERSION = `${APP_RELEASE}-vidamia.64-acceptance-paused`;\n');
  assert.ok(f.read('public/styles/notes.css').startsWith(before['public/styles/notes.css']));
  assert.ok(f.read('public/styles/tasks.css').startsWith(before['public/styles/tasks.css']));
  assert.match(f.read('public/styles/notes.css'),/#notes-open-tasks \{ display: none !important; \}/);
  assert.match(f.read('public/styles/notes.css'),/\.notes-workspace \{ grid-template-columns: minmax\(0, 1fr\) !important; \}/);
  assert.match(f.read('public/styles/notes.css'),/#notes-compact-view \{ display: none !important; \}/);
  assert.match(f.read('public/styles/tasks.css'),/#filter-open-tasks \{ display: none !important; \}/);
});

for(const [name,file,value] of [
  ['missing offers function','server/services/task-offers.js','export function unrelated() {}\n'],
  ['duplicate offers function','server/services/task-offers.js',originals['server/services/task-offers.js']+'// export function taskOfferState(d,principal,task,{starts,includeFuture=false}={}){\n'],
  ['missing options function','server/services/task-acceptance-policy.js','export function unrelated() {}\n'],
  ['missing accept function','server/services/task-acceptance.js','export function unrelated() {}\n'],
  ['missing task filter','public/pages/tasks.js','export const offers = true;\n'],
  ['missing Notes mode','public/pages/notes.js','const state = {compact: false, active: true};\n'],
  ['duplicate Notes mode','public/pages/notes.js',originals['public/pages/notes.js']+'// const NOTE_GROUPS_INTERFACE_ENABLED = true;\n'],
  ['missing List default','public/pages/notes.js','const NOTE_GROUPS_INTERFACE_ENABLED = true;\nconst state = {compact: false};\n'],
  ['wrong cache','public/sw.js',"const CACHE_VERSION='app-vidamia.59';\n"],
  ['suffixed cache','public/sw.js',"const CACHE_VERSION='app-vidamia.64-acceptance-paused';\n"],
  ['longer cache number','public/sw.js',"const CACHE_VERSION='app-vidamia.640';\n"],
  ['duplicate cache','public/sw.js',"const CACHE_VERSION='app-vidamia.64';\nconst duplicate='app-vidamia.64';\n"],
])test(`${name} rejects the source before modifying any file`,async t=>{
  const f=fixture(t),build=await builder();f.write(file,value);const before=f.snapshot();
  assert.throws(()=>build(f.root));assert.deepEqual(f.snapshot(),before);
});

test('a missing late input rejects the tree before modifying any file',async t=>{
  const f=fixture(t),build=await builder();fs.unlinkSync(path.join(f.root,'public/sw.js'));const before=f.snapshot();
  assert.throws(()=>build(f.root));assert.deepEqual(f.snapshot(),before);
});

test('repeating the transformation cannot append styles or repause functions',async t=>{
  const f=fixture(t),build=await builder();build(f.root);const before=f.snapshot();
  assert.throws(()=>build(f.root));assert.deepEqual(f.snapshot(),before);
});

test('CLI uses its supplied root and yields the same files as the exported builder',async t=>{
  const expected=fixture(t),actual=fixture(t),build=await builder();build(expected.root);
  const result=spawnSync(process.execPath,[fileURLToPath(builderUrl),actual.root],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.deepEqual(actual.snapshot(),expected.snapshot());
});

test('the retired downgrade probe fails before the database module can initialize',t=>{
  const f=fixture(t);
  f.write('test/helpers/task-acceptance-rollback.mjs',fs.readFileSync(helperUrl,'utf8'));
  f.write('server/db.js',"throw new Error('DATABASE_IMPORTED_BEFORE_STAGE_VALIDATION');\nexport function get() {}\n");
  f.write('node_modules/express/package.json','{"type":"module","exports":"./index.js"}\n');
  f.write('node_modules/express/index.js','export default function express() {}\n');
  const result=spawnSync(process.execPath,[path.join(f.root,'test/helpers/task-acceptance-rollback.mjs'),'phase2-probe'],{encoding:'utf8'});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/Unsupported recovery stage: phase2-probe/);
  assert.doesNotMatch(result.stderr,/DATABASE_IMPORTED_BEFORE_STAGE_VALIDATION/);
});

function ledgerProbe(t,stage,versions) {
  const f=fixture(t);
  f.write('test/helpers/task-acceptance-rollback.mjs',fs.readFileSync(helperUrl,'utf8'));
  f.write('node_modules/express/package.json','{"type":"module","exports":"./index.js"}\n');
  f.write('node_modules/express/index.js','export default function express() {}\n');
  // These modules isolate the real fixture's migration gate. Any attempt to seed
  // or load data before validating the ledger makes the probe fail differently.
  f.write('server/services/devices.js','export const devicePreset=()=>{}, normalizeDevicePermissions=()=>{}, createDevice=()=>{}, updateDevice=()=>{}, devicePrincipal=()=>{};\n');
  f.write('server/services/note-board.js','export const readNoteBoard=()=>{}, saveNote=()=>{}, setNoteLayout=()=>{};\n');
  f.write('server/services/device-notes.js','export const deviceNotesRequest=()=>{};\n');
  f.write('server/db.js',`const counts=${JSON.stringify(versions)};
    export function get(){return {prepare(sql){
      if(sql==='SELECT MAX(version) n FROM schema_migrations')return {get:()=>({n:10052})};
      if(sql==='SELECT COUNT(*) n FROM schema_migrations WHERE version=?')return {get:version=>({n:counts[version]||0})};
      if(sql==='SELECT COUNT(*) n FROM schema_migrations WHERE version=10050')return {get:()=>({n:counts[10050]||0})};
      throw Error('FIRST_FIXTURE_WRITE_REACHED');
    }}}\n`);
  return spawnSync(process.execPath,[path.join(f.root,'test/helpers/task-acceptance-rollback.mjs'),stage],{encoding:'utf8'});
}

for(const [name,stage,versions,message] of [
  ['missing layout migration','seed',{10052:1},'required migration 10051'],
  ['missing group migration','seed',{10051:1},'required migration 10052'],
  ['duplicate group migration','seed',{10051:1,10052:2},'required migration 10052'],
  ['acceptance already present at seed','seed',{10050:1,10051:1,10052:1},'P3 acceptance migration presence'],
  ['acceptance absent after upgrade','upgrade',{10051:1,10052:1},'P3 acceptance migration presence'],
  ['owner migration missing after upgrade','upgrade',{10050:1,10051:1,10052:1},'Notes owner migration presence'],
  ['owner migration duplicated after upgrade','upgrade',{10050:1,10051:1,10052:1,10053:2},'Notes owner migration presence'],
  ['owner migration present before historical P2 seed','seed',{10051:1,10052:1,10053:1},'Notes owner migration presence'],
])test(`${name} is rejected by the recovery ledger gate despite MAX(version)=10052`,t=>{
  const result=ledgerProbe(t,stage,versions);
  assert.notEqual(result.status,0);assert.ok(result.stderr.includes(message),result.stderr);
  assert.doesNotMatch(result.stderr,/FIRST_FIXTURE_WRITE_REACHED|ENOENT/);
});

test('a valid group-aware P2 ledger passes the gate before fixture seeding starts',t=>{
  const result=ledgerProbe(t,'seed',{10051:1,10052:1});
  assert.notEqual(result.status,0);assert.match(result.stderr,/FIRST_FIXTURE_WRITE_REACHED/);
  assert.doesNotMatch(result.stderr,/required migration|P3 acceptance migration presence/);
});
