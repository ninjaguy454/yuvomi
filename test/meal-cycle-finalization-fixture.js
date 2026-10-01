import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS}=await import('../server/db.js');
const {saveCycleSettings}=await import('../server/services/meal-cycle-settings.js');
const plans=await import('../server/services/meal-plans.js');
// Dynamic import permits a useful assertion when the new service is absent.
const cycles=await import('../server/services/meal-cycles.js').catch(e=>e.code==='ERR_MODULE_NOT_FOUND'?{}:Promise.reject(e));

const template=new Database(':memory:');
for(const migration of ALL_MIGRATIONS) {
  if(typeof migration.up==='function')migration.up(template);else template.exec(migration.up);
  migration.afterUp?.(template);
}
const schema=template.serialize();template.close();
function fixture(overrides={},ruleOptions={}) {
  const d=new Database(schema);d.pragma('foreign_keys=ON');
  for(let i=1;i<=3;i++)d.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role) VALUES(?,?,?,'x',?,'parent')").run(i,`cycle${i}`,`Person ${i}`,i===1?'admin':'member');
  d.exec("INSERT INTO shopping_lists(id,name,created_by) VALUES(1,'Home',1); INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','Europe/Berlin')");
  for(let i=1;i<=3;i++)d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) SELECT ?,id,'normal','manual',1 FROM skills WHERE system_key IS NOT NULL").run(i);
  saveCycleSettings(d,{enabled:true,timezone:'Europe/Berlin',cadence:'weekly',first_period_start:'2034-03-06',creation:{day_offset:-3,time:'09:00'},response:{day_offset:-3,time:'20:00'},confirmation:{day_offset:-2,time:'20:00'},shopping:{day_offset:-1,time:'10:00'},coordinator_id:1,shopping_assignee_id:1,shopping_list_id:1,finalization_mode:'manual',...overrides},{actorId:1,expectedRevision:0,requestKey:'settings'});
  plans.createMealPlan(d,{name:'Dinners',rules:[{weekday:0,meal_type:'dinner',policy:'fixed',fixed_user_id:2,participant_ids:[1,2,3],preferred_time:'18:00',max_side_choices:2,...ruleOptions}]},1);
  return d;
}
function ensure(d,extra={}) {assert.equal(typeof cycles.ensureCycle,'function','ensureCycle service must exist');return cycles.ensureCycle(d,{start:'2034-03-06',actorId:1,requestKey:'ensure',expectedSettingsRevision:1,...extra});}
const review=(d,id,person=2)=>cycles.reviewCycle(d,id,{actorId:person,beneficiaryId:person});
const save=(d,id,changes,key='save',person=2,extra={})=>cycles.saveCyclePerson(d,id,{actorId:person,beneficiaryId:person,expectedRevision:review(d,id,person).revision,requestKey:key,changes,...extra});
function main(d,id,title='Pasta',key='main') {const m=review(d,id).occurrences[0];return save(d,id,[{meal_id:m.id,kind:'main',title,recipe_id:null}],key);}
function decision(d,id,person=2,patch={},key=`decision-${person}`) {
  const m=review(d,id,person).occurrences[0];
  return save(d,id,[{meal_id:m.id,kind:'decision',decision:{participation:'participating',choice_kind:'household',confirmed:true,menu_item_ids:m.menu_items.filter(x=>x.item_type==='entree').map(x=>x.id),...patch}}],key,person);
}

function submitAll(d,id) {cycles.registerMealCycleTaskLifecycle();for(const link of review(d,id,1).tasks.filter(x=>x.purpose==='personal'))cycles.submitCyclePerson(d,id,{actorId:link.beneficiary_id,expectedRevision:review(d,id,link.beneficiary_id).revision,requestKey:`submit-${link.beneficiary_id}`});}
export {submitAll,fixture,ensure,review,save,main,decision,cycles,Database,schema,saveCycleSettings};
