import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import {mkdtempSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
process.env.DB_PATH=':memory:';process.env.DB_ENCRYPTION_KEY='';process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS}=await import('../server/db.js');
test('encrypted10062 upgrade adds only empty launch receipts and preserves every existing row and revision',()=>{
 const folder=mkdtempSync(join(tmpdir(),'vidamia-launch-upgrade-')),file=join(folder,'synthetic.db'),key='synthetic-launch-upgrade-only';
 const open=()=>{const d=new Database(file);d.pragma("cipher='sqlcipher'");d.pragma(`key="x'${Buffer.from(key).toString('hex')}'"`);d.pragma('foreign_keys=ON');return d;};
 let d=open();
 try{
  for(const m of ALL_MIGRATIONS.filter(m=>m.version<=10062)){if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);})();if(m.foreignKeysOff)d.pragma('foreign_keys=ON');}
  d.exec("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(1,'Synthetic owner','Synthetic owner','x','admin'),(2,'Synthetic helper','Synthetic helper','x','member'); INSERT INTO tasks(id,title,created_by,assigned_to,points,scoring_mode,is_recurring,recurrence_rule,due_date) VALUES(1,'Existing paid routine',1,2,7,'subtasks',1,'FREQ=DAILY','2026-11-01'); INSERT INTO tasks(id,title,parent_task_id,assigned_to,created_by,points,status) VALUES(2,'Existing paid step',1,2,1,3,'done'); INSERT INTO task_assignments(task_id,user_id) VALUES(1,2),(2,2); INSERT INTO reward_ledger(user_id,delta,type,task_id) VALUES(2,3,'earn',2)");
  const tables=d.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(r=>r.name);
  const snapshot=()=>JSON.stringify(Object.fromEntries(tables.map(name=>[name,d.prepare('SELECT * FROM "'+name+'"').all().map(row=>JSON.stringify(row)).sort()])));
  const before=snapshot(),migration=ALL_MIGRATIONS.find(m=>m.version===10063);assert.equal(ALL_MIGRATIONS.at(-1).version,10063);assert.ok(migration);d.transaction(()=>migration.up(d))();
  assert.equal(snapshot(),before);for(const table of ['task_template_launch_requests','task_template_launch_results'])assert.equal(d.prepare('SELECT COUNT(*) n FROM '+table).get().n,0);
  assert.deepEqual(d.pragma('foreign_key_check'),[]);assert.equal(d.pragma('integrity_check',{simple:true}),'ok');d.close();assert.notEqual(readFileSync(file).subarray(0,16).toString(),'SQLite format 3\0');d=open();assert.equal(snapshot(),before);
 }finally{d.close();}
});
