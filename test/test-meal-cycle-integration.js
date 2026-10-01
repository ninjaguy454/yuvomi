import test from 'node:test';
import assert from 'node:assert/strict';
import {weeklyFixture,ensureWeek,readWeek,seedWeekAnswers,saveWeek,submitWeek,slots,weekStart} from './meal-cycle-week-fixture.js';
import {finalizeCycle} from '../server/services/meal-cycle-finalization.js';
import {runMealCycleScheduler} from '../server/services/meal-cycle-scheduler.js';

function assertWeek(d,id) {
  const meals=readWeek(d,id).occurrences;
  assert.equal(meals.length,21);
  for(let day=0;day<7;day++)for(const slot of slots){const date=new Date(`${weekStart}T12:00:00Z`);date.setUTCDate(date.getUTCDate()+day);assert.equal(meals.filter(m=>m.date===date.toISOString().slice(0,10)&&m.meal_type===slot).length,1);}
  assert.equal(new Set(meals.map(m=>m.id)).size,21);
}
function outputs(d,id) {
  assert.equal(d.prepare("SELECT count(*) n FROM meal_cycle_results WHERE cycle_id=? AND kind='finalization'").get(id).n,1);
  const tasks=d.prepare('SELECT e.meal_id,e.role,e.task_id,t.assigned_to,m.parent_meal_id FROM meal_execution_tasks e JOIN tasks t ON t.id=e.task_id JOIN meals m ON m.id=e.meal_id ORDER BY e.task_id').all();
  assert.equal(tasks.length,22);assert.equal(new Set(tasks.map(t=>t.task_id)).size,22);
  assert.ok(tasks.every(t=>t.role==='cooking'&&t.assigned_to===(t.parent_meal_id?2:1)));
  assert.equal(tasks.filter(t=>!t.parent_meal_id).length,21);
  assert.deepEqual(d.prepare('SELECT name,quantity FROM shopping_items ORDER BY name').all(),[{name:'Week bread',quantity:'1 pcs'},{name:'Week rice packs',quantity:'62 pcs'}]);
}
test('real 21-slot week uses latest submitted personal backup, exact demand and one Task per cooking source',()=>{
  const d=weeklyFixture();try{const id=ensureWeek(d);assertWeek(d,id);const meal=seedWeekAnswers(d,id);submitWeek(d,id);
    const personal=d.prepare("SELECT task_id FROM meal_cycle_task_links WHERE cycle_id=? AND purpose='personal' AND beneficiary_id=2").get(id).task_id;
    saveWeek(d,id,2,[{meal_id:meal,kind:'decision',decision:{participation:'participating',choice_kind:'backup',confirmed:true,selected_recipe_id:902,selected_meal_title:'Week toast',menu_item_ids:[],portion_amount:0.75}}],'week-edit-after-submit');
    assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(personal).status,'done');
    const options={actorId:1,expectedRevision:readWeek(d,id).revision,requestKey:'week-confirm',now:'2034-03-04T19:00:00Z'};
    const result=finalizeCycle(d,id,options);assert.deepEqual(finalizeCycle(d,id,options),result);outputs(d,id);assertWeek(d,id);
    assert.equal(d.prepare("SELECT count(*) n FROM task_completions WHERE task_id=?").get(personal).n,1);
    assert.throws(()=>saveWeek(d,id,2,[{meal_id:meal,kind:'main',title:'Unreviewed',recipe_id:null}],'week-unreviewed'),/confirmed|adjustment/i);
  }finally{d.close();}
});
test('21-slot automatic confirmation stays empty while blocked, recovers and repeats without duplicate outputs',()=>{
  const d=weeklyFixture({mode:'automatic'});try{const id=ensureWeek(d);assertWeek(d,id);
    for(const now of ['2034-03-04T19:00:00Z','2034-03-04T19:01:00Z'])assert.equal(runMealCycleScheduler(d,{now}).blocked.length,1);
    assert.equal(d.prepare('SELECT count(*) n FROM shopping_items').get().n,0);assert.equal(d.prepare('SELECT count(*) n FROM meal_execution_tasks').get().n,0);
    assert.equal(d.prepare("SELECT count(*) n FROM meal_cycle_task_links WHERE cycle_id=? AND purpose='automatic_followup'").get(id).n,1);
    const meal=seedWeekAnswers(d,id);saveWeek(d,id,2,[{meal_id:meal,kind:'decision',decision:{participation:'participating',choice_kind:'backup',confirmed:true,selected_recipe_id:902,selected_meal_title:'Week toast',menu_item_ids:[],portion_amount:0.75}}],'auto-backup');submitWeek(d,id);
    assert.equal(runMealCycleScheduler(d,{now:'2034-03-05T08:00:00Z'}).finalized.length,1);assert.equal(runMealCycleScheduler(d,{now:'2034-03-05T08:01:00Z'}).finalized.length,0);outputs(d,id);
  }finally{d.close();}
});
