import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET||='optional-inspection-cost';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {taskOptionalContext,createTaskOptionalContextReader}=await import('../server/services/task-optional.js');
const {inspectTaskSupervision,reconcileTaskSupervision}=await import('../server/services/task-supervision.js');
let d,learner,helper,root,skill,required,optional,nested;
const row=id=>d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
const action=(view,id)=>view.actions.find(item=>item.action_task_id===id);
test.beforeEach(()=>{
 d=new Database(':memory:');d.pragma('foreign_keys=ON');
 for(const m of ALL_MIGRATIONS){if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);})();if(m.foreignKeysOff)d.pragma('foreign_keys=ON');}
 _setTestDatabase(d);
 const user=(name,role)=>Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role) VALUES(?,?,'x',?)").run(name,name,role).lastInsertRowid);
 learner=user('Learner','member');helper=user('Helper','admin');
 skill=Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Practice',0,'normal',?)").run(helper).lastInsertRowid);
 d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,'supervised','manual',?)").run(learner,skill,helper);
 const task=(name,parent=null,isOptional=0)=>Number(d.prepare('INSERT INTO tasks(title,created_by,assigned_to,parent_task_id,is_optional) VALUES(?,?,?,?,?)').run(name,helper,parent?null:learner,parent,isOptional).lastInsertRowid);
 root=task('Routine');required=task('Required',root);optional=task('Optional group',root,1);nested=task('Nested action',optional);
 for(const id of [required,optional,nested])d.prepare('INSERT INTO task_skill_requirements(task_id,skill_id) VALUES(?,?)').run(id,skill);
 reconcileTaskSupervision(d,root,{notify:false});
});
test.afterEach(()=>{_setTestDatabase(null);d.close();});

test('inspection-local ancestry matches fresh guards for ordinary and linked helper actions',()=>{
 const view=inspectTaskSupervision(d,root),ids=[root,required,optional,nested,...view.actions.map(item=>item.counterpart_task_id).filter(Boolean),view.support_task_id];
 for(const state of ['open','done']){
  d.prepare('UPDATE tasks SET status=? WHERE id=?').run(state,root);
  const reader=createTaskOptionalContextReader(d,[root,required,optional,nested].map(row));
  for(const id of ids)assert.deepEqual(reader(id),taskOptionalContext(d,id),`${state}: ${id}`);
 }
});

test('seeded sibling ancestry does not reread task rows or helper mappings, and missing ancestors load once',()=>{
 const prepare=d.prepare.bind(d);let queries=0;
 d.prepare=(...args)=>{queries++;return prepare(...args);};
 try{
  const full=createTaskOptionalContextReader(d,[root,required,optional,nested].map(id=>prepare('SELECT * FROM tasks WHERE id=?').get(id)));
  for(let repeat=0;repeat<3;repeat++)for(const id of [root,required,optional,nested])full(id);
  assert.equal(queries,0);
  const partial=createTaskOptionalContextReader(d,[required,optional,nested].map(id=>prepare('SELECT * FROM tasks WHERE id=?').get(id)));
  for(const id of [required,optional,nested])partial(id);
  assert.equal(queries,1,'the enclosing ancestor is shared only inside this inspection');
 }finally{d.prepare=prepare;}
});

test('fresh inspections observe optional edits, parent completion, reopening and savepoint rollback',()=>{
 const before=inspectTaskSupervision(d,root);
 assert.equal(action(before,required).is_optional,false);
 const rollback=new Error('fixture rollback');
 assert.throws(()=>d.transaction(()=>{
  d.prepare('UPDATE tasks SET is_optional=1 WHERE id=?').run(required);
  assert.equal(action(inspectTaskSupervision(d,root),required).is_optional,true);
  assert.throws(()=>d.transaction(()=>{
   d.prepare("UPDATE tasks SET status='done' WHERE id=?").run(root);
   const closed=action(inspectTaskSupervision(d,root),required);
   assert.equal(closed.closed_optional,true);assert.equal(closed.state,'not_required');
   assert.ok(taskOptionalContext(d,required).closed_parent,'mutation guard stays fresh inside the savepoint');
   throw rollback;
  })(),error=>error===rollback);
  assert.equal(action(inspectTaskSupervision(d,root),required).closed_optional,undefined);
  assert.equal(taskOptionalContext(d,required).closed_parent,null);
  throw rollback;
 })(),error=>error===rollback);
 assert.equal(action(inspectTaskSupervision(d,root),required).is_optional,false);
 assert.deepEqual(action(inspectTaskSupervision(d,root),required),action(before,required));
 d.prepare("UPDATE tasks SET status='done' WHERE id=?").run(root);
 assert.equal(action(inspectTaskSupervision(d,root),nested).closed_optional,true);
 d.prepare("UPDATE tasks SET status='in_progress' WHERE id=?").run(root);
 assert.equal(action(inspectTaskSupervision(d,root),nested).state,'assigned');
});

test('supervision inspection reuses ordinary rows without changing mappings, revisions or history',()=>{
 const before=d.prepare('SELECT total_changes() n').get().n;
 const prepare=d.prepare.bind(d);let counterpartLookups=0;
 d.prepare=(sql,...args)=>{if(sql==='SELECT action_task_id FROM task_supervision_actions WHERE counterpart_task_id=?')counterpartLookups++;return prepare(sql,...args);};
 let view;
 try{view=inspectTaskSupervision(d,root);}finally{d.prepare=prepare;}
 assert.equal(counterpartLookups,0);
 assert.equal(view.actions.length,3);assert.equal(action(view,nested).is_optional,true);
 assert.equal(d.prepare('SELECT total_changes() n').get().n,before);
});
