import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import Database from 'better-sqlite3-multiple-ciphers';
import {fixture,command,state} from './helpers/note-group-fixture.mjs';
const service=await import('../server/services/note-groups.js');
async function race(file,commands){
  const workers=commands.map(command=>new Worker(new URL('./helpers/note-group-race-worker.mjs',import.meta.url),{workerData:{file,command}}));
  try{
    await Promise.all(workers.map(w=>new Promise((resolve,reject)=>{w.once('error',reject);w.once('message',resolve);} )));
    const pending=workers.map(w=>new Promise((resolve,reject)=>{w.once('error',reject);w.once('message',resolve);}));workers.forEach(w=>w.postMessage('go'));return await Promise.all(pending);
  }finally{await Promise.all(workers.map(w=>w.terminate()));}
}
for(const retry of [false,true])test(`independent connections ${retry?'retry one operation once':'compete for transfer with one winner'}`,async()=>{
  const {d,group}=fixture(6),folder=mkdtempSync(join(tmpdir(),'groups-race-')),file=join(folder,'synthetic.db');let check;
  try{
    assert.equal(typeof service.applyNoteGroupCommand,'function','canonical command service exists');
    const a=group([1,2,3]),b=group([4,5,6]),c=command(d,'transfer',{source_group_id:a,target_group_id:b,selected_ids:[2],before_note_id:5},[1,2,3,4,5,6],[a,b]);
    const other=retry?c:{...c,operation_id:'competitor',selected_ids:[3]};await d.backup(file);const results=await race(file,[c,other]);assert.deepEqual(results.map(r=>r.status).sort(),retry?[200,200]:[200,409]);
    if(retry)assert.equal(results.filter(r=>r.value.replayed).length,1);
    check=new Database(file);check.pragma('foreign_keys=ON');assert.equal(check.prepare('SELECT count(*) n FROM note_group_receipts').get().n,1);assert.deepEqual(check.prepare('SELECT revision FROM note_groups').all().map(g=>g.revision),[2,2]);assert.deepEqual(check.pragma('foreign_key_check'),[]);
    // Apply the winning request independently to prove the loser changed no clocks,
    // memberships, layouts, receipts or note content.
    const winning=results[0].status===200&&!results[0].value?.replayed?c:other;service.applyNoteGroupCommand(d,1,winning);
    const comparable=db=>{const s=state(db);s.note_group_receipts=s.note_group_receipts.map(({created_at,...r})=>r);return s;};assert.deepEqual(comparable(check),comparable(d));
  }finally{check?.close();d.close();rmSync(folder,{recursive:true,force:true});}
});
