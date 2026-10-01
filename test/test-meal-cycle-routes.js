import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {fixture,ensure,main} from './meal-cycle-finalization-fixture.js';
import {_setTestDatabase} from '../server/db.js';
import {moduleForPath} from '../server/scopes.js';
import {csrfMiddleware} from '../server/middleware/csrf.js';
import {review,save,decision,submitAll,cycles} from './meal-cycle-finalization-fixture.js';
import {finalizeCycle,acknowledgeCycleGaps,reviewCycleReadiness} from '../server/services/meal-cycle-finalization.js';
import {proposeCycleAdjustment,applyCycleAdjustment} from '../server/services/meal-cycle-adjustments.js';
import {saveCycleSettings} from '../server/services/meal-cycle-settings.js';
import {kitchenPaths} from '../server/openapi/paths/kitchen.js';
const transport=await import('../server/routes/meal-cycles.js').catch(e=>e.code==='ERR_MODULE_NOT_FOUND'?{}:Promise.reject(e));
async function harness(run){
  assert.equal(typeof transport.default,'function','Kitchen cycle router exists');
  const d=fixture(),c=ensure(d);_setTestDatabase(d);
  const principal={authUserId:1,authRole:'admin',authScopes:null,sessionModuleAccess:null,authMethod:'api_token'};
  const app=express();app.use(express.json());app.use((req,res,next)=>{Object.assign(req,principal);req.session={};next();});app.use(csrfMiddleware);app.use(transport.default);
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const call=async(path,body,method=body?'POST':'GET')=>{const r=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,...await r.json()};};
  try{await run({d,c,principal,call});}finally{await new Promise(r=>server.close(r));d.close();}
}
test('only Kitchen cycles map to Meals scopes',()=>{assert.equal(moduleForPath('/kitchen/cycles/settings'),'meals');assert.equal(moduleForPath('/kitchen/summary'),null);});
test('cycle read and settings preview are pure and preview matches dates',()=>harness(async({d,c,call})=>{
  const before=d.prepare('SELECT total_changes() n').get().n;
  const r=await call(`/${c.cycle_id}`);assert.equal(r.status,200);assert.equal(r.data.cycle.id,c.cycle_id);assert.ok(r.data.permissions.review);
  const p=await call('/preview',{settings:{}});assert.equal(p.status,200);assert.equal(p.data.schedule.period.start,'2034-03-06');
  assert.equal(d.prepare('SELECT total_changes() n').get().n,before);
}));
test('current principal denies anonymous, paired, guest, denied module and IDOR',()=>harness(async({c,principal,call})=>{
  principal.authUserId=null;assert.equal((await call(`/${c.cycle_id}`)).status,401);
  principal.authUserId=1;principal.devicePrincipal={id:1};assert.equal((await call(`/${c.cycle_id}`)).status,403);delete principal.devicePrincipal;
  principal.authUserId=2;principal.authRole='member';assert.equal((await call(`/${c.cycle_id}?beneficiary_id=3`)).status,403);
  principal.sessionModuleAccess={meals:'none'};assert.equal((await call(`/${c.cycle_id}`)).status,403);principal.sessionModuleAccess=null;
  assert.equal((await call('/wat')).status,400);assert.equal((await call('/0')).status,400);
}));
test('Meals-only token has personal data but no downstream or raw household objects',()=>harness(async({c,principal,call})=>{
  principal.authUserId=2;principal.authRole='member';principal.authScopes=['meals:read'];
  const r=await call(`/${c.cycle_id}`);assert.equal(r.status,200);assert.equal(r.data.permissions.review,false);assert.deepEqual(r.data.tasks,[]);assert.equal(r.data.personal.task_id,null);assert.deepEqual(r.data.destinations,[]);
  assert.equal(r.data.personal.submitted,null);assert.equal(r.data.personal.submission_revision,null);assert.equal(r.data.personal.needs_correction,null);assert.ok(!('settings_json' in r.data.cycle));assert.ok(!('settings' in r.data));assert.ok(r.data.occurrences.every(m=>!('decisions' in m)));
  assert.equal((await call(`/${c.cycle_id}/submit`,{expected_revision:1,request_key:'denied'})).status,403);
}));
test('coordinator read survives lost write capability; downstream mutation scopes remain required',()=>harness(async({d,c,principal,call})=>{
  principal.authScopes=['meals:read'];let r=await call(`/${c.cycle_id}`);assert.equal(r.status,200);assert.equal(r.data.permissions.review,true);assert.deepEqual(r.data.tasks,[]);assert.deepEqual(r.data.destinations,[]);assert.ok(!JSON.stringify(r.data).includes('shopping_list_id'));
  principal.authScopes=['meals:write'];assert.equal((await call(`/${c.cycle_id}/confirm`,{expected_revision:1,request_key:'no-task-scope'})).status,403);
  principal.authScopes=['meals:write','tasks:write'];assert.equal((await call(`/${c.cycle_id}/confirm`,{expected_revision:1,request_key:'no-shop-scope'})).status,403);
  principal.authScopes=null;d.exec("INSERT INTO access_permissions(subject_type,subject_id,resource_type,resource_key,access) VALUES('user','1','module','tasks','read')");
  r=await call(`/${c.cycle_id}`);assert.equal(r.status,200);assert.ok(r.data.blockers.length);
  principal.sessionModuleAccess={tasks:'read'};assert.equal((await call('/settings',{expected_revision:1,request_key:'pause-with-lost-tasks',settings:{enabled:false}},'PUT')).status,200);
}));
test('save binds revision/key and refuses scheduler authority; submission cannot bypass CSRF',()=>harness(async({c,principal,call})=>{
  principal.authUserId=2;principal.authRole='member';const change={meal_id:c.occurrences[0].id,kind:'main',title:'Rice',recipe_id:null};
  let r=await call(`/${c.cycle_id}/save`,{expected_revision:1,request_key:'save',changes:[change]});assert.equal(r.status,200);const revision=r.data.revision;
  r=await call(`/${c.cycle_id}/save`,{expected_revision:1,request_key:'save',changes:[change]});assert.equal(r.status,200);assert.equal(r.data.revision,revision);
  assert.equal((await call(`/${c.cycle_id}/save`,{expected_revision:1,request_key:'new',changes:[change]})).status,409);
  assert.equal((await call(`/${c.cycle_id}/save`,{expected_revision:1,request_key:'save',changes:[]})).status,409);
  assert.equal((await call(`/${c.cycle_id}/confirm`,{expected_revision:revision,request_key:'forge',trigger:'automatic',actorId:1})).status,400);
  principal.authMethod='session';assert.equal((await call(`/${c.cycle_id}/submit`,{expected_revision:revision,request_key:'csrf'})).status,403);
}));
test('ordered shared main and family response resolve current identity in the same save',()=>{
  const d=fixture(),id=ensure(d).cycle_id,m=review(d,id).occurrences[0].id;
  const r=save(d,id,[{meal_id:m,kind:'main',title:'New rice',recipe_id:null},{meal_id:m,kind:'decision',decision:{participation:'participating',choice_kind:'household',confirmed:true,select_shared_main:true}}]);
  assert.equal(r.occurrences[0].my_decision.is_current_choice,true);assert.ok(r.personal.requirements.every(x=>x.complete));d.close();
});
test('explicit existing side selection follows ordered main replacement without choosing a historical different side',()=>{
  const d=fixture(),id=ensure(d).cycle_id,m=review(d,id).occurrences[0].id;main(d,id);save(d,id,[{meal_id:m,kind:'sides',operations:[{operation:'add',title:'Peas',recipe_id:null}]}],'add');const side=review(d,id).occurrences[0].menu_items.find(x=>x.item_type==='side');
  save(d,id,[{meal_id:m,kind:'main',title:'Rice',recipe_id:null},{meal_id:m,kind:'decision',decision:{participation:'participating',choice_kind:'household',confirmed:true,select_shared_main:true,select_side_ids:[side.id]}}],'ordered-side');assert.ok(review(d,id).occurrences[0].my_decision.menu_items.some(x=>x.item_type==='side'&&x.title==='Peas'));d.close();
});
test('cycle sides use chooser authority, selected history guard, stable retry and no main mutation',()=>{
  const d=fixture(),id=ensure(d).cycle_id,m=review(d,id).occurrences[0].id;main(d,id);
  const changes=[{meal_id:m,kind:'sides',operations:[{operation:'add',title:'Peas',recipe_id:null}]}];
  const options={actorId:2,expectedRevision:review(d,id).revision,requestKey:'side-add',changes};
  cycles.saveCyclePerson(d,id,options);cycles.saveCyclePerson(d,id,options);let r=review(d,id);const side=r.occurrences[0].menu_items.find(x=>x.item_type==='side');assert.ok(side);assert.equal(r.occurrences[0].title,'Pasta');
  assert.throws(()=>cycles.saveCyclePerson(d,id,{...options,requestKey:'stale-side'}),/revision|changed|stale/i);assert.throws(()=>cycles.saveCyclePerson(d,id,{...options,actorId:3,beneficiaryId:2,requestKey:'other-beneficiary',expectedRevision:r.revision}),/permission|own|another|administrator/i);
  assert.throws(()=>save(d,id,changes,'steal',3),/chooser|permission|allowed/i);
  save(d,id,[{meal_id:m,kind:'sides',operations:[{operation:'edit',id:side.id,title:'Beans',recipe_id:null}]}],'edit');
  const currentSide=review(d,id).occurrences[0].menu_items.find(x=>x.title==='Beans');
  decision(d,id,2,{menu_item_ids:[...review(d,id).occurrences[0].menu_items.filter(x=>x.item_type==='entree').map(x=>x.id),currentSide.id]});
  const historical=d.prepare('SELECT * FROM meal_menu_items WHERE id=?').get(currentSide.id);
  save(d,id,[{meal_id:m,kind:'sides',operations:[{operation:'remove',id:currentSide.id}]}],'remove-selected');
  assert.deepEqual(d.prepare('SELECT * FROM meal_menu_items WHERE id=?').get(currentSide.id),historical);
  save(d,id,[{meal_id:m,kind:'sides',operations:[{operation:'add',title:'Carrots',recipe_id:null}]}],'another');r=review(d,id);const extra=r.occurrences[0].menu_items.find(x=>x.title==='Carrots');
  save(d,id,[{meal_id:m,kind:'sides',operations:[{operation:'remove',id:extra.id}]}],'remove');assert.ok(!review(d,id).occurrences[0].menu_items.some(x=>x.id===extra.id));d.close();
});
test('adjustment ordered main selector retains only own valid sides and leaves other diners/history intact',()=>{
  const d=fixture(),id=ensure(d).cycle_id,m=review(d,id).occurrences[0].id;main(d,id);
  save(d,id,[{meal_id:m,kind:'sides',operations:[{operation:'add',title:'Peas',recipe_id:null}]}],'side');
  const items=review(d,id).occurrences[0].menu_items,side=items.find(x=>x.item_type==='side');
  for(const person of [1,2,3])decision(d,id,person,person===2?{menu_item_ids:items.map(x=>x.id)}:{choice_kind:'backup',selected_meal_title:'Soup',menu_item_ids:[]});
  submitAll(d,id);acknowledgeCycleGaps(d,id,{actorId:1,expectedRevision:review(d,id).revision,requestKey:'gaps',mealIds:reviewCycleReadiness(d,id,{actorId:1}).gaps.map(g=>g.meal_id)});finalizeCycle(d,id,{actorId:1,expectedRevision:review(d,id).revision,requestKey:'final'});
  assert.throws(()=>save(d,id,[{meal_id:m,kind:'sides',operations:[{operation:'add',title:'Bypass',recipe_id:null}]}],'finalized-side'),/confirmed|finalized|adjustment/i);
  const other=d.prepare('SELECT * FROM meal_person_decisions WHERE beneficiary_user_id=3').get();const history=d.prepare('SELECT * FROM task_completions ORDER BY id').all();
  let p=proposeCycleAdjustment(d,id,{actorId:2,expectedRevision:review(d,id).revision,requestKey:'new-main',changes:[{meal_id:m,kind:'main',title:'Rice instead',recipe_id:null},{meal_id:m,kind:'decision',decision:{participation:'participating',choice_kind:'household',confirmed:true,select_shared_main:true}}]});
  p=proposeCycleAdjustment(d,id,{actorId:1,expectedRevision:review(d,id).revision,requestKey:'ack-new',baseProposalId:p.proposal_id,changes:[],acknowledgeMealIds:[m]});
  applyCycleAdjustment(d,id,{actorId:1,expectedRevision:review(d,id).revision,requestKey:'apply',proposalId:p.proposal_id});
  assert.ok(review(d,id).occurrences[0].my_decision.menu_items.some(x=>x.title===side.title&&x.item_type==='side'));assert.ok(d.prepare('SELECT 1 FROM meal_menu_items WHERE id=?').get(side.id));assert.deepEqual(d.prepare('SELECT * FROM meal_person_decisions WHERE beneficiary_user_id=3').get(),other);assert.deepEqual(d.prepare('SELECT * FROM task_completions ORDER BY id').all(),history);d.close();
});
test('shopper must be able to open the Meals landing; all aliases are explicitly documented',()=>{
  const d=fixture();d.exec("INSERT INTO access_permissions(subject_type,subject_id,resource_type,resource_key,access) VALUES('user','3','module','meals','none')");assert.throws(()=>saveCycleSettings(d,{shopping_assignee_id:3},{actorId:1,expectedRevision:1,requestKey:'bad-shopper'}),/Kitchen read/);d.close();
  const paths=kitchenPaths(),canonical=Object.keys(paths).filter(p=>p.startsWith('/api/v1/kitchen/cycles'));assert.equal(canonical.length,17);for(const path of canonical){const alias=path.replace('/kitchen/','/meals/');assert.ok(paths[alias]);for(const method of Object.keys(paths[path]))assert.notEqual(paths[path][method].operationId,paths[alias][method].operationId);}
});
test('every authorized pending proposal remains discoverable; member and read-only token projections are bounded',()=>harness(async({d,c,principal,call})=>{
  const id=c.cycle_id,m=c.occurrences[0].id;main(d,id);for(const person of [1,2,3])decision(d,id,person);submitAll(d,id);acknowledgeCycleGaps(d,id,{actorId:1,expectedRevision:review(d,id).revision,requestKey:'ack',mealIds:[m]});finalizeCycle(d,id,{actorId:1,expectedRevision:review(d,id).revision,requestKey:'final'});
  const proposals=[];for(const person of [2,3])proposals.push(proposeCycleAdjustment(d,id,{actorId:person,expectedRevision:review(d,id).revision,requestKey:`p-${person}`,changes:[{meal_id:m,kind:'decision',decision:{participation:'not_participating',confirmed:true}}]}));
  let r=await call(`/${id}`);assert.equal(r.data.adjustments.length,2);
  principal.authUserId=2;principal.authRole='member';principal.authScopes=['meals:read'];const before=d.prepare('SELECT total_changes() n').get().n;
  r=await call(`/${id}/adjustments/${proposals[0].proposal_id}`);assert.equal(r.status,200);assert.ok(!('baseline' in r.data));assert.ok(!('desired' in r.data));assert.ok(!('executions' in r.data));assert.ok(r.data.occurrences.every(x=>!('decisions' in x)));assert.equal(d.prepare('SELECT total_changes() n').get().n,before);
  assert.equal((await call(`/${id}/adjustments/${proposals[1].proposal_id}`)).status,403);
  r=await call(`/${id}`);assert.equal(r.data.adjustments.length,1);assert.ok(!JSON.stringify(r.data).includes('shopping_list_id'));
}));
