import {api,mealCycles} from '/api.js';
import {t,formatDate,formatTime} from '/i18n.js';
import {esc} from '/utils/html.js';
import {portionControl,portionPatch,bindPortionControl} from '/utils/meal-cycle-portions.js';
import {createCycleDraft,cycleWallTime} from '/utils/meal-cycle-state.js';
import {recipeServingBasis,formatServingAmount} from '/utils/meal-portions.js';
import {isDevicePrincipal,authenticationSnapshot} from '/utils/device-context.js';
import {sessionRevision} from '/utils/session-lifecycle.js';
import {renderScheduleFields,readScheduleFields,schedulePreview} from '/settings/pages/kitchen-cycle.js';
import {renderKitchenTabsBar} from '/utils/kitchen-tabs.js';

const text=(key,values)=>t(`kitchenCycle.${key}`,values);
const drafts=new Map();
const mounts=new WeakMap();
if(typeof window!=='undefined')for(const event of ['auth:expired','auth:context-rejected','session:changed'])window.addEventListener(event,()=>drafts.clear());
const button=(action,label,disabled=false)=>`<button type="button" class="btn btn--secondary" data-action="${action}"${disabled?' disabled':''}>${esc(label)}</button>`;
const dateLabel=value=>formatDate(`${value}T12:00:00`);
const instant=(value,zone)=>{const wall=cycleWallTime(value,zone);return `${formatDate(wall)} ${formatTime(wall)}`;};
const choiceMode=d=>['not_participating','away'].includes(d?.participation)?'none':['backup','custom','personal','restaurant','takeout'].includes(d?.choice_kind)?'other':'family';
const link=(path,label)=>`<a class="btn btn--secondary" href="${esc(path)}" data-nav>${esc(label)}</a>`;
function basisText(m){return (m.recipe_bases||[]).map(recipe=>{const basis=recipeServingBasis(recipe);return `${recipe.title}: ${basis?`${formatServingAmount(basis.amount)} ${basis.label||basis.unit} ${text('perPortion')}`:recipe.yield_portions?text('recipeYield',{count:recipe.yield_portions}):text('yieldUnknown')}`;}).join(' · ');}
function memberSelect(name,label,members,current){return `<label>${text(label)}<select class="form-input" name="${name}"><option value="">${text('choose')}</option>${members.map(p=>`<option value="${p.id}"${p.id===current?' selected':''}>${esc(p.display_name)}</option>`).join('')}</select></label>`;}
function reviewMeals(model,adjustment){
  const meals=adjustment?.occurrences||model.occurrences,executions=adjustment?.executions||model.executions||[];
  return cycleDays(model.cycle).map(date=>`<section class="cycle-day"><h3>${esc(dateLabel(date))}</h3>${['breakfast','lunch','dinner'].map(slot=>`<h4>${esc(t(`meals.type${slot[0].toUpperCase()}${slot.slice(1)}`))}</h4>${meals.filter(m=>m.date===date&&m.meal_type===slot).map(m=>{
    const roles=executions.find(e=>e.meal_id===m.id)?.roles;
    return `<article class="cycle-card" id="meal-${m.id}"><h4>${esc(m.title||text('needsMain'))} · ${esc(m.context?.name||text('home'))}</h4><p>${text('sides')}: ${(m.menu_items||[]).filter(x=>x.item_type==='side').map(x=>esc(x.title)).join(', ')||'—'}</p><p>${text('requested')}: ${m.planned_portions||0} · ${text('cooking')}: ${m.cook_portions||0}</p><p>${esc(basisText(m))}</p>${adjustment?`<p>${text('before')}: ${esc(adjustment.before?.find(x=>x.id===m.id)?.title||'—')} → ${text('after')}: ${esc(m.title||'—')}</p>`:''}<ul>${(m.participants||[]).map(p=>{const d=m.decisions?.find(x=>x.beneficiary_user_id===p.user_id)||p.decision;return `<li>${esc(p.display_name)}: ${esc(d?.selected_meal_title||text(p.status==='away'?'away':choiceMode(d)==='none'?'notEating':choiceMode(d)==='other'?'otherMeal':d?.confirmed?'familyMeal':'responseMissing'))} · ${d?.portion_amount??1} ${text('portions')}${p.attendance_reason?` · ${esc(p.attendance_reason)}`:''}${model.permissions.admin?` ${link(`/meals?cycle=${model.cycle.id}&beneficiary=${p.user_id}`,text('helpPerson'))}`:''}</li>`;}).join('')}</ul>${roles?`<dl>${['preparation','cooking','supervision','serving','cleanup'].map(key=>{const r=roles.find(x=>x.role===key);return `<dt>${text(key)}</dt><dd>${!r?.required?text('notRequired'):r.status==='missing'?`${text('needsAssignment')} ${link('/meals?legacy=1&focus=meal-plan',text('usualRoutine'))}`:`${text('planned')}: ${esc(r.planned_assignee_name||text('unclaimed'))}`} · ${text('actual')}: ${r?.output_task_id?`${esc(r.output_assignee_name||text('unclaimed'))} ${link(`/tasks?open=${r.output_task_id}&cycle_return=${model.cycle.id}&beneficiary=${model.personal.beneficiary_id}`,text('reviewTask'))}`:text('notCreated')}</dd>`;}).join('')}</dl>`:''}</article>`;
  }).join('')||`<p>${text('noRoutine')} ${link('/meals?legacy=1&focus=meal-plan',text('usualRoutine'))}</p>`}`).join('')}</section>`).join('');
}
function sideEditor(m,sides,operations=[]){return `<details data-sides><summary>${text('manageSides')}</summary><p>${text('sideHistory')}</p>${sides.map(s=>`<div data-side-row="${s.id}"><label>${text('sideName')}<input class="form-input" name="side_title_${s.id}" value="${esc(operations.find(o=>o.id===s.id&&o.operation==='edit')?.title??s.title)}" maxlength="300"></label><label class="cycle-check"><input type="checkbox" name="side_remove_${s.id}"${operations.some(o=>o.id===s.id&&o.operation==='remove')?' checked':''}>${text('removeSide')}</label></div>`).join('')}<label>${text('addSide')}<input class="form-input" name="side_add" value="${esc(operations.find(o=>o.operation==='add')?.title||'')}" maxlength="300"></label></details>`;}
export function cycleDays(c){const result=[];for(let d=c.period_start;d<=c.period_end;){result.push(d);const next=new Date(`${d}T12:00:00Z`);next.setUTCDate(next.getUTCDate()+1);d=next.toISOString().slice(0,10);}return result;}
function recipeEditor(m,change,kind,recipes){
  const decision=change?.decision||m.my_decision||{};
  const id=kind==='main'?(change&&Object.hasOwn(change,'recipe_id')?change.recipe_id:m.recipe_id):(decision.selected_recipe_id??null);
  const title=kind==='main'?(change?.title??m.title??''):(decision.selected_meal_title??'');
  return `<label>${text('recipe')}<select class="form-input" name="${kind}_recipe"><option value="">${text('namedMeal')}</option>${recipes.map(r=>`<option value="${r.id}"${Number(id)===r.id?' selected':''}>${esc(r.title)}</option>`).join('')}</select></label><label>${text('mealName')}<input class="form-input" name="${kind}_title" value="${esc(title)}" maxlength="200"${id?' readonly':''}></label>`;
}
function mealCard(m,model,state,recipes,adjustment){
  const requirements=model.personal.requirements.filter(x=>x.meal_id===m.id),changes=state.changes();
  const main=changes.find(x=>x.meal_id===m.id&&x.kind==='main'),change=changes.find(x=>x.meal_id===m.id&&x.kind==='decision');
  const d=change?.decision||m.my_decision||{},mode=m.rule?.policy==='personal_choice'&&!d.participation?'other':choiceMode(d),sides=(m.menu_items||[]).filter(x=>x.item_type==='side');
  const selected=d.select_side_ids||d.menu_item_ids||d.selected_menu_item_ids||d.menu_items?.map(x=>x.id)||[];
  const canEdit=model.permissions.write&&!m.begun&&!m.adopted_history&&!state.pending;
  const personal=requirements.some(x=>x.kind==='decision')||Boolean(adjustment&&m.participants?.some(x=>x.user_id===model.personal.beneficiary_id));
  const chooser=requirements.some(x=>x.kind==='main')||Boolean(adjustment&&m.choosers?.some(x=>x.user_id===model.personal.beneficiary_id));
  const basis=basisText(m);
  return `<article class="cycle-card" data-meal="${m.id}"><h4>${esc(m.title||text('needsMain'))}</h4><p>${esc(m.context?.name||text('home'))} · ${esc(text('requested'))}: ${Number(m.planned_portions||0)} · ${esc(text('cooking'))}: ${Number(m.cook_portions||0)}</p>${basis?`<p class="form-hint">${esc(basis)}</p>`:''}
    ${canEdit&&chooser?`<details${main?' open':''}><summary>${text('chooseMain')}</summary><div data-main>${recipeEditor(m,main,'main',recipes)}</div><p class="form-hint">${text('mainHint')}</p></details>${!adjustment?sideEditor(m,sides,changes.find(x=>x.meal_id===m.id&&x.kind==='sides')?.operations):`<p>${text('newSides')}</p>`}`:''}
    ${canEdit&&personal?`<fieldset data-decision><legend>${text('yourAnswer')}</legend><label>${text('yourAnswer')}<select class="form-input" name="choice">${m.rule?.policy==='personal_choice'?'':`<option value="family"${mode==='family'?' selected':''}>${text('familyMeal')}</option>`}<option value="other"${mode==='other'?' selected':''}>${text('otherMeal')}</option><option value="none"${mode==='none'?' selected':''}>${text('notEating')}</option></select></label><div data-alternative${mode==='other'?'':' hidden'}>${recipeEditor(m,change,'alternative',recipes)}</div><div data-portions${mode==='none'?' hidden':''}><label for="portion-${m.id}">${text('portions')}</label>${portionControl(`portion-${m.id}`,d.portion_amount,{saved:text('savedAmount'),hint:text('legacyHint'),label:text('portions'),prompt:text('replacement')})}</div>
      ${sides.length?`<details><summary>${text('sides')}</summary>${adjustment?`<p>${text('newSides')}</p>`:''}${sides.map(s=>`<label class="cycle-check"><input type="checkbox" name="side" value="${s.id}"${selected.includes(s.id)?' checked':''}${adjustment?' disabled':''}>${esc(s.title)}</label>`).join('')}</details>`:''}</fieldset>`:`<p>${esc(m.begun||m.adopted_history?text('recorded'):personal?text('readOnly'):text('noAnswer'))}</p>`}
    <p class="form-hint">${esc(requirements.filter(x=>!x.complete).map(x=>x.reason).join(' '))}</p></article>`;
}
export function renderCycleCards(model,state,recipes=[],adjustment=null){
  const occurrences=adjustment?.occurrences?.length?adjustment.occurrences:model.occurrences;
  return cycleDays(model.cycle).map(date=>`<section class="cycle-day"><h2>${esc(dateLabel(date))}</h2>${['breakfast','lunch','dinner'].map(slot=>`<section class="cycle-slot"><h3>${esc(t(`meals.type${slot[0].toUpperCase()}${slot.slice(1)}`))}</h3>${occurrences.filter(m=>m.date===date&&m.meal_type===slot).map(m=>mealCard(m,model,state,recipes,adjustment)).join('')||`<p class="form-hint">${text('noRoutine')} ${link('/meals?legacy=1&focus=meal-plan',text('usualRoutine'))}</p>`}</section>`).join('')}</section>`).join('');
}
function blockers(items){return items?.length?`<ul class="cycle-blockers">${items.map(b=>`<li>${esc(b.message||text('reviewRequired'))}${b.meal_id?` <a href="#meal-${b.meal_id}">${text('reviewMeal')}</a>`:''}</li>`).join('')}</ul>`:'';}
function outputSummary(model,result){
  const q=`cycle_return=${model.cycle.id}&beneficiary=${model.personal.beneficiary_id}`;
  const taskIds=new Set([...(result?.execution_task_ids||[]),...(result?.preserved||[]).flatMap(x=>[...(x.task_ids||[]),x.task_id].filter(Boolean))]);
  return `${result?.requires_manual_review?`<p role="status">${text('preservedWork')}</p>`:''}${(result?.preserved||[]).map(x=>{const meal=model.occurrences.find(m=>m.id===x.meal_id),item=x.shopping_item_id||x.item_id||x.grocery_item_id;return `<article class="cycle-card"><p>${esc(text(x.reason||x.kind))} ${esc(meal?.title||'')} ${esc(x.name||'')}</p>${[['demand_quantity','demandQuantity'],['actual_quantity','actualQuantity'],['coverage_quantity','coverageQuantity'],['deferred_quantity','deferred']].filter(([key])=>x[key]!=null).map(([key,label])=>`<p>${text(label)}: ${esc(x[key])} ${esc(x.unit||'')}</p>`).join('')}${x.additions_deferred?`<p>${text('additionsDeferred')}</p>`:''}${item?link(`/shopping?${x.shopping_list_id?`list=${x.shopping_list_id}&`:''}highlight=${item}&${q}`,text('reviewShopping')):''}</article>`;}).join('')}<div class="cycle-actions">${(result?.grocery_runs||[]).map(x=>link(`/shopping?list=${x.shopping_list_id}&${q}`,`${text('shopping')} · ${model.destinations.find(p=>p.context_id===x.context_id)?.name||text('home')} · ${model.destinations.find(p=>p.shopping_list_id===x.shopping_list_id)?.shopping_list_name||''}`)).join('')}${[...taskIds].map(id=>link(`/tasks?open=${id}&${q}`,text('reviewTask'))).join('')}</div>`;
}
export async function render(container,{user}){
  const mount=Symbol(),route=location.pathname+location.search;mounts.set(container,mount);
  const query=new URLSearchParams(location.search),id=Number(query.get('cycle')),person=Number(query.get('beneficiary'))||user?.id;
  if(isDevicePrincipal()||!user?.id){container.innerHTML=`<p role="alert">${text('personalSignIn')}</p>${link('/meals?legacy=1',text('legacyMeals'))}`;return;}
  let model=null,recipes=[],proposalId=Number(query.get('proposal'))||null,adjustment=null,phase=['review','shopping'].includes(query.get('purpose'))?query.get('purpose'):'choices',error='',notice='',lastResult=null;
  const key=`${user.id}:${authenticationSnapshot().context}:${authenticationSnapshot().epoch}:${sessionRevision()}:${id}:${person}`;if(!drafts.has(key))drafts.set(key,createCycleDraft());const state=drafts.get(key);
  const alive=()=>container.isConnected&&mounts.get(container)===mount&&location.pathname+location.search===route;
  function showError(e){error=e.status===409?`${text('stale')} ${e.message}`:e.outcome==='unknown'?text('unknown'):e.message||text('error');draw();container.querySelector('[role="alert"]')?.focus();}
  // Shared generation prevents a slow proposal read from replacing a newer selection.
  let loadVersion=0;
  async function refresh(){loadVersion++;const version=loadVersion,token=state.loadToken();try{const data=(await mealCycles.read(id,person)).data;const p=proposalId?(await mealCycles.adjustment(id,proposalId,person)).data:null;if(version!==loadVersion||!alive()||!state.acceptLoad(token,data))return;model=data;adjustment=p;error='';draw();}catch(e){if(version===loadVersion&&alive())showError(e);}}
  async function operate(action,send,extra={}){
    if(state.busy)return;error='';const promise=state.run(action,send,extra);draw();
    try{const result=await promise;if(!alive())return;notice=text('saved');if(result.proposal_id&&action==='preview'){proposalId=result.proposal_id;adjustment=result;phase='review';}if(action==='reschedule')delete state.forms.reschedule;if(['confirm','apply'].includes(action)){lastResult=result;phase='shopping';}await refresh();}catch(e){if(alive())showError(e);}
  }
  function draw(){
    if(!alive())return;
    if(!model){container.innerHTML=`<section class="meal-cycle"><h1>${text('title')}</h1>${error?`<p role="alert" tabindex="-1">${esc(error)}</p>`:`<p>${text('loading')}</p>`}${button('reload',text('refresh'))}</section>`;container.querySelector('[data-action="reload"]')?.addEventListener('click',refresh);return;}
    const finalized=model.cycle.state==='finalized',dirty=state.changes().length>0,locked=state.busy||Boolean(state.pending),review=model.permissions.review;
    const nav=`<nav class="cycle-phases" aria-label="${text('phases')}">${[['choices','myChoices'],...(review?[['review','householdReview']]:[]),['shopping','shoppingTasks']].map(([p,label])=>`<button class="btn btn--${p===phase?'primary':'secondary'}" data-phase="${p}" aria-current="${p===phase?'step':'false'}">${text(label)}</button>`).join('')}</nav>`;
    container.innerHTML=`<div class="meal-cycle"><header><h1>${text('title')} · ${esc(dateLabel(model.cycle.period_start))} – ${esc(dateLabel(model.cycle.period_end))}</h1><p>${esc(model.cycle.timezone)} · ${esc(finalized?text('confirmed'):model.cycle.finalization_mode==='automatic'?text(model.cycle.attempt_status==='blocked'?'autoBlocked':'automatic'):text('waiting'))}</p><p>${text('responseBy')}: ${esc(instant(model.cycle.response_at,model.cycle.timezone))} · ${text('reviewAt')}: ${esc(instant(model.cycle.confirmation_at,model.cycle.timezone))} · ${text('shoppingAt')}: ${esc(instant(model.cycle.shopping_at,model.cycle.timezone))}</p>${link('/meals?legacy=1',text('legacyMeals'))} ${link('/settings/modules/kitchen',text('settings'))}</header>${person!==user.id?`<p class="cycle-card">${text('actingFor')}: ${esc(model.personal.beneficiary_name||person)}</p>`:''}${nav}
      ${error?`<p class="cycle-error" role="alert" tabindex="-1">${esc(error)}</p>${button('reload',text('refresh'))}`:''}${notice?`<p role="status">${esc(notice)}</p>`:''}${state.pending?`<p>${text('unknown')}</p>${button('retry',text('retry'),state.busy)}`:''}
      ${model.adjustments.length?`<aside><h2>${text('adjustments')}</h2>${model.adjustments.map(p=>`<button class="btn btn--secondary" data-proposal="${p.id}">${text('reviewAdjustment')} ${p.id}</button>`).join('')}${proposalId?button('close-proposal',text('back')):''}</aside>`:''}
      ${phase==='choices'?`<p>${esc(model.personal.submitted?text('submittedEditable'):text('saveThenSubmit'))}</p>${renderCycleCards(model,state,recipes,adjustment)}<div class="cycle-actions">${button('save',text(finalized?'previewAdjustment':'save'),locked||!dirty||!model.permissions.write)}${button('submit',text('submit'),locked||dirty||!model.permissions.submit||(finalized&&!proposalId))}</div>${dirty?`<p>${text('saveFirst')}</p>`:''}`:''}
      ${phase==='review'&&review?`<h2>${text('householdReview')}</h2>${blockers(adjustment?.blockers||model.blockers)}${model.execution_settings?`<p>${text('cookingAutomation')}: ${text(model.execution_settings.enabled?'on':'off')}</p>`:''}
      <div class="cycle-review-meals">${reviewMeals(model,adjustment)}</div>
      ${model.destinations.map(p=>`<p>${esc(p.name)} → ${p.track_groceries?esc(p.shopping_list_name):text('noGroceries')}</p>`).join('')}      ${(adjustment?.warnings||model.warnings||[]).map(w=>`<p>${esc(w.message)}</p>`).join('')}
      ${(adjustment?.gaps||model.gaps||[]).filter(g=>!g.acknowledged).map(g=>`<label class="cycle-check"><input type="checkbox" name="gap" value="${g.meal_id}">${text('acknowledgeGap')}: ${esc(g.missing_dishes?.join(', ')||text('portions'))}</label>`).join('')}
      ${button('acknowledge',text('acknowledge'),locked)}${adjustment?`${adjustment.stale?`<p role="alert">${text('staleProposal')}</p>`:''}${outputSummary(model,adjustment)}${button('apply',text('applyAdjustment'),locked||adjustment.stale||!adjustment.ready)}${button('cancel',text('cancelAdjustment'),locked)}`:!finalized?`<p>${text('confirmationImpact')}</p>${button('confirm',text('confirm'),locked||!model.ready)}`:''}
      ${!finalized?`<details><summary>${text('changeTimes')}</summary><form data-reschedule>${renderScheduleFields(model.settings)}<label class="cycle-check"><input type="checkbox" name="confirm_due_now">${text('dueNow')}</label><div data-schedule-preview></div>${button('reschedule-preview',text('preview'))}${button('reschedule',text('saveTimes'),locked)}</form></details>`:''}
      ${model.permissions.admin&&!finalized?`<details><summary>${text('recoverAssignments')}</summary><p>${text('recoveryHint')}</p>${memberSelect('recover_coordinator','coordinator',model.members,model.settings.coordinator_id)}${memberSelect('recover_shopper','shopper',model.members,model.settings.shopping_assignee_id)}${button('recover',text('save'),locked)}</details>`:''}`:''}
      ${phase==='shopping'?`<h2>${text('shoppingTasks')}</h2><p>${text('shoppingDistinct')}</p>${finalized?outputSummary(model,lastResult||model.result):`<p>${text('waiting')}</p>`}<div class="cycle-actions">${model.tasks.filter(x=>['shopping','personal','correction'].includes(x.purpose)).map(x=>link(`/tasks?open=${x.task_id}&cycle_return=${id}&beneficiary=${person}`,text(x.purpose==='shopping'?'shoppingTask':'planningTask'))).join('')}</div>`:''}
    </div>`;
    renderKitchenTabsBar(container,'/meals');wire();
  }
  function wire(){
    const scheduleForm=container.querySelector('[data-reschedule]');if(scheduleForm){for(const [name,value] of Object.entries(state.forms.reschedule||{})){const field=scheduleForm.elements.namedItem(name);if(field){if(field.type==='checkbox')field.checked=value;else field.value=value;}}scheduleForm.addEventListener('input',()=>{state.forms.reschedule=Object.fromEntries(Array.from(scheduleForm.elements).filter(e=>e.name).map(e=>[e.name,e.type==='checkbox'?e.checked:e.value]));rescheduleReviewed=null;});}
    container.querySelectorAll('[data-phase]').forEach(b=>b.addEventListener('click',()=>{phase=b.dataset.phase;draw();}));
    container.querySelectorAll('[data-proposal]').forEach(b=>b.addEventListener('click',()=>{if(state.changes().length){showError(new Error(text('saveFirst')));return;}proposalId=Number(b.dataset.proposal);phase=model.permissions.review?'review':'choices';refresh();}));
    container.querySelectorAll('[data-meal]').forEach(card=>{
      const mealId=Number(card.dataset.meal),m=(adjustment?.occurrences||model.occurrences).find(x=>x.id===mealId);const portion=card.querySelector('[name="portion_amount"]');if(portion)bindPortionControl(portion,(state.changes().find(x=>x.meal_id===mealId&&x.kind==='decision')?.decision||m.my_decision)?.portion_amount);
      card.addEventListener('input',event=>{
        if(locked())return;
        if(event.target.closest('[data-sides]')){
          const operations=(m.menu_items||[]).filter(x=>x.item_type==='side').flatMap(s=>{
            const remove=card.querySelector(`[name="side_remove_${s.id}"]`)?.checked,title=card.querySelector(`[name="side_title_${s.id}"]`)?.value;
            return remove?[{operation:'remove',id:s.id}]:title!==s.title?[{operation:'edit',id:s.id,title,recipe_id:null}]:[];
          });const added=card.querySelector('[name="side_add"]').value.trim();if(added)operations.push({operation:'add',title:added,recipe_id:null});
          if(operations.length)state.edit(mealId,{kind:'sides',operations});else state.remove(mealId,'sides');container.querySelector('[data-action="save"]').disabled=false;container.querySelector('[data-action="submit"]').disabled=true;return;
        }
        const main=event.target.closest('[data-main]'),kind=main?'main':'alternative';
        if(event.target.name===`${kind}_recipe`){const r=recipes.find(x=>x.id===Number(event.target.value)),input=card.querySelector(`[name="${kind}_title"]`);input.value=r?.title||'';input.readOnly=Boolean(r);}
        if(main){const recipe=Number(card.querySelector('[name="main_recipe"]').value)||null;state.edit(mealId,{kind:'main',title:card.querySelector('[name="main_title"]').value,recipe_id:recipe});}
        else{
          const mode=card.querySelector('[name="choice"]').value,recipe=Number(card.querySelector('[name="alternative_recipe"]').value)||null;
          card.querySelector('[data-alternative]').hidden=mode!=='other';card.querySelector('[data-portions]').hidden=mode==='none';
          const decision={participation:mode==='none'?'not_participating':'participating',choice_kind:mode==='other'?(m.rule?.policy==='personal_choice'?'personal':'backup'):'household',confirmed:true,...portionPatch(m.my_decision?.portion_amount,portion?.value||null)};
          if(mode==='other'){decision.selected_recipe_id=recipe;decision.selected_meal_title=card.querySelector('[name="alternative_title"]').value;decision.menu_item_ids=[];}
          else if(mode==='family'){
            if(adjustment||state.changes().some(x=>x.meal_id===mealId&&['main','sides'].includes(x.kind))){decision.select_shared_main=true;if(!adjustment)decision.select_side_ids=Array.from(card.querySelectorAll('[name="side"]:checked'),x=>Number(x.value));}
            else decision.menu_item_ids=[...(m.menu_items||[]).filter(x=>x.item_type==='entree'&&x.title===m.title&&x.recipe_id===m.recipe_id).slice(0,1).map(x=>x.id),...Array.from(card.querySelectorAll('[name="side"]:checked'),x=>Number(x.value))];
          }else decision.menu_item_ids=[];
          state.edit(mealId,{kind:'decision',decision});
        }
        container.querySelector('[data-action="save"]').disabled=false;container.querySelector('[data-action="submit"]').disabled=true;
      });
    });
    container.querySelectorAll('[data-action]').forEach(b=>b.addEventListener('click',()=>action(b.dataset.action).catch(showError)));
  }
  const locked=()=>state.busy||Boolean(state.pending);
  let retry=null,rescheduleReviewed=null;
  async function action(name){
    if(name==='reload')return refresh();
    if(name==='close-proposal'){if(state.changes().length)throw new Error(text('saveFirst'));proposalId=null;adjustment=null;return draw();}
    if(name==='retry'){
      if(retry)return retry();
      const action=state.pending?.action,methods={save:'save',preview:'previewAdjustment',confirm:'confirm',apply:'applyAdjustment',cancel:'cancelAdjustment',acknowledge:'acknowledge',reschedule:'reschedule',recover:'recover',submit:model.cycle.state==='finalized'?'submitAdjustment':'submit'};
      if(methods[action])return operate(action,p=>mealCycles[methods[action]](id,p).then(r=>r.data));return;
    }
    if(locked())return;
    const invoke=(operation,send,extra)=>{retry=()=>operate(operation,send,extra);return retry();};
    if(name==='save'){
      const changes=state.changes(),finalized=model.cycle.state==='finalized';
      for(const change of changes){if(change.kind!=='decision'||change.decision.choice_kind!=='household'||change.decision.participation!=='participating'||change.decision.select_shared_main)continue;
        if(changes.some(x=>x.meal_id===change.meal_id&&['main','sides'].includes(x.kind))){const menu=(model.occurrences.find(m=>m.id===change.meal_id)?.menu_items||[]),decision={...change.decision,select_shared_main:true,select_side_ids:(change.decision.menu_item_ids||[]).filter(id=>menu.some(s=>s.id===id&&s.item_type==='side'))};delete decision.menu_item_ids;state.edit(change.meal_id,{kind:'decision',decision});}}


      return invoke(finalized?'preview':'save',p=>(finalized?mealCycles.previewAdjustment(id,p):mealCycles.save(id,p)).then(r=>r.data),{beneficiary_id:person,...(finalized&&proposalId?{base_proposal_id:proposalId}:{})});
    }
    if(name==='submit'){if(state.changes().length)throw new Error(text('saveFirst'));return invoke('submit',p=>(model.cycle.state==='finalized'?mealCycles.submitAdjustment(id,p):mealCycles.submit(id,p)).then(r=>r.data),{beneficiary_id:person,...(model.cycle.state==='finalized'?{proposal_id:proposalId}:{})});}
    if(name==='confirm')return invoke('confirm',p=>mealCycles.confirm(id,p).then(r=>r.data));
    if(name==='apply')return invoke('apply',p=>mealCycles.applyAdjustment(id,p).then(r=>r.data),{proposal_id:proposalId});
    if(name==='cancel')return invoke('cancel',p=>mealCycles.cancelAdjustment(id,p).then(r=>r.data),{proposal_id:proposalId});
    if(name==='acknowledge'){
      const meal_ids=Array.from(container.querySelectorAll('[name="gap"]:checked'),x=>Number(x.value));if(!meal_ids.length)throw new Error(text('selectGaps'));
      return model.cycle.state==='finalized'?invoke('preview',p=>mealCycles.previewAdjustment(id,p).then(r=>r.data),{beneficiary_id:person,base_proposal_id:proposalId,acknowledge_meal_ids:meal_ids}):invoke('acknowledge',p=>mealCycles.acknowledge(id,p).then(r=>r.data),{meal_ids});
    }
    if(name.startsWith('reschedule')){
      const form=container.querySelector('[data-reschedule]'),schedule=readScheduleFields(form,model.settings.cadence),signature=JSON.stringify(schedule);
      if(name==='reschedule-preview'){const p=(await mealCycles.reschedulePreview(id,schedule)).data;rescheduleReviewed=signature;form.querySelector('[data-schedule-preview]').innerHTML=schedulePreview(p.schedule,model.cycle.timezone)+(p.due_now?`<p>${text('dueNow')}</p>`:'');return;}
      if(rescheduleReviewed!==signature)throw new Error(text('previewFirst'));
      return invoke('reschedule',p=>mealCycles.reschedule(id,p).then(r=>r.data),{schedule,confirm_due_now:form.querySelector('[name="confirm_due_now"]').checked});
    }
    if(name==='recover')return invoke('recover',p=>mealCycles.recover(id,p).then(r=>r.data),{coordinator_id:Number(container.querySelector('[name="recover_coordinator"]').value),shopping_assignee_id:Number(container.querySelector('[name="recover_shopper"]').value)});
  }
  draw();await refresh();
  try{const r=await api.get('/recipes');if(alive()){recipes=Array.isArray(r.data)?r.data:[];if(!state.changes().length&&!state.pending)draw();}}catch{/* Named alternatives remain available when recipes cannot load. */}
}

/** Read-only landing; disabled generation does not hide previously created work. */
export async function renderCycleLanding(container,{user}){
  const [s,list]=await Promise.all([mealCycles.settings(),mealCycles.list()]);
  if(!s.data.enabled&&!list.data.length)return false;
  container.innerHTML=`<section class="meal-cycle"><h1>${text('title')}</h1><p>${text(s.data.enabled?'choosePeriod':'paused')}</p>${list.data.map(c=>link(`/meals?cycle=${c.id}`,`${dateLabel(c.period_start)} – ${dateLabel(c.period_end)} · ${text(c.state==='finalized'?'confirmed':'myChoices')}`)).join('')}<div class="cycle-actions">${link('/meals?legacy=1',text('legacyMeals'))}${user?.role==='admin'?link('/settings/modules/kitchen',text('settings')):''}</div></section>`;renderKitchenTabsBar(container,'/meals');return true;
}
