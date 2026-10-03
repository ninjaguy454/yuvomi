import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import {fork} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
process.env.DB_PATH=':memory:';process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {acceptanceOptions}=await import('../server/services/task-acceptance-policy.js');
const dir=mkdtempSync(join(tmpdir(),'vidamia-acceptance-races-')),path=join(dir,'synthetic.db');
const d=new Database(path);d.pragma('foreign_keys=ON');d.pragma('journal_mode=WAL');
for(const m of ALL_MIGRATIONS){if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);})();if(m.foreignKeysOff)d.pragma('foreign_keys=ON');}
_setTestDatabase(d);
for(const id of [1,2,3])d.prepare("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(?,?,?,'x','admin')").run(id,`Race${id}`,`Race${id}`);
const workers=[];
async function worker(){
  const child=fork(new URL('./helpers/task-acceptance-race-worker.mjs',import.meta.url),[],{env:{...process.env,ACCEPTANCE_FIXTURE:path},stdio:['ignore','ignore','pipe','ipc']});workers.push(child);
  await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>reject(new Error(`Worker exited ${code}`)));child.once('message',message=>message.ready?resolve():reject(new Error(JSON.stringify(message))));});return child;
}
const pool=await Promise.all([worker(),worker()]);
function run(child,message){return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Acceptance worker timed out')),15000);child.once('message',value=>{clearTimeout(timeout);resolve(value);});child.send(message);});}
test.after(async()=>{await Promise.all(workers.map(child=>new Promise(resolve=>{child.once('exit',resolve);child.kill();})));_setTestDatabase(null);d.close();assert.equal(dirname(resolve(dir)),resolve(tmpdir()));rmSync(dir,{recursive:true,force:true});});
function draft(){const id=Number(d.prepare("INSERT INTO tasks(title,created_by) VALUES('Contended offer',1)").run().lastInsertRowid);const detail=acceptanceOptions(d,2,id);return {id,body:{operation_id:`race-${id}`,expected_revision:detail.expected_revision,coassignee_ids:[],subtask_snapshot:[],subtask_assignments:[]}};}
test('two real processes cannot both claim the same revision',async()=>{
  const {id,body}=draft();const results=await Promise.all(pool.map((child,index)=>run(child,{id,body:{...body,operation_id:`${body.operation_id}-${index}`},actor:index+2})));
  assert.equal(results.filter(r=>r.result?.replayed===false).length,1,JSON.stringify(results));assert.equal(results.filter(r=>r.error?.status===409).length,1,JSON.stringify(results));
  const winner=d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(id).assigned_to;assert.ok([2,3].includes(winner));assert.deepEqual(d.prepare('SELECT user_id FROM task_assignments WHERE task_id=?').all(id),[{user_id:winner}]);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_acceptance_receipts WHERE task_id=?').get(id).n,1);assert.equal(d.prepare("SELECT COUNT(*) n FROM task_activity_events WHERE task_id=? AND event_type='claimed'").get(id).n,1);
});
test('simultaneous retries of one operation commit once and replay the current reference',async()=>{
  const {id,body}=draft();const results=await Promise.all(pool.map(child=>run(child,{id,body,actor:2})));
  assert.deepEqual(results.map(r=>r.result?.replayed).sort(),[false,true],JSON.stringify(results));
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_acceptance_receipts WHERE task_id=?').get(id).n,1);assert.equal(d.prepare("SELECT COUNT(*) n FROM task_activity_events WHERE task_id=? AND event_type='claimed'").get(id).n,1);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_ledger WHERE task_id=?').get(id).n,0);
});
