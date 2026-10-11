import test from 'node:test';
import assert from 'node:assert/strict';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';
import {awardForCompletion} from '../server/services/rewards.js';
import {taskScoringSummary,previewTaskScoring} from '../server/services/task-scoring.js';
import {authorizedScoringHistoryIds} from '../server/routes/tasks.js';
import {createDevice} from '../server/services/devices.js';
import {deviceTaskDetail} from '../server/services/device-tasks.js';
import {deviceTaskVisible} from '../server/services/task-access.js';
import {wallTaskVisible} from '../server/services/wall.js';

function seed(f,points=0,{parent=null,visibility='all',assigned=[3]}={}){
 // Established legacy/internal data, rather than public creation of a new
 // ordinary legacy definition. The genuine award writer settles these rows.
 const id=Number(f.d.prepare("INSERT INTO tasks(title,created_by,parent_task_id,visibility,points,assigned_to) VALUES('Synthetic history',1,?,?,?,?)").run(parent,visibility,points,assigned[0]??null).lastInsertRowid);
 for(const user of assigned)f.d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(id,user);return id;
}
function earn(f,id){f.d.prepare("UPDATE tasks SET status='done' WHERE id=?").run(id);assert.equal(awardForCompletion(f.d,id,1),true);}
const credit=points=>[{user_id:3,points}];
async function views(f,root,principal,viewer=2){
 const snapshot=f.snapshot(),changes=f.changes(),wall=await f.call('GET','/wall/tasks/'+root,undefined,viewer),personal=await f.call('GET','/tasks/'+root,undefined,viewer);
 assert.equal(wall.status,200);assert.equal(personal.status,200);const device=deviceTaskDetail(f.d,principal,root),allowed=authorizedScoringHistoryIds(f.row(root),viewer,[root],{publicOnly:true}),explicit=taskScoringSummary(f.d,root,{viewerId:null,authorizedTaskIds:allowed}),enriched=previewTaskScoring(f.d,root,{}, {viewerId:null,authorizedTaskIds:allowed,includeUnits:true});
 assert.deepEqual(enriched.earned,explicit.earned);assert.deepEqual(enriched.settlements.map(row=>row.task_id),explicit.settled_task_ids);assert.equal(f.snapshot(),snapshot);assert.equal(f.changes(),changes);assert.equal(JSON.stringify({wall,personal,device,explicit,enriched}).includes('public_ancestry'),false);return {wall:wall.data.scoring,personal:personal.data.scoring,device:device.scoring,explicit};
}
test('historical ancestry real Wall and device reads retain private intermediate denial after genuine live settlement and cascade deletion',async t=>{
 const f=await scoringFixture(t),root=seed(f),middle=seed(f,0,{parent:root,visibility:'private'}),leaf=seed(f,37,{parent:middle});earn(f,leaf);const principal={kind:'device',...createDevice(f.d,{name:'Synthetic ancestry display',scope:{member_ids:[],show_points:true}},1)};
 assert.equal(deviceTaskVisible(f.d,principal,leaf),false);assert.equal(wallTaskVisible(f.d,leaf,2),null);assert.throws(()=>deviceTaskDetail(f.d,principal,leaf),error=>error.status===404);
 const before=await views(f,root,principal);for(const name of ['wall','device','explicit']){assert.deepEqual(before[name].earned,[]);assert.equal(before[name].mode_locked,true);}assert.deepEqual(before.personal.earned,credit(37));
 const frozen=JSON.stringify(f.d.prepare('SELECT * FROM task_scoring_settlements').all());f.d.prepare('DELETE FROM tasks WHERE id=?').run(middle);const after=await views(f,root,principal);
 for(const name of ['wall','device','explicit']){assert.deepEqual(after[name].earned,[]);assert.deepEqual(after[name].settlements,[]);assert.deepEqual(after[name].settled_task_ids,[]);assert.equal(after[name].mode_locked,true);assert.equal(after[name].personal_total,null);}assert.deepEqual(after.personal.earned,credit(37));assert.equal(JSON.stringify(f.d.prepare('SELECT * FROM task_scoring_settlements').all()),frozen);
});
test('historical ancestry real shared controls retain new flat public history and personal creator or actual-join history',async t=>{
 const f=await scoringFixture(t),root=seed(f),publicLeaf=seed(f,11,{parent:root}),privateLeaf=seed(f,17,{parent:root,visibility:'private'}),assignedLeaf=seed(f,19,{parent:root,visibility:'assignees'});for(const id of [publicLeaf,privateLeaf,assignedLeaf])earn(f,id);const principal={kind:'device',...createDevice(f.d,{name:'Synthetic public history display'},1)};
 const before=await views(f,root,principal);for(const name of ['wall','device','explicit','personal'])assert.deepEqual(before[name].earned,credit(11));f.d.prepare('DELETE FROM tasks WHERE parent_task_id=?').run(root);const after=await views(f,root,principal);
 for(const name of ['wall','device','explicit','personal']){assert.deepEqual(after[name].earned,credit(11));assert.deepEqual(after[name].settled_task_ids,[publicLeaf]);assert.equal(after[name].mode_locked,true);}
 const creator=await views(f,root,principal,1),joined=await views(f,root,principal,3);assert.deepEqual(creator.personal.earned,credit(47));assert.deepEqual(joined.personal.earned,credit(30));assert.deepEqual(creator.wall.earned,credit(11));assert.deepEqual(joined.wall.earned,credit(11));
 principal.scope.member_ids=[3];const snapshot=f.snapshot(),changes=f.changes();assert.deepEqual(deviceTaskDetail(f.d,principal,root).scoring.earned,[]);assert.equal(f.snapshot(),snapshot);assert.equal(f.changes(),changes);
});
test('historical ancestry real shared readers conservatively withhold absent old leaf-only snapshots without changing personal history',async t=>{
 const f=await scoringFixture(t),root=seed(f),leaf=seed(f,7,{parent:root});
 // Honest prior-format append-only fixture, inserted once. No immutable row
 // is updated, and no new writer is used to fabricate a missing old field.
 f.d.prepare(`INSERT INTO task_scoring_settlements(logical_key,claim_key,task_id,root_task_id,root_logical_key,mode,points,recipients_json,earned_once,outcome,settled_at,visibility_json)
 VALUES(?,?,?, ?,?,'legacy',7,?,1,'earned','2024-01-02T03:04:05Z',?)`).run(JSON.stringify(['task',leaf]),JSON.stringify(['old-format',leaf]),leaf,root,JSON.stringify(['task',root]),JSON.stringify(credit(7)),JSON.stringify({visibility:'all',created_by:1,assigned:[3]}));
 const principal={kind:'device',...createDevice(f.d,{name:'Synthetic old history display'},1)},before=await views(f,root,principal);for(const result of Object.values(before))assert.deepEqual(result.earned,credit(7));const frozen=JSON.stringify(f.d.prepare('SELECT * FROM task_scoring_settlements').all());f.d.prepare('DELETE FROM tasks WHERE id=?').run(leaf);const after=await views(f,root,principal);
 for(const name of ['wall','device','explicit']){assert.deepEqual(after[name].earned,[]);assert.deepEqual(after[name].settlements,[]);assert.equal(after[name].mode_locked,true);}assert.deepEqual(after.personal.earned,credit(7));assert.equal(JSON.stringify(f.d.prepare('SELECT * FROM task_scoring_settlements').all()),frozen);
});
test('historical ancestry real device archive inclusion cannot bypass a private ancestor while public archived earning remains',async t=>{
 const f=await scoringFixture(t),root=seed(f),middle=seed(f,0,{parent:root,visibility:'private'}),hidden=seed(f,37,{parent:middle}),publicLeaf=seed(f,11,{parent:root});earn(f,hidden);earn(f,publicLeaf);f.d.prepare("UPDATE tasks SET archived_at='2026-10-11T00:00:00Z' WHERE id IN (?,?)").run(hidden,publicLeaf);const principal={kind:'device',...createDevice(f.d,{name:'Synthetic archived history display'},1)},result=await views(f,root,principal);
 for(const name of ['wall','device','explicit']){assert.deepEqual(result[name].earned,credit(11));assert.deepEqual(result[name].settled_task_ids,[publicLeaf]);assert.equal(result[name].mode_locked,true);}assert.deepEqual(result.personal.earned,credit(48));
});
