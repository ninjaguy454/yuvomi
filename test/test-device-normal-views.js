import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

function store() {
  const data = new Map();
  const context = vm.createContext({
    Map, Set, JSON, window: { dispatchEvent() {} }, navigator: {},
    localStorage: { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
  });
  for (const path of ['../public/utils/device-context.js', '../public/permissions.js']) {
    vm.runInContext(readFileSync(new URL(path, import.meta.url), 'utf8').replaceAll('export ', ''), context);
  }
  return source => vm.runInContext(source, context);
}

test('paired defaults land in the same Dashboard, List and Kanban routes without becoming a member', () => {
  const run = store();
  run("acceptAuthentication({authContext:'context-1',principal:{kind:'device'},user:{id:null,kind:'device'},device:{preferences:{default_view:'wall'}}})");
  assert.equal(run('isDevicePrincipal()'), true);
  assert.equal(run('deviceBootstrap().user.id'), null);
  assert.equal(run('deviceLandingPath()'), '/');
  assert.equal(run("deviceLandingPath({device:{preferences:{default_view:'list'}}})"), '/tasks?view=list');
  assert.equal(run("deviceLandingPath({device:{preferences:{default_view:'kanban'}}})"), '/tasks?view=kanban');
  assert.equal(run("deviceLandingPath({device:{preferences:{default_view:'https://outside.invalid'}}})"), '/');
});

test('device navigation, widgets and actions fail closed while explicit normal Task permissions remain usable', () => {
  const run = store();
  run("setPermissions({principal_kind:'device',modules:{dashboard:'read',tasks:'read'},widgets:{tasks:'allow'},capabilities:{'device_tasks.complete':'allow','tasks.create':'none'}})");
  assert.equal(run("canAccessNavModule('tasks')"), true);
  assert.equal(run("canAccessNavModule('dashboard')"), true);
  for (const module of ['settings', 'unknown-module', 'budget', 'health', 'recipes', 'birthdays']) assert.equal(run('canAccessNavModule(' + JSON.stringify(module) + ')'), false);
  assert.equal(run("canSeeWidget('tasks')"), true);
  assert.equal(run("canSeeWidget('cycle')"), false);
  assert.equal(run("canCapability('device_tasks.complete')"), true);
  assert.equal(run("canCapability('tasks.create')"), false);
  assert.equal(run("canTask({permissions:{complete:true}}, 'complete')"), true);
  assert.equal(run("canTask({permissions:{complete:false}}, 'complete')"), false);
});

test('temporary personal access restores personal navigation only with the authenticated payload', () => {
  const run = store();
  run("acceptAuthentication({authContext:'device',principal:{kind:'device'},device:{}});setPermissions({principal_kind:'device',modules:{tasks:'read'}})");
  assert.equal(run("canAccessNavModule('settings')"), false);
  run("acceptAuthentication({authContext:'personal',principal:{kind:'member'},user:{id:7},device:{},temporary:{}});setPermissions({principal_kind:'member',admin:true})");
  assert.equal(run('isDevicePrincipal()'), false);
  assert.equal(run("canAccessNavModule('settings')"), true);
  run("acceptAuthentication({authContext:'device-returned',principal:{kind:'device'},device:{}});setPermissions({principal_kind:'device',modules:{tasks:'read'}})");
  assert.equal(run('isDevicePrincipal()'), true);
  assert.equal(run("canAccessNavModule('settings')"), false);
});

test('existing personal sparse module defaults remain unchanged', () => {
  const run = store();
  run("setPermissions({principal_kind:'member',modules:{budget:'none'}})");
  assert.equal(run("canAccessNavModule('tasks')"), true);
  assert.equal(run("canAccessNavModule('settings')"), true);
  assert.equal(run("canAccessNavModule('budget')"), false);
  assert.equal(run("canCapability('tasks.create')"), false);
});

function scoringDisplay(payload) {
  const context=vm.createContext({Map,Set,JSON,Number,String,Object,
    window:{dispatchEvent(){}},navigator:{},localStorage:{setItem(){}},
    CustomEvent:class{},t:(key,values)=>values?`${key}${JSON.stringify(values)}`:key});
  for(const path of ['device-context','task-progress','task-fields'])vm.runInContext(
    readFileSync(new URL(`../public/utils/${path}.js`,import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replaceAll('export ',''),context);
  vm.runInContext(`acceptAuthentication(${JSON.stringify({authContext:'fixture',...payload})})`,context);
  return (source,task)=>{context.task=structuredClone(task);return vm.runInContext(source,context);};
}
const sharedDevice={principal:{kind:'device'},device:{id:9}};
const temporaryDevice={principal:{kind:'member'},user:{id:1},device:{id:9},temporary:{expiresAt:'2030-01-01'}};
const personalMember={principal:{kind:'member'},user:{id:1}};
const wholeScore=()=>({id:70,status:'open',points:2,assigned_to:2,subtasks:[],scoring:{mode:'whole_task',root_task_id:70,personal_total:0,earned:[],potential:[{user_id:2,points:2}],settlements:[]}});

for(const [name,payload] of [['anonymous device',sharedDevice],['temporary member on device',temporaryDevice]])test(`${name} shows configured whole-task worth even when viewer earns zero`,()=>{
  const run=scoringDisplay(payload),task=wholeScore();
  assert.equal(run('taskCompletionPoints(task)',task),2);
  assert.equal(run('taskScoringLabel(task,1)',task),'tasks.pointsSummary{"count":2}');
  assert.equal(run('taskScoringAmounts(task,1).total',task),0,'personal award accounting remains separate');
});

test('personal sign-in keeps personal points and earned/available labels',()=>{
  const run=scoringDisplay(personalMember),task=wholeScore();
  assert.equal(run('taskCompletionPoints(task)',task),0);
  assert.equal(run('taskScoringLabel(task,1)',task),'tasks.scoringEarned 0 · tasks.scoringAvailable 0');
  assert.equal(run('taskCompletionPoints(task)',{...task,scoring:{...task.scoring,personal_total:7}}),7);
});

test('shared worth is neither lost without assignees nor multiplied by recipients',()=>{
  const run=scoringDisplay(sharedDevice),task=wholeScore();
  assert.equal(run('taskCompletionPoints(task)',{...task,assigned_to:null,scoring:{...task.scoring,potential:[]}}),2);
  assert.equal(run('taskCompletionPoints(task)',{...task,scoring:{...task.scoring,potential:[{user_id:2,points:2},{user_id:3,points:2}]}}),2);
});

test('shared subtask worth counts only authorized direct source actions once',()=>{
  const run=scoringDisplay(sharedDevice),task=wholeScore();task.points=999;task.scoring.mode='subtasks';
  const action=(id,points,extra={})=>({id,parent_task_id:70,status:'open',points,scoring:{...task.scoring},...extra});
  task.subtasks=[action(71,3),action(72,5,{is_optional:true}),action(71,3),action(73,500,{is_supervision_projection:true}),
    action(74,500,{is_support_task:true}),action(75,500,{archived_at:'2026-01-01'}),action(76,500,{scoring:null}),
    action(77,500,{scoring:{mode:'whole_task',root_task_id:77}}),action(78,500,{parent_task_id:71}),
    action(79,500,{status:'expired'}),action(80,500,{status:'skipped'})];
  assert.equal(run('taskCompletionPoints(task)',task),8);
  assert.equal(run('taskScoringLabel(task,1)',task),'tasks.pointsSummary{"count":8}');
  assert.equal(run('taskCompletionPoints(task)',task.subtasks[0]),3);
  assert.equal(run('taskCompletionPoints(task)',{...task.subtasks[0],scoring:{...task.scoring,mode:'whole_task'}}),0);
});

test('shared badges respect unavailable projections and closed occurrence zero semantics',()=>{
  const run=scoringDisplay(sharedDevice),task=wholeScore();
  assert.equal(run('taskCompletionPoints(task)',{...task,scoring:null}),null);
  assert.equal(run('taskScoringLabel(task,1)',{...task,scoring:null}),'tasks.scoringPersonalUnavailable');
  assert.equal(run('taskCompletionPoints(task)',{...task,is_supervision_projection:true}),null);
  for(const status of ['expired','skipped'])assert.equal(run('taskCompletionPoints(task)',{...task,status}),0);
  assert.equal(run('taskCompletionPoints(task)',{...task,status:'done'}),2,'worth is not presented as an award');
  assert.equal(run('taskCompletionPoints(task)',{...task,scoring:{...task.scoring,mode:'subtasks'},subtasks:[]}),0,'no hidden children are inferred');
});

test('Wall details can explicitly retain shared worth while an actor is identified',()=>{
  const run=scoringDisplay(personalMember),task=wholeScore();
  assert.equal(run('taskScoringLabel(task,1,{shared:true})',task),'tasks.pointsSummary{"count":2}');
});

test('shared boards consume authorized configured scalar even when scheduled children are absent',()=>{
 const run=scoringDisplay(temporaryDevice),task=wholeScore();task.scoring.mode='subtasks';task.scoring.configured_total=15;
 assert.equal(run('taskCompletionPoints(task)',task),15);
 assert.equal(run('taskScoringLabel(task,1)',task),'tasks.pointsSummary{"count":15}');
 assert.equal(run('taskCompletionPoints(task)',{...task,scoring:{...task.scoring,configured_total:null}}),null);
 assert.equal(run('taskCompletionPoints(task)',{...task,scoring:{...task.scoring,mode:'legacy',configured_total:null}}),null);
});

test('authentication replacement restores personal badge semantics without retaining device context',()=>{
 const run=scoringDisplay(sharedDevice),task=wholeScore();assert.equal(run('taskCompletionPoints(task)',task),2);
 assert.equal(run('acceptAuthentication({authContext:"personal-new",principal:{kind:"member"},user:{id:1}});taskCompletionPoints(task)',task),0);
});
