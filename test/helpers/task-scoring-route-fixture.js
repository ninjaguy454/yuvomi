import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='isolated-scoring-api';process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../../server/db.js');
const {default:router}=await import('../../server/routes/tasks.js');
const {default:wallRouter}=await import('../../server/routes/wall.js');
export async function scoringFixture(t) {
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-01T12:00:00Z')});
  const d=new Database(':memory:');d.pragma('foreign_keys=ON');
  for(const m of ALL_MIGRATIONS){if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);})();if(m.foreignKeysOff)d.pragma('foreign_keys=ON');}
  _setTestDatabase(d);
  for(const [id,role] of [[1,'admin'],[2,'member'],[3,'member']])d.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role) VALUES(?,?,?,'x',?,'other')").run(id,'Synthetic '+id,'Synthetic '+id,role);
  d.exec("INSERT INTO reward_participants(user_id,enabled) VALUES(2,1),(3,1); INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','UTC')");
  const app=express();app.use(express.json());app.use((req,_res,next)=>{const id=Number(req.headers['x-test-user'])||1;req.authUserId=id;req.authRole=id===1?'admin':'member';req.authMethod='session';req.sessionID='scoring-wall-fixture';req.session={userId:id,role:req.authRole};next();});app.use('/tasks',router);app.use('/wall',wallRouter);
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));_setTestDatabase(null);d.close();});
  const row=id=>d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  const revisions=id=>{const r=row(id);return {expected_revision:r.revision,...(r.parent_task_id?{expected_parent_revision:row(r.parent_task_id).revision}:{}),...(d.prepare('SELECT s.revision FROM task_recurrence_series s JOIN task_recurrence_occurrences o ON o.series_id=s.series_id WHERE o.task_id=?').get(id)?{expected_series_revision:d.prepare('SELECT s.revision FROM task_recurrence_series s JOIN task_recurrence_occurrences o ON o.series_id=s.series_id WHERE o.task_id=?').get(id).revision}:{})};};
  async function call(method,path,body,actor=1){const id=Number(path.split('/')[2]);if(body&&row(id)&&['POST','PUT','PATCH'].includes(method))body={...revisions(id),...body};const r=await fetch(`http://127.0.0.1:${server.address().port}`+path,{method,headers:{'Content-Type':'application/json','x-test-user':String(actor)},...(body===undefined?{}:{body:JSON.stringify(body)})});const raw=await r.text();let result;try{result=JSON.parse(raw);}catch{result={error:raw};}return{status:r.status,...result};}
  const create=body=>call('POST','/tasks',{title:'Synthetic routine',points:0,...body});
  const edit=(id,body,actor)=>call('PUT','/tasks/'+id,body,actor);
  const preview=(id,body,actor)=>call('POST',`/tasks/${id}/scoring-preview`,body,actor);
  const finish=id=>call('PATCH',`/tasks/${id}/status`,{status:'done',complete_remaining:true});
  const snapshot=()=>JSON.stringify(Object.fromEntries(['tasks','task_assignments','task_recurrence_definitions','task_recurrence_series','task_recurrence_occurrences','task_recurrence_actions','task_activity_events','reward_ledger','reward_task_awards','task_scoring_settlements'].map(name=>[name,d.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()])));
  const grant=(key,access)=>d.prepare("INSERT OR REPLACE INTO access_capabilities(subject_type,subject_id,capability_key,access) VALUES('user','2',?,?)").run('tasks.'+key,access);
  return {d,row,revisions,call,create,edit,preview,finish,snapshot,grant};
}
