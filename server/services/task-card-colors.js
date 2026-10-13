import {normalizeCardColorSlot,normalizeCardColorChoice,validateCardColorChoice,resolveCardColorChoice,NEUTRAL_CARD_DEFAULT} from '../../public/utils/card-colors.js';
const parse=v=>{try{return JSON.parse(v);}catch{return null;}};
export function householdCardColorDefault(d){const value=normalizeCardColorChoice(parse(d.prepare("SELECT value FROM sync_config WHERE key='task_card_color_default'").get()?.value));return value&&value.mode!=='default'?value:{...NEUTRAL_CARD_DEFAULT};}
export function taskCardColorPolicy(row){return normalizeCardColorChoice(parse(row?.card_color_choice))||(normalizeCardColorSlot(row?.card_color)?{version:1,mode:'fixed',slot:row.card_color}:null);}
/** Only runtime producers call this, inside their own creation transaction. */
export function assignNewTaskCardColor(d,id,options={}){
  const row=d.prepare('SELECT card_color,card_color_choice FROM tasks WHERE id=?').get(id);if(!row)throw new Error('New Task missing.');
  if(row.card_color_choice!=null)return normalizeCardColorSlot(row.card_color);
  let choice,slot;
  if(options.inheritFrom!=null){const source=d.prepare('SELECT card_color FROM tasks WHERE id=?').get(options.inheritFrom);slot=normalizeCardColorSlot(source?.card_color);choice=slot?{version:1,mode:'fixed',slot}:null;}
  else if(Object.hasOwn(options,'legacySlot')){slot=normalizeCardColorSlot(options.legacySlot);choice=slot?{version:1,mode:'fixed',slot}:null;}
  else{choice=validateCardColorChoice(options.choice||{version:1,mode:'default'});slot=resolveCardColorChoice(choice,householdCardColorDefault(d),options.draw);}
  d.prepare('UPDATE tasks SET card_color=?,card_color_choice=? WHERE id=?').run(slot,choice?JSON.stringify(choice):null,id);return slot;
}
export function setTaskCardColor(d,id,choice){choice=validateCardColorChoice(choice);const slot=resolveCardColorChoice(choice,householdCardColorDefault(d));d.prepare('UPDATE tasks SET card_color=?,card_color_choice=? WHERE id=?').run(slot,JSON.stringify(choice),id);return slot;}
/** Freeze old definitions before a one-off override changes their source row. */
export function freezeSeriesCardColorPolicy(d,taskId){
  const occurrence=d.prepare('SELECT series_id FROM task_recurrence_occurrences WHERE task_id=?').get(taskId);if(!occurrence)return;
  for(const row of d.prepare('SELECT id,source_task_id,definition_json FROM task_recurrence_definitions WHERE series_id=?').all(occurrence.series_id)){
    const definition=JSON.parse(row.definition_json);if(Object.hasOwn(definition.task,'card_color_policy'))continue;
    definition.task.card_color_policy=taskCardColorPolicy(d.prepare('SELECT * FROM tasks WHERE id=?').get(row.source_task_id));
    for(const action of definition.subtasks||[])if(!Object.hasOwn(action.task,'card_color_policy'))action.task.card_color_policy=taskCardColorPolicy(d.prepare('SELECT * FROM tasks WHERE id=?').get(action.source_task_id));
    d.prepare('UPDATE task_recurrence_definitions SET definition_json=? WHERE id=?').run(JSON.stringify(definition),row.id);
  }
}
