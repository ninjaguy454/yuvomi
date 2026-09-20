import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='isolated-rotation-task-test';process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {default:tasksRouter}=await import('../server/routes/tasks.js');
const {default:automationRouter}=await import('../server/routes/automation.js');
const {default:rotationsRouter}=await import('../server/routes/rotations.js');
const {getRotationOccurrence,saveRotationGroup}=await import('../server/services/rotation.js');
const {taskSeriesState}=await import('../server/services/task-series.js');
const S=await import('../server/services/rotation-shared.js');
let d,admin,grace,eleanor,frankie,group,server,base;
test.beforeEach(async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-09-19T23:00:00Z')});
  d=new Database(':memory:');d.pragma('foreign_keys=ON');
  for(const migration of ALL_MIGRATIONS){if(migration.foreignKeysOff)d.pragma('foreign_keys=OFF');
    d.transaction(()=>{typeof migration.up==='function'?migration.up(d):d.exec(migration.up);migration.afterUp?.(d);})();
    if(migration.foreignKeysOff)d.pragma('foreign_keys=ON');}
  _setTestDatabase(d);
  const user=(name,role)=>Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES(?,?,'x',?,?)").run(name,name,role,role==='admin'?'parent':'child').lastInsertRowid);
  admin=user('Parent','admin');grace=user('Grace','member');eleanor=user('Eleanor','member');frankie=user('Frankie','member');
  for(const userId of [grace,eleanor,frankie])d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(?,1)').run(userId);
  d.prepare("INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','America/New_York')").run();
  group=S.saveRotationGroupUsage(d,{name:'Kids Shower Order',member_ids:[grace,eleanor,frankie],usage_mode:'shared',shared_config:{strategy:'rotating_order',starting_member_id:grace,effective_date:'2026-09-19',weekdays:[0,1,2,3,4,5,6],active_time:'18:00',finalize_time:'02:00',finalize_day_offset:1,advance_on_skip:false}},{actorId:admin});
  const app=express();app.use(express.json());app.use((req,_res,next)=>{const id=Number(req.headers['x-test-user'])||admin;
    const role=d.prepare('SELECT role FROM users WHERE id=?').get(id).role;req.authUserId=id;req.authRole=role;req.session={userId:id,role};next();});
  app.use('/tasks',tasksRouter);app.use('/automation',automationRouter);app.use('/automation',rotationsRouter);
  // Windows can allocate an ephemeral port in Fetch's reserved-port list.
  const blocked=new Set([1719,1720,1723,2049,3659,4045,5060,5061,6000,6566,6665,6666,6667,6668,6669,6697,10080]);
  do {
    server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    if(server.address().port>=1024&&!blocked.has(server.address().port))break;
    await new Promise(resolve=>server.close(resolve));
  }while(true);
  base=`http://127.0.0.1:${server.address().port}`;
});
test.afterEach(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));_setTestDatabase(null);d.close();});
const row=id=>d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
const children=id=>d.prepare('SELECT * FROM tasks WHERE parent_task_id=? AND archived_at IS NULL ORDER BY sort_order,id').all(id);
const next=id=>d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(id);
const binding=(extra={})=>({purpose_key:'shower_order',label:'Shower Order',group_id:group.id,strategy:'rotating_order',advance_policy:'on_finalized',...extra});
const ownerLink=id=>d.prepare('SELECT * FROM task_rotation_occurrences WHERE task_id=? AND retired_at IS NULL').get(id);
async function call(method,path,body,actor=admin){
  if(body&&/^\/tasks\/\d+/.test(path)&&['PUT','PATCH'].includes(method)){
    const current=row(Number(path.split('/')[2]));body={expected_revision:current.revision,
      ...(current.parent_task_id?{expected_parent_revision:row(current.parent_task_id).revision}:{}),...body};}
  const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json','x-test-user':String(actor)},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const text=await response.text();return{status:response.status,...text?JSON.parse(text):{}};
}
async function finish(id){const result=await call('PATCH',`/tasks/${id}/status`,{status:'done',complete_remaining:true});assert.equal(result.status,200,JSON.stringify(result));return result;}
const sharedTrack=()=>d.prepare("SELECT * FROM rotation_tracks WHERE consumer_type='rotation_group_schedule' AND group_id=?").get(group.id);
const templateRows=id=>d.prepare('SELECT * FROM activity_template_checklist_items WHERE activity_template_id=? ORDER BY sort_order,id').all(id);
const rendering=id=>JSON.parse(d.prepare('SELECT definition_snapshot_json FROM task_activity_bindings WHERE task_id=?').get(id).definition_snapshot_json).rotation_rendering;
async function bedtime(extra={}) {
  const created=await call('POST','/automation/admin/activity-templates',{name:'Get Ready for Bed',title_template:'Get Ready for Bed',assignment_strategy:'subject_skill',subject_required:true,presence_policy:'ignore',start_time:'18:30',due_time:'23:30',due_date_offset_days:0,recurrence_rule:'FREQ=DAILY',points:2,checklist:[{title_template:'Put on pajamas'},{title_template:'Take shower'},{title_template:'Brush teeth',is_optional:1}],...extra});
  assert.equal(created.status,201,JSON.stringify(created));return created.data;
}
function draft(template,extra={}) {
  return {title:'Eleanor Get Ready for Bed',activity_template_id:template.id,activity_subject_user_id:eleanor,start_date:'2026-09-19',start_time:'18:30',due_date:'2026-09-19',due_time:'23:30',is_recurring:true,recurrence_rule:'FREQ=DAILY',rotation_bindings:[binding()],subtasks:templateRows(template.id).map((item,index)=>({title:index===1?'Take shower · {{shower_order.position_label}}':item.title_template,activity_template_checklist_item_id:item.id,skill_ids:[],is_optional:item.is_optional})),...extra};
}
function persistedState() {
  return Object.fromEntries(['tasks','task_assignments','task_activity_bindings','task_recurrence_occurrences','task_recurrence_actions','task_recurrence_series','task_recurrence_definitions','rotation_tracks','rotation_occurrences','rotation_events','rotation_group_periods','task_rotation_periods','task_rotation_occurrences','task_activity_events','reward_ledger','task_supervision_actions','task_change_clock'].map(table=>[table,d.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}
function addAssignee() {d.prepare("INSERT INTO household_variable_definitions(variable_key,label,type,kind,default_value_json,expression_json) VALUES('assignee','Assignee','household_member','value',NULL,NULL)").run();}

test('template-derived shower expression binds only its persisted action and survives recurrence without changing its source',async t=>{
  const template=await bedtime(),originalTemplate=d.prepare('SELECT * FROM activity_templates WHERE id=?').get(template.id),originalItems=templateRows(template.id);
  const body=draft(template);body.subtasks=[body.subtasks[2],body.subtasks[0],body.subtasks[1]];
  const result=await call('POST','/tasks',body);assert.equal(result.status,201,JSON.stringify(result));
  const id=result.data.id,actions=children(id),shower=actions.find(action=>action.activity_template_checklist_item_id===originalItems[1].id);
  assert.deepEqual(actions.map(item=>item.title),['Brush teeth','Put on pajamas','Take shower · 2nd']);assert.equal(actions[0].is_optional,1);
  const plan=rendering(id);assert.equal(plan.targets.length,1);
  const actionKey=d.prepare('SELECT action_key FROM task_recurrence_actions WHERE task_id=?').get(shower.id).action_key;
  assert.equal(plan.targets[0].action_key,actionKey);assert.equal(plan.targets[0].template,'Take shower · {{shower_order.position_label}}');
  assert.deepEqual(plan.targets[0].purpose_keys,['shower_order']);assert.equal(plan.targets[0].field,'title');
  assert.deepEqual(taskSeriesState(d,id).definition.data.rotation_rendering,plan);
  assert.deepEqual(d.prepare('SELECT * FROM activity_templates WHERE id=?').get(template.id),originalTemplate);
  assert.deepEqual(templateRows(template.id),originalItems);
  await finish(id);const successor=next(id);assert.ok(successor);
  const nextShower=children(successor.id).find(child=>child.activity_template_checklist_item_id===originalItems[1].id);
  assert.equal(nextShower.recurrence_origin_id,shower.id);assert.equal(nextShower.title,'Take shower · 1st');assert.equal(nextShower.status,'open');
  assert.deepEqual(children(successor.id).filter(child=>child.id!==nextShower.id).map(child=>child.title),['Brush teeth','Put on pajamas']);
  assert.equal(sharedTrack().advance_count,0);assert.equal(d.prepare('SELECT COUNT(*) n FROM rotation_occurrences').get().n,1);
  assert.deepEqual(d.prepare("SELECT delta FROM reward_ledger WHERE task_id=? AND type='earn'").all(id),[{delta:2}]);
  t.mock.timers.setTime(Date.parse('2026-09-20T23:00:00Z'));S.reconcileSharedRotationPeriods(d,{groupId:group.id,now:new Date()});
  assert.equal(row(nextShower.id).title,'Take shower · 1st');assert.equal(row(shower.id).title,'Take shower · 2nd');
  assert.deepEqual(d.pragma('foreign_key_check'),[]);
});

test('new Rotation purpose preserves contextual Assignee template title rather than failing creation',async()=>{
  addAssignee();const template=await bedtime({title_template:'{{assignee.display_name}} Get Ready for Bed'});
  const result=await call('POST','/tasks',draft(template,{title:undefined,activity_inputs:{assignee:admin}}));
  assert.equal(result.status,201,JSON.stringify(result));assert.equal(result.data.title,'Eleanor Get Ready for Bed');
  assert.equal(children(result.data.id).find(action=>action.title.startsWith('Take shower')).title,'Take shower · 2nd');
});

test('mixed draft title and description use the resolved performer and refresh alongside the one selected child',async()=>{
  addAssignee();const template=await bedtime();
  const result=await call('POST','/tasks',draft(template,{title:'{{assignee.display_name}} · {{shower_order.position_label}}',description:'{{assignee.display_name}} is {{shower_order.position}}'}));
  assert.equal(result.status,201,JSON.stringify(result));const id=result.data.id;
  assert.equal(row(id).title,'Eleanor · 2nd');assert.equal(row(id).description,'Eleanor is 2');
  const occurrence=getRotationOccurrence(d,ownerLink(id).occurrence_id);
  const changed=await call('POST',`/automation/rotation-occurrences/${occurrence.id}/override`,{expected_revision:occurrence.revision,member_ids:[frankie,grace,eleanor]});
  assert.equal(changed.status,200,JSON.stringify(changed));assert.equal(row(id).title,'Eleanor · 3rd');assert.equal(row(id).description,'Eleanor is 3');
  assert.deepEqual(children(id).map(child=>child.title),['Put on pajamas','Take shower · 3rd','Brush teeth']);
  assert.equal(sharedTrack().advance_count,0);
  const shower=children(id)[1];const edited=await call('PUT',`/tasks/${shower.id}`,{title:'Take a shower before bed'});assert.equal(edited.status,200,JSON.stringify(edited));
  const latest=getRotationOccurrence(d,occurrence.id);
  assert.equal((await call('POST',`/automation/rotation-occurrences/${occurrence.id}/override`,{expected_revision:latest.revision,member_ids:[eleanor,frankie,grace]})).status,200);
  assert.equal(row(shower.id).title,'Take a shower before bed');assert.equal(row(id).title,'Eleanor · 1st');
});

test('explicit action assignee supplies its own rotation position instead of the viewer or parent',async()=>{
  const template=await bedtime(),body=draft(template);body.subtasks[1].assigned_user_ids=[frankie];
  const result=await call('POST','/tasks',body);assert.equal(result.status,201,JSON.stringify(result));
  assert.equal(children(result.data.id)[1].title,'Take shower · 3rd');
  assert.equal(row(result.data.id).assigned_to,eleanor);assert.equal(children(result.data.id)[1].assigned_to,frankie);
});

test('Round Robin remains a one-person selection and supports template creation without consuming another turn',async()=>{
  group=S.saveRotationGroupUsage(d,{name:'Shared chooser',member_ids:[grace,eleanor,frankie],usage_mode:'shared',shared_config:{strategy:'round_robin',starting_member_id:eleanor,effective_date:'2026-09-19',weekdays:[0,1,2,3,4,5,6],active_time:'18:00',finalize_time:'02:00',finalize_day_offset:1}},{actorId:admin});
  const template=await bedtime();const result=await call('POST','/tasks',draft(template,{rotation_bindings:[binding({strategy:'round_robin'})]}));
  assert.equal(result.status,201,JSON.stringify(result));assert.equal(children(result.data.id)[1].title,'Take shower · 1st');
  const occurrence=getRotationOccurrence(d,ownerLink(result.data.id).occurrence_id);
  assert.equal(occurrence.strategy,'round_robin');assert.deepEqual(occurrence.member_ids,[eleanor]);assert.equal(sharedTrack().advance_count,0);
});

test('invalid draft expression returns a field-specific validation error and rolls back all creation state',async()=>{
  const template=await bedtime(),body=draft(template);body.subtasks[1].title='Take shower · {{shower_order.unknown_property}}';
  const before=persistedState(),result=await call('POST','/tasks',body);
  assert.equal(result.status,400,JSON.stringify(result));assert.match(result.error,/Check the rotation text/);assert.match(result.error,/unknown_property/);
  assert.deepEqual(persistedState(),before);assert.deepEqual(d.pragma('foreign_key_check'),[]);
});

test('failure after action and Rotation materialization leaves no parent, sibling, period or provenance committed',async()=>{
  const template=await bedtime(),before=persistedState();
  d.exec(`CREATE TEMP TRIGGER reject_rotation_draft AFTER UPDATE OF definition_snapshot_json ON task_activity_bindings
    WHEN json_extract(NEW.definition_snapshot_json,'$.rotation_rendering') IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'Induced draft rendering persistence failure'); END`);
  const result=await call('POST','/tasks',draft(template));assert.equal(result.status,500,JSON.stringify(result));
  assert.deepEqual(persistedState(),before);assert.deepEqual(d.pragma('foreign_key_check'),[]);
  d.exec('DROP TRIGGER reject_rotation_draft');
  assert.equal((await call('POST','/tasks',draft(template))).status,201,'the intact draft can be retried after the fault is removed');
});

test('draft expressions cannot read an inaccessible consumer occurrence through a reusable variable',async()=>{
  const independent=saveRotationGroup(d,{name:'Private selection',member_ids:[admin,eleanor]},{actorId:admin});
  const privateTask=await call('POST','/tasks',{title:'Private consumer marker',assigned_to:[admin],visibility:'private',
    rotation_bindings:[binding({group_id:independent.id})]});
  assert.equal(privateTask.status,201,JSON.stringify(privateTask));
  d.prepare("INSERT INTO household_variable_definitions(variable_key,label,type,kind,default_value_json) VALUES('private_order','Private order','rotation_occurrence','value',?)")
    .run(JSON.stringify(ownerLink(privateTask.data.id).occurrence_id));
  for(const key of ['tasks.create','tasks.change_assignment','rotations.view','rotations.configure','rotations.history'])
    d.prepare("INSERT INTO access_capabilities(subject_type,subject_id,capability_key,access) VALUES('user',?,?,'allow')").run(String(grace),key);
  d.prepare("INSERT INTO access_capabilities(subject_type,subject_id,capability_key,access) VALUES('user',?,'tasks.view_household','none')").run(String(grace));
  const template=await bedtime(),body=draft(template,{activity_subject_user_id:grace,title:'My bedtime'});
  body.subtasks[1].title='Take shower · {{private_order.order}}';
  const before=persistedState(),result=await call('POST','/tasks',body,grace);
  assert.ok([403,404].includes(result.status),JSON.stringify(result));assert.doesNotMatch(JSON.stringify(result),/Private consumer marker/);
  assert.match(result.error,/Rotation not found/i,'the denial must come from canonical private Rotation projection');
  assert.deepEqual(persistedState(),before);
});
