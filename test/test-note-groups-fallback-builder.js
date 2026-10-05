import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildNotesFallback} from '../deploy/build-notes-fallback.mjs';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'notes-fallback-builder-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const dir of ['public/pages','public/styles','server'])fs.mkdirSync(path.join(root,dir),{recursive:true});
  fs.writeFileSync(path.join(root,'public/pages/notes.js'),"const NOTE_GROUPS_INTERFACE_ENABLED = true;\nconst state = {compact: false, active: true};\n");
  fs.writeFileSync(path.join(root,'public/styles/notes.css'),'.notes { color: teal; }\n');
  fs.writeFileSync(path.join(root,'public/sw.js'),"const CACHE_VERSION='app-vidamia.60';\n");
  fs.writeFileSync(path.join(root,'server/unchanged.js'),'export const privateContentPreserved = true;\n');
  const read=file=>fs.readFileSync(path.join(root,file),'utf8');
  const write=(file,value)=>fs.writeFileSync(path.join(root,file),value);
  const snapshot=()=>Object.fromEntries(['public/pages/notes.js','public/styles/notes.css','public/sw.js','server/unchanged.js'].map(file=>[file,read(file)]));
  return {root,read,write,snapshot};
}

test('recovery transformation disables group UI, forces List and isolates its cache without changing backend',t=>{
  const f=fixture(t),before=f.snapshot();
  buildNotesFallback(f.root);
  assert.match(f.read('public/pages/notes.js'),/NOTE_GROUPS_INTERFACE_ENABLED = false/);
  assert.match(f.read('public/pages/notes.js'),/compact: true, active: true/);
  assert.match(f.read('public/sw.js'),/-vidamia\.60-notes-compact/);
  assert.equal(f.read('server/unchanged.js'),before['server/unchanged.js']);
  assert.ok(f.read('public/styles/notes.css').startsWith(before['public/styles/notes.css']));
});

for(const [name,file,value] of [
  ['wrong cache','public/sw.js',"const CACHE_VERSION='app-vidamia.59';\n"],
  ['missing mode','public/pages/notes.js',"const state={compact: false, active: true};\n"],
  ['duplicate mode','public/pages/notes.js',"const NOTE_GROUPS_INTERFACE_ENABLED = true;\n// const NOTE_GROUPS_INTERFACE_ENABLED = true;\nconst state={compact: false, active: true};\n"],
  ['already suffixed cache','public/sw.js',"const CACHE_VERSION='app-vidamia.60-notes-compact';\n"],
  ['longer cache number','public/sw.js',"const CACHE_VERSION='app-vidamia.600';\n"],
  ['wrong compact marker','public/pages/notes.js',"const NOTE_GROUPS_INTERFACE_ENABLED = true;\nconst state={compact: false};\n"],
])test(`${name} fails before changing any file`,t=>{
  const f=fixture(t);f.write(file,value);const before=f.snapshot();
  assert.throws(()=>buildNotesFallback(f.root));assert.deepEqual(f.snapshot(),before);
});

test('a second transformation refuses the already transformed tree without further changes',t=>{
  const f=fixture(t);buildNotesFallback(f.root);const before=f.snapshot();
  assert.throws(()=>buildNotesFallback(f.root));assert.deepEqual(f.snapshot(),before);
});

test('the application template-literal cache receives the recovery suffix',t=>{
  const f=fixture(t);f.write('public/sw.js',"const CACHE_VERSION = `${APP_RELEASE}-vidamia.60`;\n");
  buildNotesFallback(f.root);
  assert.equal(f.read('public/sw.js'),"const CACHE_VERSION = `${APP_RELEASE}-vidamia.60-notes-compact`;\n");
});
