import {esc} from '/utils/html.js';
import {memberLabel} from '/utils/member-label.js';

export const TRIP_STEPS=[
 ['pack-clothing','before_departure','Pack clothing'],['pack-medications','before_departure','Pack medications'],
 ['charge-devices','before_departure','Charge devices'],['load-vehicle','departure','Load the vehicle'],
 ['lock-house','departure','Lock up and set the thermostat'],['check-in','during_trip','Check in'],
 ['review-itinerary','during_trip',"Review today's itinerary"],['prepare-next-day','during_trip','Prepare for the next day'],
 ['pack-lodging','before_return','Pack the lodging'],['check-forgotten-items','before_return','Check for forgotten items'],
 ['unpack','post_trip','Unpack'],['travel-laundry','post_trip','Start travel laundry'],
].map(([step_key,phase,title])=>({step_key,phase,title}));
export const TRIP_PHASES=[['before_departure','Before departure'],['departure','Departure'],['during_trip','During trip'],['before_return','Before return'],['return_home','Return home'],['post_trip','After the trip']];
const offsets={before_departure:-1440,departure:0,during_trip:60,before_return:-240,return_home:0,post_trip:720};
const h=value=>esc(String(value??''));
const boundRows=new WeakSet();

export function tripStepRow(recipe,members,{selected=false,history=false,custom=false}={}){
 const ids=recipe.assigned_user_ids||[];
 const reminderOptions=[['','No automatic reminder'],['0','At deadline'],['60','1 hour before'],['1440','1 day before']];
 if(recipe.reminder_offset_minutes!=null&&!reminderOptions.some(([v])=>v===String(recipe.reminder_offset_minutes)))
  reminderOptions.push([String(recipe.reminder_offset_minutes),`${recipe.reminder_offset_minutes} minutes before`]);
 const choice=(name,label,input)=>`<label class="trip-step-field"><span>${label}</span>${input}</label>`;
 return `<section class="trip-step" data-trip-step="${h(recipe.step_key)}" ${history?'data-history="1"':''}>
  <div class="trip-step__header"><label class="automation-check-row"><input type="checkbox" data-step-enabled ${selected?'checked':''} ${history?'disabled':''}><span>${h(recipe.title)}${history?' · Completed':''}</span></label>
   ${custom&&!history?'<button type="button" class="btn btn--ghost" data-remove-trip-step>Remove</button>':''}</div>
  ${history?`<p class="form-hint">Completed work and its saved deadline are retained. <a href="/tasks?open=${Number(recipe.task_id)}">View Task</a></p>`:
  `<details ${selected?'open':''}><summary>Owner, deadline and reminder</summary><div class="trip-step__fields">
   ${choice('title','Step name',`<input class="input" data-step-title maxlength="200" value="${h(recipe.title)}">`)}
   ${choice('phase','Phase',`<select class="input" data-step-phase>${TRIP_PHASES.map(([value,label])=>`<option value="${value}" ${recipe.phase===value?'selected':''}>${label}</option>`).join('')}</select>`)}
   ${choice('owner','Responsible person',`<select class="input" data-step-owners multiple size="2" aria-label="Responsible people for ${h(recipe.title)}">${members.map(m=>`<option value="${m.id}" ${ids.includes(Number(m.id))?'selected':''}>${h(memberLabel(m))}</option>`).join('')}</select>`)}
   ${choice('mode','Deadline',`<select class="input" data-step-mode><option value="phase" ${recipe.due_mode!=='fixed'?'selected':''}>Follow trip phase</option><option value="fixed" ${recipe.due_mode==='fixed'?'selected':''}>Fixed date</option></select>`)}
   ${choice('date','Fixed date',`<input class="input" type="date" data-step-date value="${h(recipe.due_date||'')}">`)}
   ${choice('time','Due time (optional)',`<input class="input" type="time" data-step-time value="${h(recipe.due_time||'')}">`)}
   ${choice('offset','Minutes before (−) or after (+) departure/return',`<input class="input" type="number" data-step-offset min="-525600" max="525600" value="${h(recipe.offset_minutes??offsets[recipe.phase])}">`)}
   ${choice('reminder','Remind responsible people',`<select class="input" data-step-reminder>${reminderOptions.map(([v,label])=>`<option value="${v}" ${String(recipe.reminder_offset_minutes??'')===v?'selected':''}>${label}</option>`).join('')}</select>`)}
   <label class="automation-check-row"><input type="checkbox" data-step-optional ${recipe.is_optional?'checked':''}>Optional subtask</label>
   ${recipe.task_id?`<a href="/tasks?open=${Number(recipe.task_id)}">Open Task details</a>`:''}
  </div><p class="form-hint">Before departure uses departure; return phases use return. Changing phase restores its default offset. With no owner selected, the coordinator is responsible. Each step runs once.</p></details>`}
 </section>`;
}

export function bindTripStepRows(host){
 for(const row of host.querySelectorAll('[data-trip-step]')){
  if(boundRows.has(row))continue;boundRows.add(row);
  const update=()=>{
   const enabled=row.querySelector('[data-step-enabled]').checked;
   if(row.querySelector('details'))row.querySelector('details').hidden=!enabled;
   const fixed=row.querySelector('[data-step-mode]')?.value==='fixed';
   for(const control of row.querySelectorAll('details input,details select'))control.disabled=!enabled;
   const date=row.querySelector('[data-step-date]'),offset=row.querySelector('[data-step-offset]');
   if(date){date.disabled=!enabled||!fixed;date.required=enabled&&fixed;}
   if(offset)offset.disabled=!enabled||fixed;
  };
  row.querySelector('[data-step-enabled]')?.addEventListener('change',()=>{row.querySelector('details')?.toggleAttribute('open',row.querySelector('[data-step-enabled]').checked);update();});
  row.querySelector('[data-step-mode]')?.addEventListener('change',update);
  row.querySelector('[data-step-phase]')?.addEventListener('change',event=>{row.querySelector('[data-step-offset]').value=offsets[event.target.value];});
  row.querySelector('[data-remove-trip-step]')?.addEventListener('click',()=>row.remove());
  update();
 }
}

export function readTripSteps(host,savedTasks=[]){
 return [...host.querySelectorAll('[data-trip-step]')].filter(row=>row.querySelector('[data-step-enabled]').checked).map(row=>{
  const original=savedTasks.find(t=>t.step_key===row.dataset.tripStep);
  if(row.dataset.history)return original.trip_recipe;
  const value=selector=>row.querySelector(selector).value;
  const ids=[...row.querySelector('[data-step-owners]').selectedOptions].map(o=>Number(o.value));
  return {...(original?.trip_recipe||{}),step_key:row.dataset.tripStep,title:value('[data-step-title]').trim(),phase:value('[data-step-phase]'),
   ...(ids.length?{assigned_user_ids:ids}:{assigned_user_ids:[Number(host.querySelector('[name="coordinator_id"]').value)]}),
   due_mode:value('[data-step-mode]'),due_date:value('[data-step-mode]')==='fixed'?value('[data-step-date]'):null,
   due_time:value('[data-step-time]')||null,offset_minutes:Number(value('[data-step-offset]')),
   reminder_offset_minutes:value('[data-step-reminder]')===''?null:Number(value('[data-step-reminder]')),
   is_optional:row.querySelector('[data-step-optional]').checked};
 });
}
