// Synthetic weekly fixture. No production household data or scheduler startup.
import {Database,schema,cycles,saveCycleSettings} from './meal-cycle-finalization-fixture.js';
import {createMealPlan} from '../server/services/meal-plans.js';

export const weekStart='2034-03-06';
export const slots=['breakfast','lunch','dinner'];
export function weekSettings(mode='manual') {
  return {enabled:true,timezone:'Europe/Berlin',cadence:'weekly',first_period_start:weekStart,
    creation:{day_offset:-3,time:'09:00'},response:{day_offset:-3,time:'20:00'},
    confirmation:{day_offset:-2,time:'20:00'},shopping:{day_offset:-1,time:'10:00'},
    coordinator_id:1,shopping_assignee_id:1,shopping_list_id:1,finalization_mode:mode};
}
export function weeklyFixture({settings=true,mode='manual',passwordHash='x'}={}) {
  const d=new Database(schema);d.pragma('foreign_keys=ON');
  // Auth creates this runtime table outside migrations. Replacing the fixture
  // DB after the auth Store constructor must preserve its canonical schema.
  d.exec('CREATE TABLE IF NOT EXISTS sessions(sid TEXT PRIMARY KEY,sess TEXT NOT NULL,expired_at INTEGER NOT NULL)');
  for(const [id,name,role] of [[1,'Week Coordinator','admin'],[2,'Week Member','member'],[3,'Week Diner','member']]) {
    d.prepare('INSERT INTO users(id,username,display_name,first_name,password_hash,role,family_role,onboarding_version) VALUES(?,?,?,?,?,?,?,999)').run(id,name,name,name,passwordHash,role,id===2?'child':'parent');
    d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source) SELECT ?,id,'normal','manual' FROM skills WHERE system_key IS NOT NULL").run(id);
  }
  d.exec("INSERT INTO shopping_lists(id,name,created_by) VALUES(1,'Week groceries',1); INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','Europe/Berlin'); INSERT INTO recipes(id,title,meal_types,created_by,yield_portions) VALUES(901,'Week rice','breakfast,lunch,dinner',1,1),(902,'Week toast','breakfast,lunch,dinner',1,1); INSERT INTO recipe_ingredients(recipe_id,name,quantity,category) VALUES(901,'Week rice packs','1 pcs','Other'),(902,'Week bread','1 pcs','Other'); UPDATE meal_execution_settings SET enabled=1,generate_preparation=0,generate_cooking=1,generate_supervision=0,generate_serving=0,generate_cleanup=0");
  createMealPlan(d,{name:'All seven days, three meals',rules:slots.map((meal_type,i)=>({weekdays:[0,1,2,3,4,5,6],meal_type,policy:'fixed',fixed_user_id:2,participant_ids:[1,2,3],preferred_time:['08:00','12:00','18:00'][i],cook_strategy:'fixed',cook_user_id:1,supervisor_strategy:'none',generate_preparation:false,generate_cooking:true,generate_supervision:false,generate_serving:false,generate_cleanup:false}))},1);
  if(settings)saveCycleSettings(d,weekSettings(mode),{actorId:1,expectedRevision:0,requestKey:'week-settings'});
  return d;
}
export function ensureWeek(d) {return cycles.ensureCycle(d,{start:weekStart,actorId:1,expectedSettingsRevision:1,requestKey:'week-ensure'}).cycle_id;}
export const readWeek=(d,id,person=1)=>cycles.reviewCycle(d,id,{actorId:person});
export function saveWeek(d,id,person,changes,key) {return cycles.saveCyclePerson(d,id,{actorId:person,expectedRevision:readWeek(d,id,person).revision,requestKey:key,changes});}
export function seedWeekAnswers(d,id,{skipRepresentative=false}={}) {
  const meals=readWeek(d,id).occurrences,representative=meals.find(m=>m.date===weekStart&&m.meal_type==='dinner');
  saveWeek(d,id,2,meals.filter(m=>!skipRepresentative||m.id!==representative.id).map(m=>({meal_id:m.id,kind:'main',title:'Week rice',recipe_id:901})),'week-mains');
  for(const person of [1,2,3])saveWeek(d,id,person,meals.filter(m=>!skipRepresentative||m.id!==representative.id).map(m=>({meal_id:m.id,kind:'decision',decision:{participation:'participating',choice_kind:'household',confirmed:true,select_shared_main:true,portion_amount:1}})),`week-answers-${person}`);
  return representative.id;
}
export function submitWeek(d,id,people=[1,2,3]) {
  cycles.registerMealCycleTaskLifecycle();
  for(const person of people)cycles.submitCyclePerson(d,id,{actorId:person,expectedRevision:readWeek(d,id,person).revision,requestKey:`week-submit-${person}`});
}
