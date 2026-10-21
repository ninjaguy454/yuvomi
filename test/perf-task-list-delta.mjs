import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';
import {_setTestDatabase} from '../server/db.js';

test('synthetic authorized Task delta versus full HTTP read',{timeout:600000},async t=>{
  const f=await scoringFixture(t),count=Number(process.env.PERF_COUNT||250);
  const samples=Number(process.env.PERF_SAMPLES||30);
  assert.ok(count>=1&&count<=400&&samples>=1&&samples<=100);
  let target;
  f.d.transaction(()=>{for(let i=0;i<count;i++){
    const id=Number(f.d.prepare("INSERT INTO tasks(title,created_by,assigned_to,due_date,points) VALUES('Synthetic task',1,2,'2026-11-01',0)").run().lastInsertRowid);
    f.d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,2)').run(id);
    target??=id;
  }})();
  const base=f.d.prepare.bind(f.d),counts={prepare:0,get:0,all:0,run:0};
  const profiled=new Proxy(f.d,{get(database,key){
    if(key==='prepare')return sql=>{counts.prepare++;const statement=base(sql);
      return new Proxy(statement,{get(entry,operation){
        if(['get','all','run'].includes(operation))return (...args)=>{counts[operation]++;return entry[operation](...args);};
        const value=entry[operation];return typeof value==='function'?value.bind(entry):value;
      }});};
    const value=database[key];return typeof value==='function'?value.bind(database):value;
  }});
  _setTestDatabase(profiled);
  async function read(path){
    const before=f.changes(),start=performance.now(),answer=await f.call('GET',path),ms=performance.now()-start;
    assert.equal(answer.status,200,JSON.stringify(answer).slice(0,300));
    assert.equal(f.changes(),before,'GET must not write');return {answer,ms};
  }
  const first=await read('/tasks');assert.equal(first.answer.data.length,count);
  let cursor=first.answer.delta_cursor;
  const delta=[],full=[],edit=[],editChanges=[],deltaStatements=[],fullStatements=[];
  for(let i=0;i<samples;i++){
    const editBefore=f.changes(),start=performance.now(),saved=await f.edit(target,{title:`Synthetic edit ${i}`});
    edit.push(performance.now()-start);
    editChanges.push(f.changes()-editBefore);
    assert.equal(saved.status,200,JSON.stringify(saved).slice(0,300));
    const prior={...counts},result=await read(`/tasks?delta=${encodeURIComponent(cursor)}`);
    assert.equal(result.answer.reset_required,false,JSON.stringify(result.answer).slice(0,300));
    assert.deepEqual(result.answer.data.map(row=>row.id),[target]);
    delta.push(result.ms);
    deltaStatements.push(Object.fromEntries(Object.keys(counts).map(key=>[key,counts[key]-prior[key]])));
    const priorFull={...counts},ordinary=await read('/tasks');assert.equal(ordinary.answer.data.length,count);
    fullStatements.push(Object.fromEntries(Object.keys(counts).map(key=>[key,counts[key]-priorFull[key]])));
    full.push(ordinary.ms);cursor=ordinary.answer.delta_cursor;
  }
  console.log('TASK_DELTA_PERF '+JSON.stringify({count,samples,delta,full,edit,editChanges,deltaStatements,fullStatements}));
});
