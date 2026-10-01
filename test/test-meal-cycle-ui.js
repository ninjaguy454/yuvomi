import test from 'node:test';
import assert from 'node:assert/strict';
const portions=await import('../public/utils/meal-cycle-portions.js').catch(e=>e.code==='ERR_MODULE_NOT_FOUND'?{}:Promise.reject(e));
const ui=await import('../public/utils/meal-cycle-state.js').catch(e=>e.code==='ERR_MODULE_NOT_FOUND'?{}:Promise.reject(e));
test('exact twenty portion choices, new default and legacy omission until explicit replacement',()=>{
  assert.equal(typeof portions.portionControl,'function');assert.deepEqual(portions.PORTION_VALUES,Array.from({length:20},(_,i)=>((i+1)/4).toFixed(2)));
  const html=portions.portionControl('p');assert.equal((html.match(/<option /g)||[]).length,20);assert.match(html,/value="1.00" selected/);assert.ok(!html.includes('<input'));
  assert.deepEqual(portions.portionPatch(1.1,null),{});assert.deepEqual(portions.portionPatch(undefined,null),{portion_amount:1});assert.deepEqual(portions.portionPatch(1.1,'1.25'),{portion_amount:1.25});assert.throws(()=>portions.portionPatch(1.1,'1.10'));
  assert.match(portions.portionControl('p',1.1),/1.10/);assert.equal((portions.portionControl('p',1.1).match(/<option value="[0-5]\.[0-9]{2}"/g)||[]).length,20);assert.match(portions.portionControl('p',1.1),/Choose a replacement/);
});
test('recipe-to-custom clears recipe identity and cancel preserves parent draft',()=>{
  assert.equal(typeof ui.createCycleDraft,'function');const s=ui.createCycleDraft();s.edit(1,{title:'Recipe',recipe_id:4});const nested=s.begin(1);nested.title='Toast';ui.customChoice(nested);assert.equal(nested.recipe_id,null);assert.equal(s.changes()[0].recipe_id,4);s.accept(1,nested);assert.equal(s.changes()[0].recipe_id,null);
});
test('stale async load cannot overwrite newer state; uncertain retries retain identity; duplicate clicks coalesce',async()=>{
  assert.equal(typeof ui.createCycleDraft,'function');const s=ui.createCycleDraft();const first=s.loadToken(),second=s.loadToken();assert.equal(s.acceptLoad(first,{revision:1}),false);assert.equal(s.acceptLoad(second,{revision:2}),true);
  s.edit(1,{kind:'main',title:'Rice'});let resolve,calls=0;const seen=[];const operation=p=>{calls++;seen.push(p);return new Promise(r=>resolve=r);};const a=s.run('save',operation),b=s.run('save',operation);assert.equal(calls,1);resolve({revision:3});await Promise.all([a,b]);assert.equal(s.changes().length,0);
  s.edit(1,{kind:'main',title:'Soup'});let original;await assert.rejects(s.run('save',async p=>{original=p;throw new Error('Unknown outcome');}));assert.equal(s.changes().length,1);await s.run('save',async p=>{assert.deepEqual(p,original);return {revision:4};});
});
test('return links accept only exact cycle identities and preserve beneficiary/purpose',()=>{assert.equal(typeof ui.cycleReturnPath,'function');assert.equal(ui.cycleReturnPath('?cycle_return=23&beneficiary=2'),'/meals?cycle=23&beneficiary=2&purpose=shopping');assert.equal(ui.cycleReturnPath('?cycle_return=https://evil.invalid'),null);});
test('weekly setup offers named weekdays and family rhythm without guessing times or people',async()=>{
  const settings=await import('../public/settings/pages/kitchen-cycle.js');
  assert.equal(typeof settings.familyWeeklyPreset,'function');const preset=settings.familyWeeklyPreset();assert.equal(preset.enabled,false);assert.equal(preset.creation.day_offset,-3);assert.equal(preset.response.day_offset,-3);assert.equal(preset.confirmation.day_offset,-2);assert.equal(preset.shopping.day_offset,-1);assert.equal(preset.coordinator_id,null);assert.equal(preset.creation.time,'');
  const html=settings.renderScheduleFields({...preset,first_period_start:'2034-03-06'});assert.match(html,/<select[^>]+name="creation_day_offset"/);assert.ok(!html.includes('type="number" name="creation_day_offset"'));
  const wednesday=settings.familyWeeklyPreset('2034-03-08');assert.equal(wednesday.response.day_offset,-5);assert.equal(wednesday.confirmation.day_offset,-4);assert.equal(wednesday.shopping.day_offset,-3);
  assert.match(settings.renderScheduleFields({...wednesday,cadence:'fortnightly',response:{day_offset:-12,time:'18:00'}}),/value="-12" selected/);
});
test('selected day separates shared chooser and own plate while preserving exact dropdown',async()=>{
  const page=await import('../public/pages/meal-cycle.js');const state=ui.createCycleDraft();
  const model={cycle:{period_start:'2034-03-06',period_end:'2034-03-12'},permissions:{write:true},personal:{beneficiary_id:2,requirements:[{meal_id:1,kind:'main'},{meal_id:1,kind:'decision'}]},occurrences:[{id:1,date:'2034-03-06',meal_type:'dinner',title:'Rice',menu_items:[],my_decision:{portion_amount:1.1}}]};
  const html=page.renderCycleCards(model,state);assert.equal(page.cycleDays(model.cycle).length,7);assert.equal((html.match(/class="cycle-day"/g)||[]).length,1);assert.equal((html.match(/class="cycle-slot"/g)||[]).length,3);assert.equal((html.match(/<option value="[0-5]\.[0-9]{2}"/g)||[]).length,20);assert.match(html,/data-pick-meal="1"/);assert.match(html,/data-decision/);assert.match(html,/1.10/);
  state.edit(1,{kind:'sides',operations:[{operation:'add',title:'Peas',recipe_id:null}]});assert.match(page.renderCycleCards(model,state),/name="side_add"[^>]*value="Peas"/);
});
test('cycle instants honor snapshot timezone independently of global display preference',async()=>{
  const zone=await import('../public/utils/timezone.js');zone.setDisplayTimeZone('America/Los_Angeles');
  assert.equal(typeof ui.cycleWallTime,'function');assert.equal(ui.cycleWallTime('2034-03-03T23:30:00Z','Europe/Berlin'),'2034-03-04T00:30:00');assert.equal(zone.displayTimeZone(),'America/Los_Angeles');zone.setDisplayTimeZone(null);
});

test('member day view is bounded while day identities cover the whole cycle',async()=>{
  const page=await import('../public/pages/meal-cycle.js'),state=ui.createCycleDraft();
  const model={cycle:{period_start:'2034-03-06',period_end:'2034-03-12'},permissions:{write:true},personal:{beneficiary_id:2,requirements:[]},occurrences:[]};
  state.forms.selectedDay='2034-03-08';const html=page.renderCycleCards(model,state);assert.equal((html.match(/class="cycle-day"/g)||[]).length,1);assert.equal((html.match(/class="cycle-slot"/g)||[]).length,3);assert.equal(page.cycleDays(model.cycle).length,7);
});
