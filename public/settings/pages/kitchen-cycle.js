import {authenticationSnapshot} from '/utils/device-context.js';
import {sessionRevision} from '/utils/session-lifecycle.js';
import {mealCycles} from '/api.js';
import {t,formatDate,formatTime,getFormatLocale} from '/i18n.js';
import {esc} from '/utils/html.js';
import {createCycleDraft,cycleWallTime} from '/utils/meal-cycle-state.js';
const text=key=>t(`kitchenCycle.${key}`);
const drafts=new Map();
const mounts=new WeakMap();
if(typeof window!=='undefined')for(const event of ['auth:expired','auth:context-rejected','session:changed'])window.addEventListener(event,()=>drafts.clear());
const times=['creation','response','confirmation','shopping'];
export function familyWeeklyPreset(start=null){const weekday=start?new Date(`${start}T12:00:00Z`).getUTCDay():1;const before=day=>-((weekday-day+7)%7||7);return {enabled:false,cadence:'weekly',first_period_start:start,coordinator_id:null,shopping_assignee_id:null,shopping_list_id:null,finalization_mode:'manual',creation:{day_offset:before(5),time:''},response:{day_offset:before(5),time:''},confirmation:{day_offset:before(6),time:''},shopping:{day_offset:before(0),time:''}};}
function weekdayField(key,settings){
  const start=settings.first_period_start||'2034-03-06',duration=settings.cadence==='fortnightly'?14:7,current=settings[key]?.day_offset;
  const offsets=[...new Set([...Array.from({length:duration+7},(_,i)=>i-7),...(current!=null?[current]:[])])].sort((a,b)=>a-b);
  return `<label>${text('weekday')}<select class="form-input" name="${key}_day_offset" required><option value="">${text('choose')}</option>${offsets.map(offset=>{const d=new Date(`${start}T12:00:00Z`);d.setUTCDate(d.getUTCDate()+offset);const day=new Intl.DateTimeFormat(getFormatLocale(),{weekday:'long',timeZone:'UTC'}).format(d);return `<option value="${offset}"${current===offset?' selected':''}>${esc(day)} · ${esc(offset<0?text('beforePeriod'):text('withinPeriod'))}${settings.first_period_start?` · ${esc(formatDate(d.toISOString().slice(0,10)))}`:''}</option>`;}).join('')}</select></label>`;
}
export function renderScheduleFields(settings){
  const monthly=settings.cadence==='monthly';
  return `<div class="cycle-schedule">${times.map(key=>`<fieldset><legend>${text(key)}</legend>${monthly?`<label>${text('monthOffset')}<input class="form-input" type="number" name="${key}_month_offset" min="-12" max="12" value="${settings[key]?.month_offset??''}" required></label><label>${text('dayOfMonth')}<input class="form-input" type="number" name="${key}_day" min="1" max="31" value="${settings[key]?.day??''}" required></label>`:['weekly','fortnightly'].includes(settings.cadence)?weekdayField(key,settings):`<label>${text('dayOffset')}<input class="form-input" type="number" name="${key}_day_offset" min="-366" max="366" value="${settings[key]?.day_offset??''}" required></label>`}<label>${text('time')}<input class="form-input" type="time" name="${key}_time" value="${settings[key]?.time||''}" required></label></fieldset>`).join('')}</div><label>${text('confirmationMode')}<select class="form-input" name="finalization_mode"><option value="manual"${settings.finalization_mode!=='automatic'?' selected':''}>${text('manual')}</option><option value="automatic"${settings.finalization_mode==='automatic'?' selected':''}>${text('automatic')}</option></select></label>`;
}
export function readScheduleFields(form,cadence){
  const result={finalization_mode:form.querySelector('[name="finalization_mode"]').value};
  for(const key of times){const read=name=>{const field=form.querySelector(`[name="${key}_${name}"]`);if(!field?.value)throw new Error(text('completeTimes'));return field.value;};result[key]={time:read('time'),...(cadence==='monthly'?{day:Number(read('day')),month_offset:Number(read('month_offset'))}:{day_offset:Number(read('day_offset'))})};}
  return result;
}
export function schedulePreview(schedule,timezone){return schedule?`<div class="cycle-card"><h3>${text('preview')}</h3><p>${esc(timezone)} · ${esc(formatDate(`${schedule.period.start}T12:00:00`))} – ${esc(formatDate(`${schedule.period.end}T12:00:00`))}</p>${times.map(key=>{const wall=cycleWallTime(schedule[key],timezone);return `<p>${text(key)}: ${esc(formatDate(wall))} ${esc(formatTime(wall))}</p>`;}).join('')}</div>`:'';}
export async function render(container){
  const mount=Symbol(),route=location.pathname+location.search;mounts.set(container,mount);const alive=()=>container.isConnected&&mounts.get(container)===mount&&location.pathname+location.search===route;
  const auth=authenticationSnapshot(),key=String(window.yuvomi?.user?.id)+':'+auth.context+':'+auth.epoch+':'+sessionRevision();
  if(!drafts.has(key))drafts.set(key,{state:createCycleDraft(),settingsDraft:null,ensurePending:null,presetSelected:false});const draft=drafts.get(key);
  let settings,previewed=null,loadVersion=0;const state=draft.state;
  const error=e=>{const target=container.querySelector('[data-cycle-error]');if(target){target.textContent=e.outcome==='unknown'?text('unknown'):e.status===409?`${text('stale')} ${e.message}`:e.message;target.hidden=false;target.focus();}container.querySelector('[data-cycle-retry]')?.toggleAttribute('hidden',!state.pending&&!draft.ensurePending);};
  async function load(){const version=++loadVersion;try{const response=await mealCycles.settings();if(version!==loadVersion||!container.isConnected)return;settings=response.data;state.acceptLoad(state.loadToken(),settings);draw();}catch(e){container.innerHTML=`<p role="alert">${esc(e.message)}</p>`;}}
  const select=(name,label,rows,value)=>`<label>${label}<select class="form-input" name="${name}" required><option value="">${text('choose')}</option>${rows.map(row=>`<option value="${row.id}"${Number(value)===row.id?' selected':''}>${esc(row.name||row.display_name)}</option>`).join('')}</select></label>`;
  function draw(){
    if(!alive())return;
    if(!settings.admin){container.innerHTML=`<p>${text('adminSetup')}</p>`;return;}
    const s=draft.settingsDraft||settings;
    container.innerHTML=`<section class="settings-section meal-cycle-settings"><h2 class="settings-section__title">${text('setupTitle')}</h2><div class="settings-card"><p>${text('setupHint')}</p><p>${text('timezone')}: <strong>${esc(settings.timezone)}</strong></p><p>${text('cookingAutomation')}: <strong>${text(settings.execution_settings?.enabled?'on':'off')}</strong></p><div class="cycle-actions"><a class="btn btn--secondary" href="/meals?legacy=1&focus=meal-plan" data-nav>${text('usualRoutine')}</a><a class="btn btn--secondary" href="/meals?legacy=1&focus=meal-plan" data-nav>${text('advanced')}</a></div>
      <button class="btn btn--secondary" type="button" data-family-preset>${text('familyPreset')}</button><form data-cycle-settings><label class="cycle-check"><input name="enabled" type="checkbox"${s.enabled?' checked':''}>${text('enable')}</label><label>${text('cadence')}<select class="form-input" name="cadence" required><option value="">${text('choose')}</option>${['daily','weekly','fortnightly','monthly'].map(c=>`<option value="${c}"${s.cadence===c?' selected':''}>${text(c)}</option>`).join('')}</select></label><label>${text('firstStart')}<input class="form-input" type="date" name="first_period_start" value="${s.first_period_start||''}" required></label>
      ${select('coordinator_id',text('coordinator'),settings.members,s.coordinator_id)}${select('shopping_assignee_id',text('shopper'),settings.members,s.shopping_assignee_id)}${select('shopping_list_id',text('destination'),settings.lists,s.shopping_list_id)}
      <p class="form-hint">${text('offsetHint')}</p><div data-timing-fields>${renderScheduleFields(s)}</div><details><summary>${text('advanced')}</summary><p>${text('advancedHint')}</p><a href="/meals?legacy=1&focus=meal-plan" data-nav>${text('usualRoutine')}</a></details>
      <div data-preview></div><p data-cycle-error role="alert" tabindex="-1" hidden></p><p data-cycle-status role="status"></p><div class="settings-form-actions"><button class="btn btn--secondary" type="button" data-cycle-preview>${text('preview')}</button><button class="btn btn--primary" type="submit">${text('saveSetup')}</button><button class="btn btn--secondary" type="button" data-cycle-retry hidden>${text('retry')}</button><button class="btn btn--secondary" type="button" data-cycle-refresh>${text('refresh')}</button>${settings.enabled?`<button class="btn btn--secondary" type="button" data-cycle-pause>${text('pause')}</button>`:''}</div></form>
      ${(settings.generation_failures||[]).map(f=>`<p>${esc(f.message||f.error||text('generationBlocked'))}</p>`).join('')}
      <details><summary>${text('createPeriod')}</summary><p>${text('ensureHint')}</p><label>${text('periodStart')}<input class="form-input" name="ensure_start" type="date" value="${settings.first_period_start||''}"></label><button class="btn btn--secondary" type="button" data-cycle-ensure>${text('createPeriod')}</button></details></div></section>`;
    const form=container.querySelector('form');
    container.querySelector('[data-family-preset]').addEventListener('click',()=>{draft.settingsDraft={...settings,...familyWeeklyPreset()};draft.presetSelected=true;previewed=null;draw();});
    function values(){if(!form.reportValidity())throw new Error(text('required'));return {enabled:form.elements.enabled.checked,timezone:settings.timezone,cadence:form.elements.cadence.value,first_period_start:form.elements.first_period_start.value,coordinator_id:Number(form.elements.coordinator_id.value),shopping_assignee_id:Number(form.elements.shopping_assignee_id.value),shopping_list_id:Number(form.elements.shopping_list_id.value),...readScheduleFields(form,form.elements.cadence.value)};}
    function lock(value){form.querySelectorAll('input,select,button').forEach(el=>el.disabled=value);form.querySelector('[data-cycle-retry]').disabled=false;form.querySelector('[data-cycle-refresh]').disabled=false;}
    const capture=()=>{const cadence=form.elements.cadence.value,result={...settings,enabled:form.elements.enabled.checked,cadence,first_period_start:form.elements.first_period_start.value,coordinator_id:Number(form.elements.coordinator_id.value)||null,shopping_assignee_id:Number(form.elements.shopping_assignee_id.value)||null,shopping_list_id:Number(form.elements.shopping_list_id.value)||null,finalization_mode:form.elements.finalization_mode.value};for(const key of times){const value=name=>{const v=form.querySelector('[name="'+key+'_'+name+'"]')?.value;return v===''||v==null?null:Number(v);};result[key]={time:form.querySelector('[name="'+key+'_time"]').value,...(cadence==='monthly'?{day:value('day'),month_offset:value('month_offset')}:{day_offset:value('day_offset')})};}draft.settingsDraft=result;};
    let retry=state.pending?()=>save(state.pending.payload.settings):draft.ensurePending?()=>ensure():null;
    if(state.pending||draft.ensurePending){lock(true);form.querySelector('[data-cycle-retry]').hidden=false;}
    async function save(input){
      if(state.busy)return;draft.settingsDraft=input;lock(true);try{const r=await state.run('settings',p=>mealCycles.saveSettings(p).then(x=>x.data),{settings:input});settings={...settings,...r};draft.settingsDraft=null;previewed=null;draw();container.querySelector('[data-cycle-status]').textContent=text('saved');}catch(e){lock(Boolean(state.pending));error(e);}
    }
    form.elements.cadence.addEventListener('change',()=>{draft.presetSelected=false;form.querySelector('[data-timing-fields]').innerHTML=renderScheduleFields({cadence:form.elements.cadence.value,finalization_mode:form.elements.finalization_mode?.value||'manual'});capture();previewed=null;});
    form.elements.first_period_start.addEventListener('change',()=>{let schedule={};try{schedule=readScheduleFields(form,form.elements.cadence.value);}catch{for(const key of times)schedule[key]={day_offset:Number(form.querySelector(`[name="${key}_day_offset"]`)?.value),time:form.querySelector(`[name="${key}_time"]`)?.value||''};}if(draft.presetSelected&&form.elements.cadence.value==='weekly'){const preset=familyWeeklyPreset(form.elements.first_period_start.value);for(const key of times)schedule[key]={...preset[key],time:schedule[key]?.time||''};}form.querySelector('[data-timing-fields]').innerHTML=renderScheduleFields({...schedule,cadence:form.elements.cadence.value,first_period_start:form.elements.first_period_start.value});capture();previewed=null;});
    form.addEventListener('input',event=>{if(event.target.name.endsWith('_day_offset'))draft.presetSelected=false;capture();previewed=null;});
    form.querySelector('[data-cycle-preview]').addEventListener('click',async()=>{try{const input=values(),signature=JSON.stringify(input),r=await mealCycles.preview(input);if(signature!==JSON.stringify(values()))return;previewed=signature;form.querySelector('[data-preview]').innerHTML=schedulePreview(r.data.schedule,settings.timezone)+`<p>${esc(r.data.adoption_note)}</p>`;}catch(e){error(e);}});
    form.addEventListener('submit',event=>{event.preventDefault();try{const input=values();if(previewed!==JSON.stringify(input))throw new Error(text('previewFirst'));retry=()=>save(input);retry();}catch(e){error(e);}});
    form.querySelector('[data-cycle-pause]')?.addEventListener('click',()=>{retry=()=>save({enabled:false});retry();});
    form.querySelector('[data-cycle-retry]').addEventListener('click',()=>retry?.());
    form.querySelector('[data-cycle-refresh]').addEventListener('click',async()=>{try{draft.settingsDraft=values();const r=await mealCycles.settings();settings={...settings,...r.data};state.acceptLoad(state.loadToken(),settings);previewed=null;draw();}catch(e){error(e);}});
    async function ensure(){
      if(!settings.enabled){error(new Error(text('enableFirst')));return;}
      const start=container.querySelector('[name="ensure_start"]').value;if(!start)return;
      if(draft.ensureBusy)return;draft.ensurePending??={expected_revision:settings.revision,request_key:crypto.randomUUID(),start};const send=async()=>{if(draft.ensureBusy)return;draft.ensureBusy=true;try{const r=await mealCycles.ensure(draft.ensurePending);draft.ensurePending=null;window.yuvomi?.navigate(`/meals?cycle=${r.data.cycle_id}`);}catch(e){if(e.outcome==='rejected')draft.ensurePending=null;error(e);}finally{draft.ensureBusy=false;}};retry=send;send();
    }
    container.querySelector('[data-cycle-ensure]').addEventListener('click',ensure);
  }
  container.innerHTML=`<p>${text('loading')}</p>`;await load();
}
