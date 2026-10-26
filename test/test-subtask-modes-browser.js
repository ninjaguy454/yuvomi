import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import puppeteer from 'puppeteer';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';
import {saveRotationGroup} from '../server/services/rotation.js';
import {instantiateWorkflow} from '../server/services/activity-workflows.js';
const styles=[...readFileSync(new URL('../public/index.html',import.meta.url),'utf8').matchAll(/<link rel="stylesheet" href="([^"]+)"\s*\/>/g)].map(([,href])=>`<link rel="stylesheet" href="${href}">`).join('');
const app=express();
let routeFixture=null;
app.use(express.json());
app.get('/fixture',(_req,res)=>res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">${styles}<link rel="stylesheet" href="/styles/tasks.css"></head><body><form id="fixture"></form></body></html>`));
app.use(express.static(fileURLToPath(new URL('../public',import.meta.url))));
app.use('/api/v1',async(req,res)=>{
  if(!routeFixture)return res.json({data:[]});
  const result=await routeFixture.call(req.method,req.url,req.method==='GET'?undefined:req.body);
  res.status(result.status).json(result);
});
let browser,server,origin;
test.before(async()=>{
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));origin=`http://127.0.0.1:${server.address().port}`;
  browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--no-sandbox','--disable-dev-shm-usage']});
});
test.after(async()=>{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
for(const template of [false,true])test(`mode and supervisor draft round trip with keyboard at mobile width (${template?'Template':'Task'})`,async()=>{
  const page=await browser.newPage();try{
    await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});await page.goto(origin+'/fixture');
    await page.evaluate(async template=>{
      localStorage.setItem('yuvomi-locale','en');await(await import('/i18n.js')).initI18n();
      const c=await import('/components/task-requirements.js');window.components=c;
      window.users=[{id:1,display_name:'Parent'},{id:2,display_name:'Worker'}];
      window.groups=[{id:8,name:'Independent',active:1,members:users},{id:9,name:'Universal',active:1,usage_mode:'shared',members:users}];
      window.skills=[{id:6,name:'Supervised skill'}];
      window.saved=[{id:11,title:'Smart work',skill_ids:[6],assigned_to:2,assignment_rule:{kind:'group',group_id:8,mode:'smart'},supervisor_pool:{kind:'person',user_id:1}},
        {id:12,title:'Universal work',skill_ids:[],assignment_rule:{kind:'group',group_id:9,mode:'global'}}];
      window.mount=()=>{window.editor?.dispose();document.querySelector('#fixture').innerHTML=c.renderSubtaskEditor({subtasks:saved,template,users,groups,skills});
        window.editor=c.bindSubtaskEditor(document.querySelector('#fixture'),{template,users,groups,skills,assignmentsEnabled:true});};
      mount();await editor.ready;
    },template);
    const mode='[data-subtask-id="11"] [data-task-subtask-mode]';
    assert.equal(await page.$eval(mode,e=>e.value),'smart');
    assert.equal(await page.$eval('[data-subtask-id="12"] [data-task-subtask-mode]',e=>e.disabled),true);
    await page.focus(mode);await page.keyboard.press('Home');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
    await page.select(mode,'random');
    const before=await page.evaluate(()=>editor.getValue());assert.equal(before[0].assignment_rule.mode,'random');assert.deepEqual(before[0].supervisor_pool,{kind:'person',user_id:1});
    assert.equal(before[0].assignment_group,null);assert.equal(before[0].assigned_user_ids,undefined);
    await page.evaluate(()=>{saved=editor.getValue();mount();});assert.equal(await page.$eval(mode,e=>e.value),'random');
    assert.equal(await page.$eval('[data-subtask-id="11"] [data-task-subtask-supervisor]',e=>e.value),'person:1');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    const draft=await page.evaluate(async()=>{
      const {createManualTaskDraft,taskDraftToActivity}=await import('/utils/task-draft.js');
      return {manual:createManualTaskDraft({template:{checklist:[{title_template:'Rule',assignment_rule_json:JSON.stringify(saved[0].assignment_rule),supervisor_pool_json:JSON.stringify(saved[0].supervisor_pool)}]}}),
        template:taskDraftToActivity({title:'Saved template',subtasks:saved})};
    });
    assert.equal(draft.manual.subtasks[0].assignment_rule.mode,'random');assert.equal(draft.template.checklist[0].assignment_rule.mode,'random');
  }finally{await page.close();}
});

test('the browser mode draft creates and edits a Template and launches its actual worker',async t=>{
  const f=await scoringFixture(t);routeFixture=f;
  const g=saveRotationGroup(f.d,{name:'Browser workers',member_ids:[2,3]},{actorId:1}),page=await browser.newPage();
  try{
    await page.goto(origin+'/fixture');
    await page.evaluate(async group=>{
      const c=await import('/components/task-requirements.js');window.api=(await import('/api.js')).api;
      window.users=[{id:1,display_name:'Owner'},{id:2,display_name:'One'},{id:3,display_name:'Two'}];window.groups=[{...group,members:users.slice(1)}];
      document.querySelector('#fixture').innerHTML=c.renderSubtaskEditor({template:true,users,groups,subtasks:[{title:'Browser child',assignment_rule:{kind:'group',group_id:group.id,mode:'random'}}]});
      window.editor=c.bindSubtaskEditor(document.querySelector('#fixture'),{template:true,users,groups,assignmentsEnabled:true});
    },g);
    await page.select('[data-task-subtask-mode]','smart');
    const template=await page.evaluate(async()=>await api.post('/automation/admin/activity-templates',{name:'Browser mode template',assignment_strategy:'fixed',fixed_user_id:1,
      checklist:editor.getValue().map(row=>({...row,title_template:row.title}))}));
    assert.equal(JSON.parse(template.data.checklist[0].assignment_rule_json).mode,'smart');
    const launched=await page.evaluate(async id=>await api.post('/tasks',{activity_template_id:id,points:0}),template.data.id);
    assert.equal(launched.data.subtasks[0].assigned_to,2);
    await page.select('[data-task-subtask-mode]','synced');
    const edited=await page.evaluate(async template=>await api.put('/automation/admin/activity-templates/'+template.id,{checklist:editor.getValue().map(row=>({...row,id:template.checklist[0].id,title_template:row.title}))}),template.data);
    assert.equal(JSON.parse(edited.data.checklist[0].assignment_rule_json).mode,'synced');
    assert.equal(f.d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(launched.data.subtasks[0].id).assigned_to,2);
  }finally{routeFixture=null;await page.close();}
});

test('shared mode transitions require an explicit Global confirmation and legacy Group drafts retain their policy',async()=>{
  const page=await browser.newPage();try{
    await page.goto(origin+'/fixture');
    const initial=await page.evaluate(async()=>{
      const c=await import('/components/task-requirements.js');const users=[{id:1,display_name:'One'}],groups=[{id:8,name:'Universal',usage_mode:'shared',active:1,members:users}];
      document.querySelector('#fixture').innerHTML=c.renderSubtaskEditor({users,groups,subtasks:[{id:11,title:'Changed schedule',assignment_rule:{kind:'group',group_id:8,start_mode:'first',direction:'first_to_last',mode:'smart'}},
        {id:12,title:'Legacy policy',assignment_group:{group_id:8,start_mode:'first',direction:'first_to_last'}}]});
      window.editor=c.bindSubtaskEditor(document.querySelector('#fixture'),{users,groups,assignmentsEnabled:true});return editor.getValue();
    });
    assert.equal(initial[0].assignment_rule.mode,'smart');assert.equal(initial[1].assignment_rule,undefined);
    await page.click('[data-subtask-id="11"] [data-task-subtask-confirm-global]');
    assert.equal(await page.evaluate(()=>editor.getValue()[0].assignment_rule.mode),'global');
    assert.equal(await page.$eval('[data-subtask-id="11"] [data-task-subtask-mode]',node=>node.disabled),true);
  }finally{await page.close();}
});

test('a new future-only Group rule carries one source policy without a contradictory direct assignment',async()=>{
  const page=await browser.newPage();try{
    await page.goto(origin+'/fixture');
    const patch=await page.evaluate(async()=>{
      const {taskFuturePatch}=await import('/utils/task-edit-scope.js');
      return taskFuturePatch({fields:{},actions:[]},{subtasks:[{client_key:'new_group',title:'New Smart action',assignment_group:null,
        assignment_rule:{kind:'group',group_id:8,mode:'smart'},supervisor_pool:null}]});
    });
    assert.equal(patch.actions.add[0].fields.assignment_rule.mode,'smart');
    assert.equal(Object.hasOwn(patch.actions.add[0].fields,'assignment_group'),false);
    assert.equal(Object.hasOwn(patch.actions.add[0].fields,'assigned_user_ids'),false);
  }finally{await page.close();}
});

test('a nested Workflow Activity exposes and executes unfinished assignment recovery',async t=>{
  const f=await scoringFixture(t);routeFixture=f;const page=await browser.newPage();
  try{
    const g=saveRotationGroup(f.d,{name:'Workflow recovery workers',member_ids:[2]},{actorId:1});
    const skill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,created_by) VALUES('Browser recovery skill',0,1)").run().lastInsertRowid);
    f.d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency) VALUES(2,?,'excluded')").run(skill);
    const template=await f.call('POST','/automation/admin/activity-templates',{name:'Workflow recovery',assignment_strategy:'fixed',fixed_user_id:1,
      checklist:[{title_template:'Blocked action',skill_ids:[skill],assignment_rule:{kind:'group',group_id:g.id,mode:'smart'}}]});
    assert.equal(template.status,201,JSON.stringify(template));
    const wid=Number(f.d.prepare("INSERT INTO workflow_templates(name,category,subject_required,created_by) VALUES('Recovery workflow','misc',0,1)").run().lastInsertRowid);
    f.d.prepare("INSERT INTO workflow_template_steps(workflow_template_id,activity_template_id,step_key,sort_order) VALUES(?,?,'step',0)").run(wid,template.data.id);
    const made=instantiateWorkflow(f.d,wid,{createdBy:1,startDate:'2026-11-01'}),activity=made.tasks.find(row=>row.role==='primary');
    const fresh=await f.call('GET','/tasks/'+activity.task_id);assert.equal(fresh.status,200,JSON.stringify(fresh));
    await page.goto(origin+'/fixture');
    const opened=await page.evaluate(async task=>{
      const module=await import('/pages/tasks.js');return module.openOccurrenceReassignmentModal(task,{users:[{id:1,display_name:'Owner'},{id:2,display_name:'Worker'}]});
    },fresh.data);
    assert.equal(opened,true);assert.ok(await page.$('[data-occurrence-resolve]'));
    f.d.prepare("UPDATE user_skill_proficiency SET proficiency='normal' WHERE user_id=2 AND skill_id=?").run(skill);
    await page.click('[data-occurrence-resolve]');
    await page.waitForFunction(()=>document.querySelector('[data-occurrence-resolve-status]')?.textContent==='Assignments saved for this occurrence.');
    const action=f.d.prepare('SELECT id FROM tasks WHERE parent_task_id=?').get(activity.task_id);
    assert.deepEqual(f.d.prepare('SELECT user_id FROM task_assignments WHERE task_id=?').all(action.id),[{user_id:2}]);
    const resolved=await f.call('GET','/tasks/'+activity.task_id);
    await page.evaluate(async task=>{document.querySelectorAll('.modal-backdrop').forEach(e=>e.remove());
      const module=await import('/pages/tasks.js');return module.openOccurrenceReassignmentModal(task,{users:[{id:1,display_name:'Owner'},{id:2,display_name:'Worker'}]});},resolved.data);
    assert.ok(await page.$('[data-occurrence-person="2"]'),'resolved Workflow worker retains occurrence-only reassignment entry');

  }finally{routeFixture=null;await page.close();}
});
