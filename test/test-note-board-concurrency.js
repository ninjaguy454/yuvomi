import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='notes-concurrency-synthetic';
const {get}=await import('../server/db.js');
const d=get();d.exec("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(1,'owner','Owner','x','member'); INSERT INTO notes(id,content,created_by) VALUES(1,'Original',1)");
const serviceUrl=new URL('../server/services/note-board.js',import.meta.url).href;
const workerCode=`const {parentPort,workerData}=require('node:worker_threads');
(async()=>{const Database=require('better-sqlite3-multiple-ciphers');const services=await import(workerData.serviceUrl);
const d=new Database(workerData.file);d.pragma('busy_timeout=10000');d.pragma('foreign_keys=ON');
parentPort.postMessage({ready:true});parentPort.once('message',()=>{try{const value=workerData.mode==='layout'?services.setNoteLayout(d,1,1,{expected_layout_revision:0,layout:{x:workerData.x,y:0,width:4,height:6}}):services.updateNote(d,1,1,{expected_revision:1,content:workerData.text});parentPort.postMessage({status:200,value});}catch(error){parentPort.postMessage({status:error.status||500,error:error.message});}finally{d.close();}});})();`;
async function race(file,mode){
  const workers=[0,1].map(i=>new Worker(workerCode,{eval:true,workerData:{file,mode,serviceUrl,x:i*4,text:`Edit ${i}`}}));
  try{
    await Promise.all(workers.map(w=>new Promise((resolve,reject)=>{w.once('error',reject);w.once('message',resolve);} )));
    const pending=workers.map(w=>new Promise((resolve,reject)=>{w.once('error',reject);w.once('message',resolve);}));workers.forEach(w=>w.postMessage('go'));
    return await Promise.all(pending);
  }finally{await Promise.all(workers.map(w=>w.terminate()));}
}
for(const mode of ['layout','content'])test(`two SQLite connections ${mode}: one CAS winner, one conflict, no overwrite`,async()=>{
  const folder=mkdtempSync(join(tmpdir(),'notes-race-')),file=join(folder,'synthetic.db');let check;
  try{
    await d.backup(file);const results=await race(file,mode);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
    check=new Database(file);const note=check.prepare('SELECT * FROM notes WHERE id=1').get();
    if(mode==='layout'){assert.equal(note.content,'Original');assert.equal(note.revision,1);assert.equal(check.prepare('SELECT revision FROM note_layouts WHERE note_id=1').get().revision,1);}
    else{assert.equal(note.revision,2);assert.equal(note.content,results.find(r=>r.status===200).value.content);assert.equal(check.prepare('SELECT COUNT(*) n FROM note_layouts').get().n,0);}
    assert.deepEqual(check.pragma('foreign_key_check'),[]);
  }finally{check?.close();rmSync(folder,{recursive:true,force:true});}
});
