// Run only in an isolated test container: VIDAMIA_SYNTHETIC_PERF=1 node tools/measure-task-performance.mjs
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';
assert.equal(process.env.VIDAMIA_SYNTHETIC_PERF,'1');
assert.ok(!process.env.DB_ENCRYPTION_KEY);
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='synthetic-performance-only';process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {default:router}=await import('../server/routes/tasks.js');
const d=new Database(':memory:');d.pragma('foreign_keys=ON');
for(const m of ALL_MIGRATIONS){if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);})();if(m.foreignKeysOff)d.pragma('foreign_keys=ON');}
_setTestDatabase(d);
for(const [id,role] of [[1,'admin'],[2,'member']])d.prepare("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(?,?,?,'x',?)").run(id,'synthetic-'+id,'Synthetic '+id,role);
d.exec("INSERT INTO reward_participants(user_id,enabled) VALUES(2,1);INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','UTC')");
const app=express();app.use(express.json());app.use((req,_res,next)=>{req.authUserId=1;req.authRole='admin';req.authMethod='session';req.session={userId:1,role:'admin'};req.sessionID='synthetic-performance';next();});app.get('/health',(_req,res)=>res.json({ok:true}));app.use('/tasks',router);
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
const prepare=d.prepare.bind(d),instrument=process.env.PERF_SQL_STATS!=='0';let stats=null;
d.prepare=function(sql){if(!instrument)return prepare(sql);const started=performance.now(),stmt=prepare(sql);if(stats){stats.prepare_count++;stats.prepare_ms+=performance.now()-started;}
 for(const method of ['get','all','run']){const original=stmt[method].bind(stmt);stmt[method]=(...args)=>{const start=performance.now();try{return original(...args);}finally{if(stats){stats.execute_count++;stats.execute_ms+=performance.now()-start;const key=sql.replace(/\s+/g,' ').trim();const row=stats.sql[key]??={calls:0,ms:0};row.calls++;row.ms+=performance.now()-start;}}};}return stmt;};
const roots=[],results=[];
const request=(path,method='GET',body)=>new Promise((resolve,reject)=>{const start=performance.now();const req=http.request({host:'127.0.0.1',port:server.address().port,path,method,headers:{'Content-Type':'application/json'}},res=>{const first=performance.now(),parts=[];res.on('data',c=>parts.push(c));res.on('end',()=>{const raw=Buffer.concat(parts),parsedAt=performance.now(),data=JSON.parse(raw);resolve({status:res.statusCode,first_byte_ms:first-start,total_ms:performance.now()-start,parse_ms:performance.now()-parsedAt,bytes:raw.length,data});});});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);});
async function measure(label,path,method='GET',body){
 stats={prepare_count:0,prepare_ms:0,execute_count:0,execute_ms:0,sql:{}};let delay=0,last=performance.now();const timer=setInterval(()=>{const now=performance.now();delay=Math.max(delay,now-last-5);last=now;},5);
 const response=await request(path,method,body);await new Promise(r=>setTimeout(r,5));clearInterval(timer);
 const record={label,status:response.status,first_byte_ms:response.first_byte_ms,total_ms:response.total_ms,parse_ms:response.parse_ms,bytes:response.bytes,event_loop_timer_ms:delay,...stats,memory:process.memoryUsage()};stats=null;
 record.sql=Object.entries(record.sql).sort((a,b)=>b[1].ms-a[1].ms).slice(0,12).map(([sql,values])=>({sql,...values}));results.push(record);assert.equal(response.status,200,label);return response.data;
}
try{
 for(const count of [20,100]){
  const mode=d.prepare('PRAGMA table_info(tasks)').all().some(row=>row.name==='scoring_mode');
  d.transaction(()=>{while(roots.length<count){const root=Number(d.prepare(mode?"INSERT INTO tasks(title,created_by,assigned_to,scoring_mode,points) VALUES('Synthetic scope',1,2,'subtasks',0)":"INSERT INTO tasks(title,created_by,assigned_to,points) VALUES('Synthetic scope',1,2,0)").run().lastInsertRowid);roots.push(root);d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,2)').run(root);for(let i=0;i<4;i++){const child=Number(d.prepare("INSERT INTO tasks(title,created_by,parent_task_id,points) VALUES('Synthetic step',1,?,2)").run(root).lastInsertRowid);d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,2)').run(child);}}})();
  await measure(`${count}-roots-list-first`,'/tasks');await measure(`${count}-roots-list-hot`,'/tasks');await measure(`${count}-roots-detail`,`/tasks/${roots[0]}`);
 }
 const row=d.prepare('SELECT * FROM tasks WHERE id=?').get(roots[0]);
 await measure('status-ack',`/tasks/${row.id}/status`,'PATCH',{status:'in_progress',expected_revision:row.revision});
 const fresh=d.prepare('SELECT * FROM tasks WHERE id=?').get(row.id);
 await measure('edit-title-ack',`/tasks/${row.id}`,'PUT',{title:'Synthetic edited',expected_revision:fresh.revision});
 const ledger=d.prepare('SELECT COUNT(*) n FROM reward_ledger').get().n;assert.equal(ledger,0);
 console.log(JSON.stringify({synthetic:true,at:new Date().toISOString(),roots:roots.length,tasks:d.prepare('SELECT COUNT(*) n FROM tasks').get().n,reward_ledger_rows:ledger,results}));
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));_setTestDatabase(null);d.close();}
