import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='isolated-owner-extras-migration';
const {ALL_MIGRATIONS}=await import('../server/db.js');
test('10080 adds nullable source fields without choosing a historical Owner or rewriting assignments',()=>{
 const d=new Database(':memory:');d.pragma('foreign_keys=ON');
 try{
  for(const m of ALL_MIGRATIONS.filter(m=>m.version<10080)){if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);})();if(m.foreignKeysOff)d.pragma('foreign_keys=ON');}
  d.exec("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(1,'one','One','x','admin'),(2,'two','Two','x','member'); INSERT INTO tasks(id,title,assigned_to,created_by,status,points) VALUES(1,'Legacy ambiguous',NULL,1,'done',7); INSERT INTO task_assignments(task_id,user_id) VALUES(1,1),(1,2); INSERT INTO activity_templates(id,name,title_template,assignment_strategy,assignment_policy,fixed_user_id,fixed_assignee_ids_json) VALUES(1,'Legacy fixed','Legacy fixed','fixed','fixed',1,'[1,2]')");
  const task=d.prepare('SELECT * FROM tasks').all(),templates=d.prepare('SELECT * FROM activity_templates').all(),assignment=d.prepare('SELECT * FROM task_assignments').all();
  d.exec(ALL_MIGRATIONS.find(m=>m.version===10080).up);
  const strip=rows=>rows.map(({additional_assignee_ids_json,...row})=>row);
  assert.deepEqual(strip(d.prepare('SELECT * FROM tasks').all()),task);assert.deepEqual(strip(d.prepare('SELECT * FROM activity_templates').all()),templates);assert.deepEqual(d.prepare('SELECT * FROM task_assignments').all(),assignment);
  assert.equal(d.prepare('SELECT additional_assignee_ids_json FROM tasks').get().additional_assignee_ids_json,null);assert.equal(d.prepare('SELECT additional_assignee_ids_json FROM activity_templates').get().additional_assignee_ids_json,null);assert.equal(d.prepare('SELECT assigned_to FROM tasks').get().assigned_to,null);
 }finally{d.close();}
});
