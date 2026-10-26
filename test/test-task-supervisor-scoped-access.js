import test from 'node:test';
import assert from 'node:assert/strict';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';
import {replaceSubjectPermissions} from '../server/permissions.js';
import {saveRotationGroup} from '../server/services/rotation.js';
import {resolveSubtaskOccurrence} from '../server/services/subtask-occurrence-resolution.js';
import {inspectTaskSupervision,reconcileTaskSupervision} from '../server/services/task-supervision.js';
import {taskCapabilities,taskVisibilityWhere,withTaskReadProjection} from '../server/services/task-access.js';
import {callTool} from '../server/mcp/tools.js';
import {wallTaskVisible} from '../server/services/wall.js';
import {listNotificationInbox} from '../server/services/notification-inbox.js';
import express from 'express';
import readerRouter from '../server/routes/reader.js';
import Database from 'better-sqlite3-multiple-ciphers';
import {mkdtempSync,unlinkSync,rmdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

async function privateSplit(t){
  const f=await scoringFixture(t);
  for(const [id,name] of [[4,'Dad'],[5,'Mom'],[6,'Candidate']]){
    f.d.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role) VALUES(?,?,?,'x','member','parent')").run(id,name,name);
    replaceSubjectPermissions(f.d,'user',id,{capabilities:{'tasks.view_household':'none','tasks.view_own':'allow','tasks.complete_own':'allow','tasks.complete_others':'none'}});
  }
  const group=saveRotationGroup(f.d,{name:'Private learners',member_ids:[2,3]},{actorId:1});
  const created=await f.create({title:'SECRET ROOT',description:'SECRET DESCRIPTION',visibility:'private',due_date:'2026-11-01',
    subtasks:[{title:'Dad private action',assigned_user_ids:[]},{title:'Mom secret action',assigned_user_ids:[]}]});
  assert.equal(created.status,201,JSON.stringify(created));
  const root=created.data.id,children=f.d.prepare('SELECT id FROM tasks WHERE parent_task_id=? ORDER BY id').all(root).map(row=>row.id);
  const skill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,created_by) VALUES('Scoped helper skill',0,1)").run().lastInsertRowid);
  for(const [id,level] of [[2,'supervised'],[3,'supervised'],[4,'normal'],[5,'normal'],[6,'normal']])
    f.d.prepare('INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency) VALUES(?,?,?)').run(id,skill,level);
  for(const [index,id] of children.entries()){
    f.d.prepare("UPDATE tasks SET visibility='private' WHERE id=?").run(id);
    f.d.prepare('INSERT INTO task_skill_requirements(task_id,skill_id,sort_order) VALUES(?,?,0)').run(id,skill);
    f.d.prepare('INSERT INTO task_subtask_assignment_rules(task_id,source_json,supervisor_pool_json) VALUES(?,?,?)')
      .run(id,JSON.stringify({kind:'group',group_id:group.id,mode:'random'}),JSON.stringify({kind:'person',user_id:index?5:4}));
  }
  resolveSubtaskOccurrence(f.d,{rootTaskId:root,idempotencyKey:'private-contract',actorId:1});
  reconcileTaskSupervision(f.d,root,{actorId:1,supervisorAssignments:{[children[0]]:null,[children[1]]:null},perActionPlanning:true,notify:false});
  reconcileTaskSupervision(f.d,root,{actorId:1,supervisorAssignments:{[children[0]]:4,[children[1]]:5},perActionPlanning:true,notify:true});
  const view=inspectTaskSupervision(f.d,root),dad=view.actions.find(a=>a.action_task_id===children[0]),mom=view.actions.find(a=>a.action_task_id===children[1]);
  assert.equal(dad.supervisor_user_id,4);assert.equal(mom.supervisor_user_id,5);
  return {...f,root,children,skill,view,dad,mom};
}
const visibleIds=(f,actor)=>f.d.prepare(`SELECT t.id FROM tasks t WHERE ${taskVisibilityWhere(f.d,actor,'t','@me')}`).all({me:actor}).map(row=>row.id).sort((a,b)=>a-b);
const pair=a=>[a.action_task_id,a.counterpart_task_id].sort((a,b)=>a-b);

test('private Dad-only and Mom-only work is usable in SQL, REST and MCP without parent or sibling grants',async t=>{
  const f=await privateSplit(t);
  const app=express();app.use((req,_res,next)=>{const id=Number(req.headers['x-test-user']);req.session={userId:id,role:'member',csrfToken:'a'.repeat(64)};next();});app.use('/reader',readerRouter);
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  for(const [actor,own,other] of [[4,f.dad,f.mom],[5,f.mom,f.dad]]){
    assert.deepEqual(visibleIds(f,actor),pair(own));
    for(const id of pair(own)){
      const rights=taskCapabilities(f.d,actor,{id});assert.equal(rights.view,true);assert.equal(rights.complete,true);
      for(const key of ['edit','change_assignment','delete_archive','claim'])assert.equal(rights[key],false,key);
      const detail=await f.call('GET',`/tasks/${id}`,undefined,actor);
      assert.equal(detail.status,200,JSON.stringify(detail));
      const serialized=JSON.stringify(detail.data);
      for(const hidden of ['SECRET ROOT','SECRET DESCRIPTION',other.action_title])assert.equal(serialized.includes(hidden),false,serialized);
      assert.deepEqual(detail.data.supervision.actions.map(a=>a.action_task_id),[own.action_task_id]);
      assert.equal(detail.data.supervision.source_task_id,null);assert.equal(detail.data.supervision.support_task_id,null);
      assert.equal(detail.data.parent_task_id,null,'a hidden parent is never a navigation target');
      assert.equal(Number.isInteger(detail.data.parent_revision),true,'only its required concurrency token remains');
      assert.equal(detail.data.supervision_action.can_complete,true);
      assert.equal(wallTaskVisible(f.d,id,actor),null,'a personal grant never enters the shared Wall');
    }
    for(const id of [f.root,f.view.support_task_id,...pair(other)]){
      assert.equal(taskCapabilities(f.d,actor,{id}).view,false);
      assert.equal((await f.call('GET',`/tasks/${id}`,undefined,actor)).status,404);
      assert.equal((await f.call('PATCH',`/tasks/${id}/status`,{status:'done'},actor)).status,404);
    }
    const list=await f.call('GET','/tasks?include_future=1',undefined,actor);
    assert.equal(list.status,200,JSON.stringify(list));assert.deepEqual(list.data.map(row=>row.id).sort((a,b)=>a-b),pair(own));
    const mcp=await callTool({db:f.d,actor:{id:actor,role:'member'}},'list_tasks',{include_future:true});
    assert.deepEqual(mcp.map(row=>row.id).sort((a,b)=>a-b),pair(own));
    const reader=await fetch(`http://127.0.0.1:${server.address().port}/reader?view=tasks`,{headers:{'x-test-user':String(actor)}});
    assert.equal(reader.status,200);const html=await reader.text();assert.ok(html.includes(own.action_title));
    for(const hidden of ['SECRET ROOT','SECRET DESCRIPTION',other.action_title])assert.equal(html.includes(hidden),false);
    const inbox=listNotificationInbox(f.d,actor,{limit:20});
    assert.ok(inbox.items.length>0,'the helper receives a usable own-action notification');
    assert.equal(JSON.stringify(inbox).includes('SECRET ROOT'),false);
    assert.equal(JSON.stringify(inbox).includes(other.action_title),false);
  }
  assert.deepEqual(visibleIds(f,6),[],'eligible candidate membership grants nothing');
  const result=await f.call('PATCH',`/tasks/${f.dad.counterpart_task_id}/status`,{status:'done'},4);
  assert.equal(result.status,200,JSON.stringify(result));
  assert.equal(result.data.access_ended,true);
  assert.deepEqual(Object.keys(result.data).sort(),['access_ended','id','permissions','revision','status']);
  assert.equal(f.row(f.dad.action_task_id).status,'done');
  assert.equal(f.row(f.mom.action_task_id).status,'open');
  assert.deepEqual(visibleIds(f,4),[],'completed history does not preserve private access');
});

test('private helper rights disappear immediately after revocation, reassignment or qualification loss',async t=>{
  const f=await privateSplit(t);
  const initialList=await f.call('GET','/tasks?include_future=1',undefined,4),cursor=initialList.delta_cursor;
  assert.equal(typeof cursor,'string');
  const rejected=async()=>{
    assert.deepEqual(visibleIds(f,4),[]);
    for(const id of pair(f.dad)){
      assert.equal(taskCapabilities(f.d,4,{id}).view,false);
      assert.equal((await f.call('GET',`/tasks/${id}`,undefined,4)).status,404);
      assert.equal((await f.call('PATCH',`/tasks/${id}/status`,{status:'done'},4)).status,404);
    }
    const delta=await f.call('GET',`/tasks?include_future=1&delta=${encodeURIComponent(cursor)}`,undefined,4);
    assert.equal(delta.reset_required,true,'a cached list cannot retain a private grant after eligibility changes');
  };
  withTaskReadProjection(f.d,4,()=>{
    assert.equal(taskCapabilities(f.d,4,{id:f.dad.action_task_id}).view,true);
    f.d.prepare("UPDATE task_responsibilities SET status='superseded' WHERE task_id=? AND user_id=4 AND role='supervisor'").run(f.root);
    assert.equal(taskCapabilities(f.d,4,{id:f.dad.action_task_id}).view,false,'an old read scope cannot retain revoked rights');
  });
  await rejected();
  f.d.prepare("UPDATE task_responsibilities SET status='active' WHERE task_id=? AND user_id=4 AND role='supervisor'").run(f.root);
  f.d.prepare("UPDATE user_skill_proficiency SET proficiency='excluded' WHERE user_id=4 AND skill_id=?").run(f.skill);
  await rejected();
  f.d.prepare("UPDATE user_skill_proficiency SET proficiency='normal' WHERE user_id=4 AND skill_id=?").run(f.skill);
  f.d.prepare("INSERT INTO task_planning_context(task_id,presence_policy,presence_window,source) VALUES(?,'available_before_due','due','manual') ON CONFLICT(task_id) DO UPDATE SET presence_policy='available_before_due',presence_window='due'").run(f.root);
  f.d.prepare("INSERT INTO availability_periods(user_id,source,state,starts_at,ends_at,note) VALUES(4,'explicit','busy','2026-11-01T00:00','2026-11-02T00:00','Busy')").run();
  await rejected();
  f.d.prepare('DELETE FROM availability_periods WHERE user_id=4').run();
  f.d.prepare("UPDATE task_planning_context SET presence_policy='ignore' WHERE task_id=?").run(f.root);
  f.d.prepare('UPDATE task_subtask_assignment_rules SET supervisor_pool_json=? WHERE task_id=?').run(JSON.stringify({kind:'person',user_id:6}),f.dad.action_task_id);
  reconcileTaskSupervision(f.d,f.root,{actorId:1,supervisorAssignments:{[f.dad.action_task_id]:6},perActionPlanning:true,notify:false});
  await rejected();assert.deepEqual(visibleIds(f,6),pair(f.dad));
  assert.deepEqual(visibleIds(f,5),pair(f.mom),'an unrelated helper retains exactly their own work');
});

test('a supervisor Group candidate and an unassigned descendant receive no inherited private grant',async t=>{
  const f=await privateSplit(t),pool=saveRotationGroup(f.d,{name:'Dad pool with unselected candidate',member_ids:[4,6]},{actorId:1});
  f.d.prepare('UPDATE task_subtask_assignment_rules SET supervisor_pool_json=? WHERE task_id=?')
    .run(JSON.stringify({kind:'group',group_id:pool.id}),f.dad.action_task_id);
  const nested=Number(f.d.prepare("INSERT INTO tasks(title,parent_task_id,created_by,visibility) VALUES('Unrelated nested step',?,1,'all')").run(f.dad.action_task_id).lastInsertRowid);
  assert.deepEqual(visibleIds(f,4),pair(f.dad));
  assert.deepEqual(visibleIds(f,6),[]);
  assert.equal(taskCapabilities(f.d,4,{id:nested}).view,false);
  assert.equal((await f.call('GET',`/tasks/${nested}`,undefined,4)).status,404);
  const detail=await f.call('GET',`/tasks/${f.dad.action_task_id}`,undefined,4);
  assert.equal(detail.status,200);assert.deepEqual(detail.data.subtasks,[]);
});

test('a helper without Task view permission cannot gain new linked work and the transaction rolls back',async t=>{
  const f=await privateSplit(t);
  f.d.prepare('UPDATE task_subtask_assignment_rules SET supervisor_pool_json=? WHERE task_id=?')
    .run(JSON.stringify({kind:'person',user_id:6}),f.dad.action_task_id);
  replaceSubjectPermissions(f.d,'user',6,{capabilities:{'tasks.view_household':'none','tasks.view_own':'none'}});
  const before=f.snapshot();
  const result=await f.call('POST',`/tasks/${f.root}/supervisor`,{action_task_id:f.dad.action_task_id,
    supervisor_user_id:6,expected_action_revision:f.dad.revision});
  assert.equal(result.status,409,JSON.stringify(result));
  assert.match(result.error,/cannot access/);
  assert.equal(f.snapshot(),before);
});

test('a stale read scope rechecks a concurrent connection after private supervisor revocation',async t=>{
  const f=await privateSplit(t),directory=mkdtempSync(join(tmpdir(),'supervisor-access-')),file=join(directory,'synthetic.db');
  await f.d.backup(file);
  const reader=new Database(file),writer=new Database(file);reader.pragma('journal_mode=WAL');
  try{
    withTaskReadProjection(reader,4,()=>{
      assert.equal(taskCapabilities(reader,4,{id:f.dad.action_task_id}).view,true);
      const earlierWhere=taskVisibilityWhere(reader,4,'t','@me');
      writer.prepare("UPDATE task_responsibilities SET status='superseded' WHERE task_id=? AND user_id=4 AND role='supervisor'").run(f.root);
      assert.deepEqual(reader.prepare(`SELECT t.id FROM tasks t WHERE ${earlierWhere}`).all({me:4}),[],
        'a previously built SQL fragment must still enforce current assignment revocation');
      assert.equal(taskCapabilities(reader,4,{id:f.dad.action_task_id}).view,false);
      assert.deepEqual(visibleIds({...f,d:reader},4),[]);
      writer.prepare("UPDATE task_responsibilities SET status='active' WHERE task_id=? AND user_id=4 AND role='supervisor'").run(f.root);
      const qualifiedWhere=taskVisibilityWhere(reader,4,'t','@me');
      writer.prepare("UPDATE user_skill_proficiency SET proficiency='excluded' WHERE user_id=4 AND skill_id=?").run(f.skill);
      assert.deepEqual(reader.prepare(`SELECT t.id FROM tasks t WHERE ${qualifiedWhere}`).all({me:4}),[],
        'a previously built SQL fragment cannot outlive its qualification assessment');
    });
  }finally{
    writer.close();reader.close();
    for(const path of [file,file+'-wal',file+'-shm'])if(existsSync(path))unlinkSync(path);
    rmdirSync(directory);
  }
});
