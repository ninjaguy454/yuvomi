import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cycleFixture, validCycleSettings } from './meal-cycle-fixture.js';
import { addMealCycleSchema } from '../server/services/meal-cycle-schema.js';
import { getCycleSettings, saveCycleSettings } from '../server/services/meal-cycle-settings.js';
import { periodForStart, cycleInstants, dueCyclePeriods } from '../server/services/meal-cycle-schedule.js';

const save = (d,input,revision=0,key='setup') => saveCycleSettings(d,input,{actorId:1,expectedRevision:revision,requestKey:key});
test('disabled defaults display household timezone without guessing timing or IDs or persisting settings', () => {
  const d=cycleFixture();
  assert.deepEqual(getCycleSettings(d),{revision:0,enabled:false,timezone:'Europe/Berlin',cadence:null,first_period_start:null,
    creation:null,response:null,confirmation:null,shopping:null,coordinator_id:null,shopping_assignee_id:null,
    shopping_list_id:null,finalization_mode:'manual'});
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM meal_cycle_settings').get().n,0);
  assert.deepEqual(dueCyclePeriods(getCycleSettings(d),'2026-10-01T00:00:00Z'),[]);d.close();
});
test('activation requires explicit setup and settings validates fields even while disabled', () => {
  const d=cycleFixture();
  for(const key of ['timezone','cadence','first_period_start','creation','response','confirmation','shopping','coordinator_id','shopping_assignee_id','shopping_list_id']) {
    assert.throws(()=>save(d,validCycleSettings({[key]:null})),undefined,key);
  }
  for(const patch of [{timezone:'Mars/Unknown'},{timezone:'America/New_York'},{first_period_start:'2026-02-30'},
    {creation:{day_offset:0,time:'25:00'}},{creation:{day_offset:1.5,time:'09:00'}},{finalization_mode:'guess'},
    {coordinator_id:999},{shopping_assignee_id:999},{shopping_list_id:999},{enabled:1},{enabled:false,timezone:undefined},
    {enabled:false,timezone:'Mars/Unknown'},{response:{day_offset:1,time:'10:00'}},
    {confirmation:{day_offset:-4,time:'10:00'}},{creation:{day_offset:-3,time:'21:00'}}]) assert.throws(()=>save(d,validCycleSettings(patch)));
  assert.equal(save(d,validCycleSettings()).revision,1);d.close();
});
test('settings enforce admin access, coordinator capability and stable revision/request identities',()=>{
  const d=cycleFixture(),input=validCycleSettings();
  assert.throws(()=>saveCycleSettings(d,input,{actorId:2,expectedRevision:0,requestKey:'member'}),/permission|admin/i);
  assert.throws(()=>saveCycleSettings(d,input,{actorId:{kind:'device',id:1},expectedRevision:0,requestKey:'device'}));
  assert.throws(()=>saveCycleSettings(d,input,{actorId:1,expectedRevision:0}),/request/i);
  d.prepare("INSERT INTO access_capabilities VALUES('user','2','tasks.create','none')").run();
  assert.throws(()=>save(d,{...input,coordinator_id:2}),/coordinator/i);
  const result=save(d,input);
  assert.deepEqual(save(d,input),result);
  assert.throws(()=>save(d,{...input,enabled:false}),/request/i);
  assert.throws(()=>save(d,{enabled:false},0,'stale'),/revision/i);
  assert.equal(save(d,{enabled:false},1,'disable').revision,2);
  assert.deepEqual(save(d,input),result,'late retry returns original immutable result');d.close();
});
test('daily weekly fortnightly periods cover consecutive inclusive local dates',()=>{
  for(const [cadence,length] of [['daily',1],['weekly',7],['fortnightly',14]]) {
    const p=periodForStart('2026-10-05',cadence);
    assert.equal(p.start,'2026-10-05');
    assert.equal((Date.parse(p.next_start)-Date.parse(p.start))/86400000,length);
    assert.equal((Date.parse(p.end)-Date.parse(p.start))/86400000,length-1);
    assert.equal(periodForStart(p.next_start,cadence).start,p.next_start);
  }
  for(const start of ['2026-02-30','bad','2026-1-01']) assert.throws(()=>periodForStart(start,'weekly'));
  assert.throws(()=>periodForStart('2026-01-01','rolling'));
});
test('monthly periods clamp leap years and restore original anchor after short months',()=>{
  assert.deepEqual(periodForStart('2026-01-31','monthly'),{start:'2026-01-31',end:'2026-02-27',next_start:'2026-02-28'});
  assert.equal(periodForStart('2024-01-31','monthly').next_start,'2024-02-29');
  assert.equal(periodForStart('2026-02-28','monthly',{anchorDay:31}).next_start,'2026-03-31');
  const s=validCycleSettings({cadence:'monthly',first_period_start:'2026-01-31',
    creation:{day:20,month_offset:0,time:'09:00'},response:{day:25,month_offset:0,time:'09:00'},
    confirmation:{day:27,month_offset:0,time:'09:00'},shopping:{day:31,month_offset:0,time:'09:00'}});
  assert.equal(cycleInstants(s,'2026-02-28').shopping,'2026-02-28T08:00:00.000Z');
  assert.equal(cycleInstants(s,'2026-02-28').period.next_start,'2026-03-31');
  const d=cycleFixture();assert.deepEqual(save(d,s).shopping,s.shopping);
  assert.throws(()=>save(d,{shopping:{day_offset:0,time:'09:00'}},1,'monthly-offset'),/monthly/i);d.close();
});
test('Task DST policy moves a gap forward and chooses earlier fold, including half-hour transitions',()=>{
  const forTime=(start,zone,time)=>cycleInstants(validCycleSettings({timezone:zone,first_period_start:start,
    creation:{day_offset:0,time},response:{day_offset:0,time},confirmation:{day_offset:0,time},shopping:{day_offset:0,time}}),start).creation;
  assert.equal(forTime('2026-03-29','Europe/Berlin','02:30'),'2026-03-29T01:30:00.000Z');
  assert.equal(forTime('2026-10-25','Europe/Berlin','02:30'),'2026-10-25T00:30:00.000Z');
  assert.equal(forTime('2026-10-04','Australia/Lord_Howe','02:15'),'2026-10-03T15:45:00.000Z');
});
test('four timings are independent household-local instants',()=>{
  assert.deepEqual(cycleInstants(validCycleSettings(),'2026-10-05'),{period:{start:'2026-10-05',end:'2026-10-11',next_start:'2026-10-12'},
    creation:'2026-10-02T07:00:00.000Z',response:'2026-10-02T18:00:00.000Z',confirmation:'2026-10-03T18:00:00.000Z',shopping:'2026-10-04T08:00:00.000Z'});
});
test('catchup skips ended history, uses fixed calendar anchor, and handles early creation of future periods',()=>{
  const s=validCycleSettings({first_period_start:'2026-01-05'});
  assert.deepEqual(dueCyclePeriods(s,'2026-10-09T08:00:00Z').map(x=>x.period.start),['2026-10-05','2026-10-12']);
  assert.deepEqual(dueCyclePeriods(s,'2026-10-09T06:59:59Z').map(x=>x.period.start),['2026-10-05']);
  assert.deepEqual(dueCyclePeriods(s,'2026-10-12T00:00:00Z').map(x=>x.period.start),['2026-10-12']);
  assert.throws(()=>dueCyclePeriods(s,'invalid'));
});
test('schema replay retains cycle snapshots and settings edits affect only future cycles',()=>{
  const d=cycleFixture(),s=save(d,validCycleSettings()),instants=cycleInstants(s,s.first_period_start);
  d.prepare(`INSERT INTO meal_cycles(period_start,period_end,timezone,settings_json,creation_at,response_at,confirmation_at,shopping_at,finalization_mode)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(instants.period.start,instants.period.end,s.timezone,JSON.stringify(s),instants.creation,instants.response,instants.confirmation,instants.shopping,s.finalization_mode);
  const before=d.prepare('SELECT * FROM meal_cycles').get();
  save(d,{confirmation:{day_offset:-2,time:'21:00'},finalization_mode:'automatic'},1,'edit');addMealCycleSchema(d);
  assert.deepEqual(d.prepare('SELECT * FROM meal_cycles').get(),before);
  assert.equal(getCycleSettings(d).revision,2);
  assert.throws(()=>d.prepare("UPDATE meal_cycles SET settings_json='invalid'").run());
  assert.throws(()=>d.prepare("INSERT INTO meal_cycle_memberships(cycle_id,meal_id) VALUES(1,999)").run());
  d.close();
});
test('immutable finalization results, task identities and request payloads persist under replay',()=>{
  const d=cycleFixture();
  d.exec(`INSERT INTO meal_cycles(period_start,period_end,timezone,settings_json,creation_at,response_at,confirmation_at,shopping_at)
    VALUES('2026-10-05','2026-10-11','Europe/Berlin','{}','a','b','c','d');
    INSERT INTO tasks VALUES(1),(2); INSERT INTO meals VALUES(1);
    INSERT INTO meal_cycle_memberships(cycle_id,meal_id) VALUES(1,1);
    INSERT INTO meal_cycle_task_links(cycle_id,purpose,beneficiary_id,task_id) VALUES(1,'personal',2,1);
    INSERT INTO meal_cycle_results(cycle_id,kind,request_key,input_fingerprint,input_json,output_json,actor_id,reason)
      VALUES(1,'finalization','confirm','hash','{}','{}',1,'reviewed');`);
  assert.throws(()=>d.exec("INSERT INTO meal_cycle_task_links(cycle_id,purpose,beneficiary_id,task_id) VALUES(1,'personal',2,2)"));
  assert.throws(()=>d.exec("UPDATE meal_cycle_results SET reason='rewritten'"));
  assert.throws(()=>d.exec('DELETE FROM meal_cycle_results'));
  addMealCycleSchema(d);assert.equal(d.prepare('SELECT COUNT(*) AS n FROM meal_cycle_results').get().n,1);d.close();
});
test('append-only migration 10044 applies schema on fresh/replayed synthetic database',async()=>{
  process.env.LOG_LEVEL='error';
  const {ALL_MIGRATIONS}=await import('../server/db.js');
  const migration=ALL_MIGRATIONS.find(m=>m.version===10044);
  assert.ok(migration);const d=cycleFixture();migration.up(d);migration.up(d);
  assert.equal(getCycleSettings(d).enabled,false);d.close();
  const source=readFileSync(new URL('../server/db.js',import.meta.url),'utf8');
  assert.ok(source.indexOf('version: 10044,')>source.indexOf('version: 10043,'));
});
test('monthly rules preserve explicit month offsets and catchup restores clamped anchors',()=>{
  const s=validCycleSettings({cadence:'monthly',first_period_start:'2024-01-31',
    creation:{day:31,month_offset:-1,time:'09:00'},response:{day:25,month_offset:0,time:'09:00'},
    confirmation:{day:27,month_offset:0,time:'09:00'},shopping:{day:31,month_offset:0,time:'09:00'}});
  assert.equal(cycleInstants(s,'2024-02-29').creation,'2024-01-31T08:00:00.000Z');
  assert.deepEqual(dueCyclePeriods(s,'2024-02-29T12:00:00Z').map(x=>x.period),[
    {start:'2024-02-29',end:'2024-03-30',next_start:'2024-03-31'},
    {start:'2024-03-31',end:'2024-04-29',next_start:'2024-04-30'}]);
  assert.deepEqual(dueCyclePeriods({...s,first_period_start:'2026-01-31'},'2025-12-01T00:00:00Z'),[]);
});
test('settings validation failures roll back both settings and request receipts',()=>{
  const d=cycleFixture();
  d.exec("INSERT INTO access_capabilities VALUES('user','3','tasks.create','none')");
  assert.throws(()=>save(d,validCycleSettings({coordinator_id:3})),/coordinator/i);
  d.exec("INSERT INTO access_permissions VALUES('user','2','module','meals','read')");
  assert.throws(()=>save(d,validCycleSettings({coordinator_id:2})),/coordinator/i);
  d.exec("INSERT INTO access_permissions VALUES('user','2','module','shopping','none')");
  assert.throws(()=>save(d,validCycleSettings({shopping_assignee_id:2})),/assignee/i);
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM meal_cycle_settings').get().n,0);
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM meal_cycle_requests').get().n,0);
  assert.equal(save(d,validCycleSettings()).enabled,true);d.close();
});
test('first-date timing is permitted for daily meals; actual first-meal cutoff belongs to the coordinator',()=>{
  const d=cycleFixture();
  const s=validCycleSettings({cadence:'daily',creation:{day_offset:0,time:'08:00'},response:{day_offset:0,time:'10:00'},
    confirmation:{day_offset:0,time:'11:00'},shopping:{day_offset:0,time:'12:00'}});
  assert.equal(save(d,s).enabled,true);
  assert.throws(()=>save(d,{confirmation:{day_offset:1,time:'11:00'},shopping:{day_offset:1,time:'12:00'}},1,'too-late'),/first/i);d.close();
});
test('guest and housekeeping accounts cannot be coordinator or shopping assignee even with normal permissions',()=>{
  const d=cycleFixture();
  d.exec('INSERT INTO split_expense_guest_users VALUES(2);INSERT INTO housekeeping_workers VALUES(3)');
  for(const id of [2,3]) for(const field of ['coordinator_id','shopping_assignee_id'])
    assert.throws(()=>save(d,validCycleSettings({[field]:id})),/household/i);
  d.close();
});
test('correction links retain the original submitted obligation and one occurrence has one cycle owner',()=>{
  const d=cycleFixture();
  d.exec(`INSERT INTO meal_cycles(id,period_start,period_end,timezone,settings_json,creation_at,response_at,confirmation_at,shopping_at)
    VALUES(1,'2026-10-05','2026-10-11','Europe/Berlin','{}','a','b','c','d'),
    (2,'2026-10-12','2026-10-18','Europe/Berlin','{}','e','f','g','h');
    INSERT INTO meals VALUES(1);INSERT INTO tasks VALUES(1),(2);
    INSERT INTO meal_cycle_memberships VALUES(1,1);
    INSERT INTO meal_cycle_task_links(id,cycle_id,purpose,beneficiary_id,task_id,submission_revision)
      VALUES(1,1,'personal',2,1,3);
    INSERT INTO meal_cycle_task_links(cycle_id,purpose,beneficiary_id,task_id,obligation_key,supersedes_link_id)
      VALUES(1,'correction',2,2,'meal:1:revision:4',1);`);
  assert.equal(d.prepare('SELECT submission_revision FROM meal_cycle_task_links WHERE id=1').get().submission_revision,3);
  assert.throws(()=>d.exec('INSERT INTO meal_cycle_memberships VALUES(2,1)'));
  assert.throws(()=>d.exec("INSERT INTO meal_cycle_results(cycle_id,kind,request_key,input_fingerprint,input_json,output_json,actor_id,reason) VALUES(1,'finalization','x','hash','{}','invalid',1,'x')"));
  d.close();
});
