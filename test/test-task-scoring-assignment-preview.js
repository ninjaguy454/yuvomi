import test from 'node:test';
import assert from 'node:assert/strict';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';

for(const scope of ['occurrence','future'])for(const mode of ['whole_task','subtasks'])test(`${scope} ${mode}: managed placeholder assignment previews the recipient actually saved and paid`,async t=>{
  const f=await scoringFixture(t);
  const template=Number(f.d.prepare("INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,fixed_user_id,subject_required,presence_policy,created_by) VALUES('Assigned routine','Assigned routine','fixed','fixed',2,0,'ignore',1)").run().lastInsertRowid);
  const created=await f.create({activity_template_id:template,points:mode==='whole_task'?2:0,scoring_mode:mode,due_date:'2026-11-01',is_recurring:1,recurrence_rule:'FREQ=DAILY',subtasks:[{title:'Routine step',points:2}]});
  assert.equal(created.status,201,JSON.stringify(created));const id=created.data.id;
  const body={title:'Edited assigned routine',edit_scope:scope,activity_template_id:template,assignment_mode:'fixed',assigned_to:[],points:mode==='whole_task'?2:0,scoring_mode:mode};
  const before=f.snapshot(),changes=f.changes(),preview=await f.preview(id,body);
  assert.equal(preview.status,200,JSON.stringify(preview));
  assert.deepEqual(preview.data.before,[{user_id:2,points:2}]);assert.deepEqual(preview.data.after,[{user_id:2,points:2}]);
  assert.equal(f.snapshot(),before);assert.equal(f.changes(),changes,'preview writes nothing');
  assert.equal((await f.edit(id,body)).status,200);
  assert.equal(f.row(id).assigned_to,2);assert.equal(f.row(id).title,'Edited assigned routine');
  assert.equal((await f.finish(id)).status,200);
  const currentEarn=f.d.prepare("SELECT user_id,delta FROM reward_ledger WHERE type='earn' AND (task_id=? OR task_id IN (SELECT id FROM tasks WHERE parent_task_id=?))").all(id,id);
  assert.deepEqual(currentEarn,[{user_id:2,delta:2}]);
  const next=f.d.prepare('SELECT id FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(id);assert.ok(next);
  assert.equal((await f.finish(next.id)).status,200);
  assert.deepEqual(f.d.prepare("SELECT user_id,delta FROM reward_ledger WHERE type='earn' AND (task_id=? OR task_id IN (SELECT id FROM tasks WHERE parent_task_id=?))").all(next.id,next.id),[{user_id:2,delta:2}]);
  await f.finish(id);assert.deepEqual(f.d.prepare("SELECT user_id,delta FROM reward_ledger WHERE type='earn' AND (task_id=? OR task_id IN (SELECT id FROM tasks WHERE parent_task_id=?))").all(id,id),currentEarn,'completion retry cannot double-pay');
});

test('unchanged round robin placeholder uses its effective current recipient; explicit manual clearing remains empty',async t=>{
  const f=await scoringFixture(t),rotated=await f.create({points:2,scoring_mode:'whole_task',assigned_to:[],assignment_mode:'round_robin',rotation_user_ids:[2,3],due_date:'2026-11-01',is_recurring:1,recurrence_rule:'FREQ=DAILY'});
  assert.equal(rotated.status,201);const p=await f.preview(rotated.data.id,{points:2,assigned_to:[],assignment_mode:'round_robin',rotation_user_ids:[2,3]});
  assert.equal(p.status,200);assert.deepEqual(p.data.after,[{user_id:2,points:2}]);
  const manual=await f.create({points:2,scoring_mode:'whole_task',assigned_to:[2]});
  const clear=await f.preview(manual.data.id,{assigned_to:[]});assert.deepEqual(clear.data.before,[{user_id:2,points:2}]);assert.deepEqual(clear.data.after,[]);
  assert.equal((await f.edit(manual.data.id,{assigned_to:[]})).status,200);await f.finish(manual.data.id);
  assert.deepEqual(f.d.prepare('SELECT user_id,delta FROM reward_ledger WHERE task_id=?').all(manual.data.id),[]);
});

test('future-only bound preview retains eligible recipients without changing current work or history',async t=>{
  const f=await scoringFixture(t),template=Number(f.d.prepare("INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,fixed_user_id,subject_required,presence_policy,created_by) VALUES('Future assigned routine','Future assigned routine','fixed','fixed',2,0,'ignore',1)").run().lastInsertRowid);
  const created=await f.create({activity_template_id:template,points:2,scoring_mode:'whole_task',due_date:'2026-11-01',is_recurring:1,recurrence_rule:'FREQ=DAILY'}),id=created.data.id;
  const snapshot=f.snapshot(),changes=f.changes(),p=await f.preview(id,{edit_scope:'future_only',future_patch:{fields:{points:3}}});
  assert.equal(p.status,200,JSON.stringify(p));assert.deepEqual(p.data.after,[{user_id:2,points:3}]);assert.ok(p.data.forecast_context);
  assert.equal(f.snapshot(),snapshot);assert.equal(f.changes(),changes);
  assert.equal((await f.edit(id,{edit_scope:'future_only',future_patch:{fields:{points:3}}})).status,200);assert.equal(f.row(id).points,2);
  await f.finish(id);const next=f.d.prepare('SELECT id FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(id);await f.finish(next.id);
  assert.deepEqual(f.d.prepare("SELECT user_id,delta FROM reward_ledger WHERE task_id=? AND type='earn'").all(next.id),[{user_id:2,delta:3}]);
});

for(const scope of ['occurrence','future'])for(const mode of ['whole_task','subtasks'])for(const change of ['subject','template'])test(`${scope} ${mode}: changing ${change} previews the new saved performer`,async t=>{
  const f=await scoringFixture(t),template=Number(f.d.prepare("INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,fixed_user_id,subject_required,presence_policy,created_by) VALUES('Changed routine','Changed routine',?,?,?,?,'ignore',1)").run(change==='subject'?'subject_skill':'fixed',change==='subject'?'subject_skill':'fixed',change==='subject'?null:2,change==='subject'?1:0).lastInsertRowid);
  const replacement=change==='subject'?template:Number(f.d.prepare("INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,fixed_user_id,subject_required,presence_policy,created_by) VALUES('Replacement routine','Replacement routine','fixed','fixed',3,0,'ignore',1)").run().lastInsertRowid);
  const created=await f.create({activity_template_id:template,...(change==='subject'?{activity_subject_user_id:2}:{}),points:mode==='whole_task'?2:0,scoring_mode:mode,subtasks:[{title:'Inherited work',points:2}],due_date:'2026-11-01',is_recurring:1,recurrence_rule:'FREQ=DAILY'});assert.equal(created.status,201);const id=created.data.id;
  const body={activity_template_id:replacement,...(change==='subject'?{activity_subject_user_id:3}:{}),assigned_to:[],edit_scope:scope,points:mode==='whole_task'?2:0,scoring_mode:mode},snapshot=f.snapshot(),changes=f.changes(),p=await f.preview(id,body);
  assert.equal(p.status,200,JSON.stringify(p));assert.deepEqual(p.data.before,[{user_id:2,points:2}]);assert.deepEqual(p.data.after,[{user_id:3,points:2}]);assert.equal(f.snapshot(),snapshot);assert.equal(f.changes(),changes);
  assert.equal((await f.edit(id,body)).status,200);assert.equal(f.row(id).assigned_to,3);assert.equal((await f.finish(id)).status,200);
  assert.deepEqual(f.d.prepare("SELECT user_id,delta FROM reward_ledger WHERE (task_id=? OR task_id IN (SELECT id FROM tasks WHERE parent_task_id=?)) AND type='earn'").all(id,id),[{user_id:3,delta:2}]);
  if(scope==='future'){const next=f.d.prepare('SELECT id FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(id);assert.ok(next);await f.finish(next.id);assert.deepEqual(f.d.prepare("SELECT user_id,delta FROM reward_ledger WHERE (task_id=? OR task_id IN (SELECT id FROM tasks WHERE parent_task_id=?)) AND type='earn'").all(next.id,next.id),[{user_id:3,delta:2}]);}
});

for(const transition of ['delegated_to_independent','independent_to_delegated'])test(`changed beneficiary ${transition} previews fresh helper ownership`,async t=>{
  const f=await scoringFixture(t);
  f.d.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role) VALUES(4,'Synthetic 4','Synthetic 4','x','member','other')").run();f.d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(4,1)').run();
  const skill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Synthetic action skill',0,'normal',1)").run().lastInsertRowid);
  const profiles=transition==='delegated_to_independent'?[[1,'excluded'],[2,'excluded'],[3,'normal'],[4,'normal']]:[[1,'excluded'],[2,'normal'],[3,'excluded'],[4,'excluded']];
  for(const [user,proficiency] of profiles)f.d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,?,'manual',1)").run(user,skill,proficiency);
  const template=Number(f.d.prepare("INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,subject_required,presence_policy,created_by) VALUES('Subject helper routine','Subject helper routine','subject_skill','subject_skill',1,'ignore',1)").run().lastInsertRowid);
  const created=await f.create({activity_template_id:template,activity_subject_user_id:2,points:0,scoring_mode:'subtasks',subtasks:[{title:'Skilled action',skill_ids:[skill],points:2}]});assert.equal(created.status,201,JSON.stringify(created));
  const id=created.data.id,beneficiary=transition==='delegated_to_independent'?4:3,recipient=transition==='delegated_to_independent'?4:2;
  const body={activity_template_id:template,activity_subject_user_id:beneficiary,assigned_to:[]},snapshot=f.snapshot(),changes=f.changes(),p=await f.preview(id,body);
  assert.equal(p.status,200,JSON.stringify(p));assert.deepEqual(p.data.after,[{user_id:recipient,points:2}]);assert.equal(f.snapshot(),snapshot);assert.equal(f.changes(),changes);
  const saved=await f.edit(id,body);assert.equal(saved.status,200,JSON.stringify(saved));
  const done=await f.call('PATCH',`/tasks/${id}/status`,{status:'done',complete_remaining:true},recipient);assert.equal(done.status,200,JSON.stringify(done));
  assert.deepEqual(f.d.prepare("SELECT user_id,delta FROM reward_ledger WHERE task_id IN (SELECT id FROM tasks WHERE parent_task_id=?) AND type='earn'").all(id),[{user_id:recipient,delta:2}]);
});

test('a changed subject preserves past recipients while forecasting only unfinished action rewards',async t=>{
  const f=await scoringFixture(t),template=Number(f.d.prepare("INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,subject_required,presence_policy,created_by) VALUES('Partly complete routine','Partly complete routine','subject_skill','subject_skill',1,'ignore',1)").run().lastInsertRowid);
  const created=await f.create({activity_template_id:template,activity_subject_user_id:2,points:0,scoring_mode:'subtasks',subtasks:[{title:'Completed before edit',points:2},{title:'Remaining action',points:3}]});assert.equal(created.status,201);
  const id=created.data.id;assert.equal((await f.finish(created.data.subtasks[0].id)).status,200);
  const frozen=f.d.prepare('SELECT * FROM task_scoring_settlements ORDER BY id').all(),body={activity_subject_user_id:3,assigned_to:[]},snapshot=f.snapshot(),changes=f.changes(),p=await f.preview(id,body);
  assert.equal(p.status,200,JSON.stringify(p));assert.deepEqual(p.data.earned,[{user_id:2,points:2}]);assert.deepEqual(p.data.before,[{user_id:2,points:3}]);assert.deepEqual(p.data.after,[{user_id:3,points:3}]);assert.equal(f.snapshot(),snapshot);assert.equal(f.changes(),changes);
  assert.equal((await f.edit(id,body)).status,200);assert.deepEqual(f.d.prepare('SELECT * FROM task_scoring_settlements ORDER BY id').all(),frozen);
  assert.equal((await f.finish(id)).status,200);assert.deepEqual(f.d.prepare("SELECT user_id,delta FROM reward_ledger WHERE task_id IN (SELECT id FROM tasks WHERE parent_task_id=?) AND type='earn' ORDER BY id").all(id),[{user_id:2,delta:2},{user_id:3,delta:3}]);
});

test('a changed random binding declines a concrete recipient forecast without consuming state',async t=>{
  const f=await scoringFixture(t),created=await f.create({assigned_to:[2],points:2,scoring_mode:'whole_task'});
  const template=Number(f.d.prepare("INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,subject_required,presence_policy,created_by) VALUES('Random routine','Random routine','fixed','eligible_random',0,'ignore',1)").run().lastInsertRowid);
  const snapshot=f.snapshot(),changes=f.changes(),p=await f.preview(created.data.id,{activity_template_id:template,assigned_to:[]});
  assert.equal(p.status,409,JSON.stringify(p));assert.equal(p.reason,'scoring_projection_unavailable');assert.deepEqual(p.conditions,['random_assignment_unresolved']);assert.equal(f.snapshot(),snapshot);assert.equal(f.changes(),changes);
});

test('a changed beneficiary and completion must be saved as separate actions in preview and Save',async t=>{
  const f=await scoringFixture(t),template=Number(f.d.prepare("INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,subject_required,presence_policy,created_by) VALUES('Separate progress routine','Separate progress routine','subject_skill','subject_skill',1,'ignore',1)").run().lastInsertRowid);
  const created=await f.create({activity_template_id:template,activity_subject_user_id:2,points:2,scoring_mode:'whole_task'});assert.equal(created.status,201);
  const body={activity_subject_user_id:3,assigned_to:[],status:'done'},snapshot=f.snapshot();
  const p=await f.preview(created.data.id,body);assert.equal(p.status,409,JSON.stringify(p));assert.equal(p.reason,'scoring_progress_separate');
  const saved=await f.edit(created.data.id,body);assert.equal(saved.status,409,JSON.stringify(saved));assert.equal(saved.reason,'scoring_progress_separate');assert.equal(f.snapshot(),snapshot);
});

function scopeSkill(f,name,profiles){
  const id=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES(?,0,'normal',1)").run(name).lastInsertRowid);
  for(const [user,value] of profiles)f.d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,?,'manual',1)").run(user,id,value);
  return id;
}
function fourthMember(f){
  f.d.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role) VALUES(4,'Scope helper 4','Scope helper 4','x','member','other')").run();
  f.d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(4,1)').run();
}
async function pureCurrentPreview(f,id,body){
  const snapshot=f.snapshot(),changes=f.changes(),result=await f.preview(id,body);
  assert.equal(result.status,200,JSON.stringify(result));assert.equal(f.snapshot(),snapshot);assert.equal(f.changes(),changes,'preparing helper facts writes nothing');return result.data;
}
function scopeAwards(f,id){return f.d.prepare("SELECT user_id,SUM(delta) points FROM reward_ledger WHERE type='earn' AND (task_id=? OR task_id IN (SELECT id FROM tasks WHERE parent_task_id=?)) GROUP BY user_id ORDER BY user_id").all(id,id);}
async function completeScope(f,id,actor){const done=await f.call('PATCH',`/tasks/${id}/status`,{status:'done',complete_remaining:true},actor);assert.equal(done.status,200,JSON.stringify(done));}

for(const remove of [false,true])for(const echoAssignment of [false,true])test(`${remove?'removing':'adding'} a child skill recomputes helper rewards with ${echoAssignment?'unchanged':'omitted'} assignment IDs`,async t=>{
  const f=await scoringFixture(t),skill=scopeSkill(f,'Changed child requirement',[[1,'excluded'],[2,'excluded'],[3,'normal']]);
  const template=Number(f.d.prepare("INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,fixed_user_id,subject_required,presence_policy,created_by) VALUES('Skill routine','Skill routine','fixed','fixed',2,0,'ignore',1)").run().lastInsertRowid);
  const created=await f.create({activity_template_id:template,points:0,scoring_mode:'subtasks',subtasks:[{title:'Skilled action',points:2,skill_ids:remove?[skill]:[],...(echoAssignment?{assigned_user_ids:[2]}:{})}]});assert.equal(created.status,201,JSON.stringify(created));
  const id=created.data.id,child=created.data.subtasks[0],body={subtasks:[{id:child.id,title:child.title,points:2,skill_ids:remove?[]:[skill],...(echoAssignment?{assigned_user_ids:[2]}:{})}]};
  const p=await pureCurrentPreview(f,id,body),expected=[{user_id:remove?2:3,points:2}];assert.deepEqual(p.before,[{user_id:remove?3:2,points:2}]);assert.deepEqual(p.after,expected);
  assert.equal((await f.edit(id,body)).status,200);await completeScope(f,id,remove?2:3);assert.deepEqual(scopeAwards(f,id),expected);
});

for(const remove of [false,true])for(const bound of [false,true])test(`${remove?'removing':'adding'} a ${bound?'bound recurring':'manual'} root skill recomputes the shared helper scope`,async t=>{
  const f=await scoringFixture(t),childSkill=scopeSkill(f,'Delegated work',[[1,'excluded'],[2,'excluded'],[3,'normal']]);
  const rootSkill=scopeSkill(f,'Root supervision restriction',[[1,'excluded'],[2,'supervised'],[3,'excluded']]);
  let template;if(bound){template=Number(f.d.prepare("INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,fixed_user_id,subject_required,presence_policy,created_by) VALUES('Root skill routine','Root skill routine','fixed','fixed',2,0,'ignore',1)").run().lastInsertRowid);if(remove)f.d.prepare('INSERT INTO activity_template_skills(activity_template_id,skill_id) VALUES(?,?)').run(template,rootSkill);}
  const created=await f.create({...(bound?{activity_template_id:template,is_recurring:1,recurrence_rule:'FREQ=DAILY',due_date:'2026-11-01'}:{assigned_to:[2],skill_ids:remove?[rootSkill]:[]}),points:0,scoring_mode:'subtasks',subtasks:[{title:'Delegated action',points:2,skill_ids:[childSkill]}]});assert.equal(created.status,201,JSON.stringify(created));
  const id=created.data.id,body={skill_ids:remove?[]:[rootSkill]},p=await pureCurrentPreview(f,id,body),expected=remove?[{user_id:3,points:2}]:[];
  assert.deepEqual(p.after,expected);assert.equal((await f.edit(id,body)).status,200);
  if(remove){await completeScope(f,id,3);assert.deepEqual(scopeAwards(f,id),expected);}
  else {assert.ok(p.warnings.some(warning=>warning.reason==='prospective_supervision_unresolved'));assert.equal((await f.call('PATCH',`/tasks/${id}/status`,{status:'done',complete_remaining:true},3)).status,409);assert.deepEqual(scopeAwards(f,id),[]);}
});

for(const remove of [false,true])test(`a bound one-off rejects ${remove?'removing':'adding'} root requirements owned by its template in preview and Save`,async t=>{
  const f=await scoringFixture(t),skill=scopeSkill(f,'Template-owned requirement',[[1,'normal'],[2,'normal'],[3,'normal']]);
  const template=Number(f.d.prepare("INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,fixed_user_id,subject_required,presence_policy,created_by) VALUES('One-off skill routine','One-off skill routine','fixed','fixed',2,0,'ignore',1)").run().lastInsertRowid);
  if(remove)f.d.prepare('INSERT INTO activity_template_skills(activity_template_id,skill_id) VALUES(?,?)').run(template,skill);
  const created=await f.create({activity_template_id:template,points:2,scoring_mode:'whole_task'});assert.equal(created.status,201,JSON.stringify(created));
  const body={skill_ids:remove?[]:[skill]},snapshot=f.snapshot(),changes=f.changes(),p=await f.preview(created.data.id,body);
  assert.equal(p.status,400,JSON.stringify(p));assert.equal((await f.edit(created.data.id,body)).status,400);assert.equal(f.snapshot(),snapshot);assert.equal(f.changes(),changes);
});

test('adding inherited skilled work recalculates the helper for existing and new actions',async t=>{
  const f=await scoringFixture(t);fourthMember(f);
  const shared=scopeSkill(f,'Shared delegated qualification',[[1,'excluded'],[2,'excluded'],[3,'normal'],[4,'normal']]);
  const narrow=scopeSkill(f,'Additional delegated qualification',[[1,'excluded'],[2,'excluded'],[3,'excluded'],[4,'normal']]);
  const created=await f.create({assigned_to:[2],points:0,scoring_mode:'subtasks',subtasks:[{title:'Existing action',points:2,skill_ids:[shared]}]});assert.equal(created.status,201);
  const id=created.data.id,child=created.data.subtasks[0],body={subtasks:[{id:child.id,title:child.title,points:2,skill_ids:[shared]},{client_key:'new_requirement',title:'New inherited action',points:3,skill_ids:[narrow]}]};
  const p=await pureCurrentPreview(f,id,body);assert.deepEqual(p.before,[{user_id:3,points:2}]);assert.deepEqual(p.after,[{user_id:4,points:5}]);
  assert.equal((await f.edit(id,body)).status,200);await completeScope(f,id,4);assert.deepEqual(scopeAwards(f,id),[{user_id:4,points:5}]);
});

for(const change of ['remove','make_optional','make_required'])test(`${change} work recomputes the remaining helper intersection`,async t=>{
  const f=await scoringFixture(t);fourthMember(f);
  const first=scopeSkill(f,'First helper scope',[[1,'excluded'],[2,'excluded'],[3,'normal'],[4,'excluded']]);
  const second=scopeSkill(f,'Second helper scope',[[1,'excluded'],[2,'excluded'],[3,'excluded'],[4,'normal']]);
  const created=await f.create({assigned_to:[2],points:0,scoring_mode:'subtasks',subtasks:[{title:'First action',points:2,skill_ids:[first]},{title:'Conflicting action',points:3,skill_ids:[second],is_optional:change==='make_required'?1:0}]});assert.equal(created.status,201,JSON.stringify(created));
  const id=created.data.id,actions=created.data.subtasks.filter(child=>!child.is_supervision_projection);assert.equal(actions.length,2);
  const body={subtasks:actions.filter((_,index)=>change!=='remove'||!index).map((child,index)=>({id:child.id,title:child.title,points:child.points,skill_ids:[index?second:first],is_optional:index&&change==='make_optional'?1:0}))};
  const p=await pureCurrentPreview(f,id,body),expected=change==='make_required'?[]:[{user_id:3,points:2}];assert.deepEqual(p.after,expected);assert.equal((await f.edit(id,body)).status,200);
  if(change==='make_required'){assert.equal((await f.call('PATCH',`/tasks/${id}/status`,{status:'done',complete_remaining:true},3)).status,409);assert.deepEqual(scopeAwards(f,id),[]);}
  else {await completeScope(f,id,3);assert.deepEqual(scopeAwards(f,id),expected);}
});

for(const field of ['start_time','due_time','start_date','due_date'])test(`changed ${field} recomputes inherited action helper Availability`,async t=>{
  const f=await scoringFixture(t);fourthMember(f);
  const skill=scopeSkill(f,'Windowed delegated action',[[1,'excluded'],[2,'excluded'],[3,'normal'],[4,'normal']]),dateChange=field.endsWith('_date');
  for(const user of [3,4]){
    const shift=Number(f.d.prepare("INSERT INTO schedule_shift_types(name,start_time,end_time,availability_state) VALUES(?,?,?,'busy')").run('Scope busy '+user,dateChange?'00:00':user===3?'12:00':'08:00',dateChange?'23:59':user===3?'16:00':'12:00').lastInsertRowid);
    const pattern=Number(f.d.prepare("INSERT INTO schedule_patterns(user_id,name,anchor_date,cycle_length) VALUES(?,'Scope schedule','2026-11-01',?)").run(user,dateChange?2:1).lastInsertRowid);
    f.d.prepare('INSERT INTO schedule_pattern_days(pattern_id,position,shift_type_id) VALUES(?,?,?)').run(pattern,dateChange?(user===3?1:0):0,shift);
    if(dateChange){const free=Number(f.d.prepare("INSERT INTO schedule_shift_types(name,start_time,end_time,availability_state) VALUES(?,'00:00','23:59','available')").run('Scope free '+user).lastInsertRowid);f.d.prepare('INSERT INTO schedule_pattern_days(pattern_id,position,shift_type_id) VALUES(?,?,?)').run(pattern,user===3?0:1,free);}
  }
  const windowMode=field.startsWith('start')?'start':'due',template=Number(f.d.prepare("INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,fixed_user_id,subject_required,presence_policy,presence_window,created_by) VALUES('Window routine','Window routine','fixed','fixed',2,0,'available_before_due',?,1)").run(windowMode).lastInsertRowid);
  const created=await f.create({activity_template_id:template,points:0,scoring_mode:'subtasks',start_date:'2026-11-01',start_time:field==='due_time'?'09:00':'10:00',due_date:field==='start_date'?'2026-11-03':'2026-11-01',due_time:field==='due_time'?'10:00':'18:00',subtasks:[{title:'Window action',points:2,skill_ids:[skill]}]});assert.equal(created.status,201,JSON.stringify(created));
  const id=created.data.id,body={[field]:dateChange?'2026-11-02':'14:00'},p=await pureCurrentPreview(f,id,body);assert.deepEqual(p.before,[{user_id:3,points:2}]);assert.deepEqual(p.after,[{user_id:4,points:2}]);
  assert.equal((await f.edit(id,body)).status,200);if(field==='start_date')t.mock.timers.tick(86400000);if(field==='start_time')t.mock.timers.tick(10800000);
  await completeScope(f,id,4);assert.deepEqual(scopeAwards(f,id),[{user_id:4,points:2}]);
});

test('unrelated labels and unchanged execution echoes keep a nested scope on its established preview path',async t=>{
  const f=await scoringFixture(t),created=await f.create({assigned_to:[2],points:2,scoring_mode:'whole_task',subtasks:[{title:'Legacy child',points:0}]});assert.equal(created.status,201);
  const id=created.data.id,child=created.data.subtasks[0];
  f.d.prepare("INSERT INTO tasks(title,created_by,parent_task_id,points) VALUES('Existing nested work',1,?,0)").run(child.id);
  const p=await pureCurrentPreview(f,id,{title:'Renamed root',assigned_to:[2],points:2,skill_ids:[],start_date:null,start_time:null,due_date:null,due_time:null,subtasks:[{id:child.id,title:'Renamed child',points:0,skill_ids:[],is_optional:0,assigned_user_ids:[]}]});
  assert.deepEqual(p.before,[{user_id:2,points:2}]);assert.deepEqual(p.after,[{user_id:2,points:2}]);
});

test('making an executable Activity optional also preserves optionality inherited by its actions',async t=>{
  const f=await scoringFixture(t),rootSkill=scopeSkill(f,'Optional Activity supervision',[[1,'excluded'],[2,'supervised'],[3,'excluded']]);
  const childSkill=scopeSkill(f,'Optional Activity delegated work',[[1,'excluded'],[2,'excluded'],[3,'normal']]);
  const template=Number(f.d.prepare("INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,fixed_user_id,subject_required,presence_policy,created_by) VALUES('Optional owner','Optional owner','fixed','fixed',2,0,'ignore',1)").run().lastInsertRowid);
  f.d.prepare('INSERT INTO activity_template_skills(activity_template_id,skill_id) VALUES(?,?)').run(template,rootSkill);
  const container=await f.create({title:'Workflow container',points:0}),created=await f.create({activity_template_id:template,points:0,scoring_mode:'subtasks',subtasks:[{title:'Optional descendant',points:2,skill_ids:[childSkill]}]});assert.equal(created.status,201,JSON.stringify(created));
  const id=created.data.id,workflow=Number(f.d.prepare('INSERT INTO workflow_instances(parent_task_id,created_by) VALUES(?,1)').run(container.data.id).lastInsertRowid);
  f.d.prepare("INSERT INTO workflow_instance_tasks(workflow_instance_id,task_id,role) VALUES(?,?,'primary')").run(workflow,id);f.d.prepare('UPDATE tasks SET parent_task_id=? WHERE id=?').run(container.data.id,id);
  const p=await pureCurrentPreview(f,id,{is_optional:1});assert.deepEqual(p.before,[]);assert.deepEqual(p.after,[]);
  assert.equal((await f.edit(id,{is_optional:1})).status,200);assert.equal((await f.call('PATCH',`/tasks/${id}/status`,{status:'done',complete_remaining:true},3)).status,409);assert.deepEqual(scopeAwards(f,id),[]);
});
