import { api } from '/api.js';
import { deviceContext } from '/utils/device-context.js';
import { esc } from '/utils/html.js';
import { canCapability } from '/permissions.js';
import { openChildModal } from '/components/modal.js';
import { makeSortable } from '/utils/sortable.js';
import { zonedFields } from '/utils/timezone.js';
import { formatDate, formatTime } from '/i18n.js';

const names = { round_robin: 'Round Robin', rotating_order: 'Rotating Order', fixed_order: 'Fixed Order',
  preview: 'Provisional', resolved: 'Planned', finalized: 'Finalized', completed: 'Completed', skipped: 'Skipped' };
const directions = { first_to_last: 'First moves to last', last_to_first: 'Last moves to first' };
const directionExample = direction => `With 3 members, a person’s positions: ${direction==='last_to_first'?'1 → 2 → 3 → 1':'1 → 3 → 2 → 1'}.`;
const methodText = config => `${names[config.strategy]}${config.strategy==='rotating_order'?` · ${directions[config.direction||'first_to_last']}`:''}`;
const orderText = occurrence => occurrence?.order?.map(member => member.display_name).join(' → ') || 'No eligible member';
const trackLabel = track => track.display_label || track.label || track.purpose_key.replaceAll('_',' ');
const consumerStatus = track => ({previous:'Previous consumer · History retained',archived:'Archived consumer',inactive:'Inactive consumer',restricted:'Consumer details restricted'}[track.consumer_status]||'');
const button = (action, label, kind='secondary') => `<button type="button" class="btn btn--${kind}" data-rotation-${action}>${esc(label)}</button>`;
const errorBox = '<p role="alert" tabindex="-1" data-rotation-error hidden></p>';
const draftNotice = '<p data-rotation-draft-notice role="status" hidden></p>';
const isShared = group => group?.usage_mode === 'shared';
const weekdays = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const modeLabel = group => isShared(group)?'Shared across activities':'Independent per activity';
const dayText = days => days?.length===7?'Every day':(days||[]).map(day=>weekdays[day]?.slice(0,3)).join(', ')||'No days selected';
const orderList = (members=[], empty='No members yet') => members.length?`<ol class="rotation-order">${members.map(member=>`<li><span>${esc(member.display_name)}</span></li>`).join('')}</ol>`:`<p class="form-hint">${esc(empty)}</p>`;
const toggle = (name, label, checked, hint='') => `<label class="rotation-switch"><span class="rotation-switch__copy"><strong>${esc(label)}</strong>${hint?`<span class="form-hint">${esc(hint)}</span>`:''}</span><span class="toggle"><input name="${name}" type="checkbox" ${checked?'checked':''} aria-label="${esc(label)}"><span class="toggle__track" aria-hidden="true"></span></span></label>`;
const localDate = () => { const now=zonedFields(new Date());return `${now.year}-${String(now.month).padStart(2,'0')}-${String(now.day).padStart(2,'0')}`; };
const sharedConfig = group => { const value={ strategy:'rotating_order',direction:'first_to_last',starting_member_id:group?.members?.[0]?.id||null,
  effective_date:group?.household_today||localDate(),weekdays:[0,1,2,3,4,5,6],active_time:'17:00',finalize_time:'04:00',
  finalize_day_offset:1,advance_on_skip:false,eligibility:{},...(group?.shared_config||{}),...(group?.shared_config?.schedule||{}) };delete value.schedule;return value;};
function scheduleText(config={}) {
  return `${dayText(config.weekdays)} · ${formatTime(config.active_time)} – ${formatTime(config.finalize_time)}${config.finalize_day_offset?' next day':''}`;
}
function sharedFields(group) {
  const config=sharedConfig(group);
  return `<section class="rotation-section rotation-shared-editor" data-rotation-shared-fields ${isShared(group)?'':'hidden'} aria-label="Shared rotation schedule">
    <div class="rotation-section__heading"><h3>Shared rotation schedule</h3><p class="form-hint">Set the turns once. Every activity using this Group follows this schedule.</p></div>
    <div class="modal-grid modal-grid--2">
      <label class="form-label">Rotation method<select class="form-input" name="shared_strategy">${['round_robin','rotating_order','fixed_order'].map(value=>`<option value="${value}" ${config.strategy===value?'selected':''}>${names[value]}</option>`).join('')}</select></label>
      <label class="form-label" data-rotation-starting-field>Starting member<select class="form-input" name="shared_starting_member"><option value="">Choose a member</option>${(group?.members||[]).filter(member=>member.id).map(member=>`<option value="${member.id}" ${Number(config.starting_member_id)===member.id?'selected':''}>${esc(member.display_name)}</option>`).join('')}</select></label>
    </div>
    <p class="form-hint" data-rotation-method-help></p>
    <div data-rotation-direction-field ${config.strategy==='rotating_order'?'':'hidden'}>
      <label class="form-label">Rotation direction<select class="form-input" name="shared_direction">${Object.entries(directions).map(([value,label])=>`<option value="${value}" ${config.direction===value?'selected':''}>${label}</option>`).join('')}</select></label>
      <p class="form-hint" data-rotation-direction-preview role="status">${directionExample(config.direction)}</p>
    </div>
    <div class="rotation-preview"><span class="rotation-eyebrow">Starting preview</span><output data-rotation-shared-preview role="status" aria-live="polite"></output></div>
    <fieldset class="rotation-days"><legend>Scheduled evenings</legend><div class="rotation-weekdays">${weekdays.map((day,index)=>`<label class="rotation-weekday"><input type="checkbox" data-rotation-weekday value="${index}" aria-label="${day}" ${(config.weekdays||[]).includes(index)?'checked':''}><span aria-hidden="true">${day.slice(0,3)}</span></label>`).join('')}</div></fieldset>
    <div class="modal-grid modal-grid--2">
      <label class="form-label">Start this schedule on<input class="form-input" type="date" name="shared_effective_date" value="${esc(config.effective_date)}"></label>
      <label class="form-label">Evening starts at<input class="form-input" type="time" name="shared_active_time" value="${esc(config.active_time)}"></label>
      <label class="form-label"><span data-rotation-finalize-label>Move to the next turn at</span><input class="form-input" type="time" name="shared_finalize_time" value="${esc(config.finalize_time)}"></label>
      <label class="form-label">On which day?<select class="form-input" name="shared_finalize_day_offset"><option value="0" ${!config.finalize_day_offset?'selected':''}>The same evening</option><option value="1" ${config.finalize_day_offset?'selected':''}>The following day</option></select></label>
    </div>
    <p class="form-hint">Household time zone${group?.shared?.schedule?.timezone?`: ${esc(group.shared.schedule.timezone)}`:''}. An overnight period still belongs to the evening it started.</p>
    ${toggle('shared_advance_on_skip','Move to the next turn when skipped',config.advance_on_skip,'Off keeps the same turn after you skip an evening.')}
    <details class="rotation-explanation"><summary>How scheduled turns work</summary><p>Turns change once at the time above, even if someone is absent or their Task is unfinished. Fixed Order stays the same.</p><p>Skipping or changing an evening’s order may change future previews. History records the schedule, not proof an activity happened.</p></details>
  </section>`;
}
function errorAt(panel, error, field=null, {focus=true}={}) {
  const box=panel.querySelector('[data-rotation-error]');if(!box)return;box.hidden=false;box.textContent=error.message||String(error);
  if(!focus||panel.closest('.modal-overlay')?.inert)return;
  const target=field||box;target.scrollIntoView({block:'center'});target.focus();
}
function orderedRows(members) {
  return members.map(member=>`<li data-rotation-member="${member.id}" class="rotation-member">
    <button type="button" class="btn btn--ghost rotation-member-handle" aria-label="Reorder ${esc(member.display_name)}" title="Drag, or use Alt + Up/Down">⠿</button>
    <span class="rotation-member__name">${esc(member.display_name)}</span>
    <button type="button" class="btn btn--ghost btn--sm rotation-member__remove" data-rotation-remove aria-label="Remove ${esc(member.display_name)}">Remove</button></li>`).join('');
}
/** Shared handle-only pointer interaction and explicit keyboard alternative. */
function bindOrder(list, changed, { removable=true }={}) {
  // An explicit touch on the handle leaves the text editor before Sortable
  // creates its drag clone. Otherwise mobile input-focus scrolling can pull
  // a long modal back to the focused name field during an intentional drag.
  list.addEventListener('pointerdown',event=>{
    const handle=event.target.closest('.rotation-member-handle');
    if(handle&&event.pointerType==='touch')handle.focus({preventScroll:true});
  });
  const move=(row,direction)=>{
    const sibling=direction<0?row.previousElementSibling:row.nextElementSibling;if(!sibling)return;
    const focused=document.activeElement;
    if(direction<0)list.insertBefore(row,sibling);else list.insertBefore(sibling,row);
    focused?.focus();changed();
  };
  list.addEventListener('click',event=>{
    const row=event.target.closest('[data-rotation-member]');if(!row)return;
    if(removable&&event.target.closest('[data-rotation-remove]')){
      const next=row.nextElementSibling||row.previousElementSibling;
      row.remove();changed();
      (next?.querySelector('.rotation-member-handle')||list.parentElement.querySelector('[data-rotation-add-member]'))?.focus();
    }
  });
  list.addEventListener('keydown',event=>{
    if(event.altKey&&['ArrowUp','ArrowDown'].includes(event.key)&&event.target.closest('.rotation-member-handle')){
      event.preventDefault();move(event.target.closest('[data-rotation-member]'),event.key==='ArrowUp'?-1:1);
    }
  });
  if(!removable)list.querySelectorAll('[data-rotation-remove]').forEach(el=>el.remove());
  let disposed=false,sortable;
  makeSortable(list,{handle:'.rotation-member-handle',draggable:'[data-rotation-member]',onEnd:changed})
    .then(instance=>{if(disposed)instance?.destroy();else sortable=instance;}).catch(()=>{/* Keyboard actions remain available. */});
  return ()=>{disposed=true;sortable?.destroy();};
}
const memberIds=list=>[...list.querySelectorAll('[data-rotation-member]')].map(row=>Number(row.dataset.rotationMember));

async function editGroup(group,onSaved,live) {
  const {data:members}=await api.get('/automation/rotation-members');
  if(live&&!live.active())return;
  let modal,dispose;
  modal=openChildModal({title:group?'Edit Rotation Group':'New Rotation Group',size:'lg',content:`<form class="rotation-editor" data-rotation-group-form novalidate>
    ${errorBox}${draftNotice}
    <section class="rotation-section" aria-label="Group details">
    <label class="form-label">Group name<input class="form-input" name="name" maxlength="120" placeholder="e.g. Kids Shower Order" value="${esc(group?.name||'')}" required></label>
    <label class="form-label">Description <span class="form-label__hint">Optional</span><textarea class="form-input" name="description" maxlength="2000" rows="2" placeholder="What is this group used for?">${esc(group?.description||'')}</textarea></label>
    ${toggle('active','Active',group?.active!==0,'Turn off to stop new turns. History stays available.')}
    </section>
    <section class="rotation-section" aria-label="Members">
    <div class="rotation-section__heading"><h3>Members <span class="rotation-count" data-rotation-member-count>${group?.members.filter(m=>m.id).length||0}</span></h3><p class="form-hint">Choose who takes part and their starting order.</p></div>
    <input type="hidden" name="member_order" value="${esc(JSON.stringify(group?.members.map(m=>m.id)||[]))}">
    <ul class="rotation-members" data-rotation-member-list>${orderedRows(group?.members.filter(m=>m.id)||[])}</ul>
    <p class="rotation-empty" data-rotation-members-empty ${group?.members.some(m=>m.id)?'hidden':''}>No members yet. Choose someone below to start the order.</p>
    <label class="form-label">Add member<select class="form-input" data-rotation-add-member><option value="">Choose a household member</option>${members.map(m=>`<option value="${m.id}">${esc(m.display_name)}</option>`).join('')}</select></label>
    <p class="form-hint">Drag the dotted handle to reorder. Keyboard: focus the handle and press Alt + ↑ / ↓.</p>
    <p class="sr-only" role="status" aria-live="polite" data-rotation-order-status></p>
    </section>
    <section class="rotation-section" aria-label="How turns are used">
    <div class="rotation-section__heading"><h3>How turns are used</h3></div>
    <label class="form-label">Usage mode<select class="form-input" name="usage_mode"><option value="independent" ${!isShared(group)?'selected':''}>Independent per activity</option><option value="shared" ${isShared(group)?'selected':''}>Shared across activities</option></select></label>
    <p class="form-hint" data-rotation-usage-help>${isShared(group)?'All activities using this Group share the same order and rotation schedule.':'Each activity uses these members but maintains its own turns.'}</p>
    ${isShared(group)?`<label class="form-label" data-rotation-independent-date hidden>Independent turns effective from<input class="form-input" type="date" name="independent_effective_date" value="${esc(group.household_today||localDate())}"></label>`:''}
    </section>
    ${sharedFields(group)}
    <div class="modal-panel__footer">${button('cancel','Cancel','ghost')}<button class="btn btn--primary" type="submit">${group?'Save Group':'Create Group'}</button></div>
  </form>`,onSave(panel){
    const form=panel.querySelector('form'),list=panel.querySelector('[data-rotation-member-list]'),select=panel.querySelector('[data-rotation-add-member]');
    const sharedValue=()=>({ ...sharedConfig(group),strategy:form.elements.shared_strategy.value,direction:form.elements.shared_direction.value,
      starting_member_id:Number(form.elements.shared_starting_member.value)||null,effective_date:form.elements.shared_effective_date.value,
      weekdays:[...form.querySelectorAll('[data-rotation-weekday]:checked')].map(input=>Number(input.value)),
      active_time:form.elements.shared_active_time.value,finalize_time:form.elements.shared_finalize_time.value,
      finalize_day_offset:Number(form.elements.shared_finalize_day_offset.value),advance_on_skip:form.elements.shared_advance_on_skip.checked });
    const paintShared=()=>{
      const shared=form.elements.usage_mode.value==='shared';panel.querySelector('[data-rotation-shared-fields]').hidden=!shared;
      const independentDate=panel.querySelector('[data-rotation-independent-date]');if(independentDate)independentDate.hidden=shared;
      panel.querySelector('[data-rotation-usage-help]').textContent=shared?'All activities using this Group share the same order and rotation schedule.':'Each activity uses these members but maintains its own turns.';
      const ids=memberIds(list),starting=form.elements.shared_starting_member,previous=starting.value;
      starting.innerHTML='<option value="">Choose a member</option>'+ids.map(id=>`<option value="${id}">${esc(members.find(member=>member.id===id)?.display_name||'Former household member')}</option>`).join('');
      starting.value=ids.includes(Number(previous))?previous:String(ids[0]||'');
      const config=sharedValue(),pivot=Math.max(0,ids.indexOf(config.starting_member_id)),order=config.strategy==='fixed_order'?ids:[...ids.slice(pivot),...ids.slice(0,pivot)];
      const text=order.map(id=>members.find(member=>member.id===id)?.display_name||'Former household member');
      panel.querySelector('[data-rotation-shared-preview]').textContent=config.strategy==='round_robin'?text[0]||'Add members to preview the first turn.':text.join(' → ')||'Add members to preview the starting order.';
      panel.querySelector('[data-rotation-method-help]').textContent={round_robin:'Selects one person each turn. To give everyone a position, choose Rotating Order.',rotating_order:'Everyone gets a position; a different person goes first each evening.',fixed_order:'Everyone keeps the same position in the members list.'}[config.strategy];
      panel.querySelector('[data-rotation-finalize-label]').textContent=config.strategy==='fixed_order'?'Evening ends at':'Move to the next turn at';
      panel.querySelector('[data-rotation-starting-field]').hidden=config.strategy==='fixed_order';
      panel.querySelector('[data-rotation-direction-field]').hidden=config.strategy!=='rotating_order';
      panel.querySelector('[data-rotation-direction-preview]').textContent=directionExample(config.direction);
      form.elements.shared_advance_on_skip.closest('.rotation-switch').hidden=config.strategy==='fixed_order';
    };
    const sync=()=>{
      const ids=memberIds(list);form.elements.member_order.value=JSON.stringify(ids);
      panel.querySelector('[data-rotation-member-count]').textContent=ids.length;
      panel.querySelector('[data-rotation-members-empty]').hidden=ids.length>0;
      for(const option of select.options)option.disabled=ids.includes(Number(option.value));
      panel.querySelector('[data-rotation-order-status]').textContent=`Order: ${ids.map(id=>members.find(m=>m.id===id)?.display_name||'Former household member').join(', ')||'No members'}.`;
      paintShared();
      form.dispatchEvent(new Event('input',{bubbles:true}));
    };
    for(const option of select.options)option.disabled=memberIds(list).includes(Number(option.value));
    dispose=bindOrder(list,sync);
    form.addEventListener('change',event=>{if(event.target!==select)paintShared();});paintShared();
    select.addEventListener('change',()=>{
      const member=members.find(m=>m.id===Number(select.value));if(member&&!memberIds(list).includes(member.id))list.insertAdjacentHTML('beforeend',orderedRows([member]));
      select.value='';sync();
    });
    panel.querySelector('[data-rotation-cancel]').onclick=()=>modal.close();
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(form.dataset.saving)return;
      if(!form.elements.name.value.trim())return errorAt(panel,new Error('Enter a Rotation Group name.'),form.elements.name);
      if(!memberIds(list).length&&(!group||form.elements.active.checked))return errorAt(panel,new Error('Add at least one household member.'),select);
      const payload={name:form.elements.name.value,description:form.elements.description.value,active:form.elements.active.checked,
        member_ids:memberIds(list),...(group?{expected_revision:group.revision}:{})};
      const mode=form.elements.usage_mode.value;
      if(mode==='shared'||group?.usage_mode)payload.usage_mode=mode;
      if(mode==='independent'&&isShared(group))payload.effective_date=form.elements.independent_effective_date.value;
      if(mode==='shared') {
        payload.shared_config=sharedValue();
        for(const [field,message] of [['shared_effective_date','Choose when the shared schedule starts.'],['shared_active_time','Choose when each evening starts.'],['shared_finalize_time','Choose when each evening ends.']])if(!form.elements[field].value)return errorAt(panel,new Error(message),form.elements[field]);
        if(!payload.shared_config.weekdays.length)return errorAt(panel,new Error('Choose at least one scheduled evening.'),form.querySelector('[data-rotation-weekday]'));
        if(payload.active&&!payload.shared_config.starting_member_id)return errorAt(panel,new Error('Choose the starting member.'),form.elements.shared_starting_member);
        if(!payload.shared_config.finalize_day_offset&&payload.shared_config.finalize_time<=payload.shared_config.active_time)return errorAt(panel,new Error('The evening must end after it starts. Choose the following day for an overnight schedule.'),form.elements.shared_finalize_time);
      }
      const submit=panel.querySelector('[type=submit]');form.dataset.saving='true';submit.disabled=true;
      try{
        if(payload.active&&group&&(mode!==(group.usage_mode||'independent')||isShared(group)&&(JSON.stringify(payload.shared_config)!==JSON.stringify(sharedConfig(group))||JSON.stringify(payload.member_ids)!==JSON.stringify(group.members.map(member=>member.id))))) {
          const confirmed=await confirmUsageChange(group,payload,members);if(!confirmed)return;
          Object.assign(payload,confirmed);
        }
        const result=await(group?api.put(`/automation/rotation-groups/${group.id}`,payload):api.post('/automation/rotation-groups',payload));
        await modal.close({force:true});await onSaved(result.data);
      }catch(error){errorAt(panel,error);}finally{delete form.dataset.saving;submit.disabled=false;}
    });
  },onClose(){dispose?.();}});
}

async function confirmUsageChange(group,payload,members) {
  const {data:preview}=await api.post(`/automation/rotation-groups/${group.id}/usage-preview`,payload);
  return new Promise(resolve=>{
    let modal,accepted=false;
    const consumers=preview.consumers||[],reverse=payload.usage_mode==='independent';
    modal=openChildModal({title:'Apply rotation usage change',size:'lg',content:`<form class="rotation-editor" data-rotation-usage-confirm novalidate>${errorBox}
      <p>${reverse?'Each consumer will keep its own turns after this change. Choose its future starting member explicitly.':'All activities selecting this Group will join its shared schedule. Existing independent histories stay preserved.'}</p>
      <p><strong>Effective date:</strong> ${esc(preview.effective_date||payload.shared_config?.effective_date||'Next eligible occurrence')}</p>
      ${preview.proposed_order?`<p><strong>Proposed shared order:</strong> ${esc(orderText({order:preview.proposed_order}))}</p>`:''}
      ${!reverse&&payload.shared_config?.strategy==='rotating_order'?`<p><strong>Rotation direction:</strong> ${esc(directions[payload.shared_config.direction||'first_to_last'])}</p>`:''}
      <h3>Existing consumers</h3>${consumers.length?consumers.map((consumer,index)=>`<section class="rotation-history-item"><strong>${esc(consumer.display_label||consumer.label||consumer.purpose_key||'Restricted consumer')}</strong>
        <p>${esc(consumer.current_order?.map(member=>member.display_name).join(' → ')||(consumer.next_member_id?`Next: ${members.find(member=>member.id===consumer.next_member_id)?.display_name||'Former household member'}`:orderText(consumer.next||consumer.current)))}</p>
        ${reverse?`<label class="form-label">Future starting member<select class="form-input" data-rotation-independent-start="${index}" required><option value="">Choose explicitly</option>${members.filter(member=>payload.member_ids.includes(member.id)).map(member=>`<option value="${member.id}">${esc(member.display_name)}</option>`).join('')}</select></label>`:''}</section>`).join(''):'<p>No current consumer bindings.</p>'}
      ${(preview.exceptions||[]).length?`<h3>Bindings preserved as exceptions</h3><ul>${preview.exceptions.map(item=>`<li>${esc(typeof item==='string'?item:item.reason||item.message||'Existing activity cannot safely reconcile.')}</li>`).join('')}</ul>`:''}
      <p class="form-hint">Historical occurrences remain unchanged. Cancel returns to your complete edited draft.</p>
      ${toggle('confirm_usage','I understand who this change affects',false,'Apply the rotation settings from the effective date shown above.')}
      <div class="modal-panel__footer">${button('cancel','Cancel','ghost')}<button class="btn btn--primary" type="submit">Confirm and save</button></div>
    </form>`,onSave(panel){
      panel.querySelector('[data-rotation-cancel]').onclick=()=>modal.close({force:true});
      panel.querySelector('form').onsubmit=async event=>{
        event.preventDefault();const form=event.currentTarget;
        if(!form.elements.confirm_usage.checked)return errorAt(panel,new Error('Confirm that you understand who this change affects.'),form.elements.confirm_usage);
        const independent_starts=[];
        for(const select of form.querySelectorAll('[data-rotation-independent-start]')) {
          if(!select.value)return errorAt(panel,new Error('Choose the future starting member for each consumer.'),select);
          const consumer=consumers[Number(select.dataset.rotationIndependentStart)];
          independent_starts.push({consumer_type:consumer.consumer_type,consumer_id:consumer.consumer_id,purpose_key:consumer.purpose_key,next_member_id:Number(select.value)});
        }
        const submit=panel.querySelector('[type=submit]');if(submit.disabled)return;submit.disabled=true;
        try {
          let token=preview.confirmation_token;
          if(reverse) {
            const {data:confirmed}=await api.post(`/automation/rotation-groups/${group.id}/usage-preview`,{...payload,independent_starts});
            if(JSON.stringify(confirmed.consumers)!==JSON.stringify(preview.consumers)||JSON.stringify(confirmed.exceptions)!==JSON.stringify(preview.exceptions))throw new Error('Rotation consumers changed while you reviewed this. Cancel and preview the change again.');
            token=confirmed.confirmation_token;
          }
          accepted=true;await modal.close({force:true});resolve({confirmation_token:token,...(reverse?{independent_starts}:{})});
        }catch(error){errorAt(panel,error);}finally{submit.disabled=false;}
      };
    },onClose(){if(!accepted)resolve(null);}});
  });
}

async function changeOccurrence(occurrence,onSaved) {
  let modal,dispose;
  const isSingle=occurrence.strategy==='round_robin';
  const ordered=occurrence.order.length?occurrence.order:occurrence.eligible;
  const shared=Boolean(occurrence.period_date||occurrence.config?.shared_schedule||occurrence.shared);
  modal=openChildModal({title:shared?'Change this evening’s order':occurrence.order.length?'Override this occurrence':'Resolve this occurrence',content:`<form class="rotation-editor" data-rotation-override-form>${errorBox}${draftNotice}
    <p>Planned: ${esc(orderText({order:occurrence.original_order}))}</p><p class="form-hint">${shared?'Changes the shared order for every Activity using this Group for this evening.':'Changes this occurrence only.'} ${occurrence.config.override_affects_next?'Future advancement follows this effective planned result.':'Future advancement keeps the original plan.'}</p>
    ${isSingle?`<label class="form-label">Selected member<select class="form-input" name="member">${occurrence.eligible.map(m=>`<option value="${m.id}" ${m.id===occurrence.member_ids[0]?'selected':''}>${esc(m.display_name)}</option>`).join('')}</select></label>`:
      `<input type="hidden" name="member_order" value="${esc(JSON.stringify(ordered.map(m=>m.id)))}"><p class="form-hint">Drag the dotted handle, or focus it and press Alt + Up/Down.</p><ul class="rotation-members" data-rotation-member-list>${orderedRows(ordered)}</ul>`}
    <div class="modal-panel__footer">${button('cancel','Cancel','ghost')}<button class="btn btn--primary" type="submit">Apply override</button></div></form>`,onSave(panel){
      const form=panel.querySelector('form'),list=panel.querySelector('[data-rotation-member-list]');
      if(list)dispose=bindOrder(list,()=>{form.elements.member_order.value=JSON.stringify(memberIds(list));form.dispatchEvent(new Event('input',{bubbles:true}));},{removable:false});
      panel.querySelector('[data-rotation-cancel]').onclick=()=>modal.close();
      form.onsubmit=async event=>{event.preventDefault();const submit=panel.querySelector('[type=submit]');if(submit.disabled)return;submit.disabled=true;
        try{await api.post(`/automation/rotation-occurrences/${occurrence.id}/override`,{expected_revision:occurrence.revision,member_ids:isSingle?[Number(form.elements.member.value)]:memberIds(list)});
          await modal.close({force:true});await onSaved();}catch(error){errorAt(panel,error);}finally{submit.disabled=false;}};
    },onClose(){dispose?.();}});
}
function correctTrack(track,onSaved) {
  let modal;
  modal=openChildModal({title:track.consumer_type==='rotation_group_schedule'?'Set the next order':'Set who is next',content:`<form class="rotation-editor" data-rotation-correct-form>${errorBox}${draftNotice}
    <p>Changes future resolutions for ${esc(trackLabel(track))}. Historical occurrences stay unchanged.</p>
    <label class="form-label">Next member<select class="form-input" name="member">${track.next.members.filter(m=>m.id).map(m=>`<option value="${m.id}" ${m.membership_id===track.next_membership_id?'selected':''}>${esc(m.display_name)}</option>`).join('')}</select></label>
    <label class="form-label">Reason (optional)<textarea class="form-input" name="reason" maxlength="1000"></textarea></label>
    <div class="modal-panel__footer">${button('cancel','Cancel','ghost')}<button class="btn btn--primary" type="submit">Apply correction</button></div></form>`,onSave(panel){
    panel.querySelector('[data-rotation-cancel]').onclick=()=>modal.close();
    panel.querySelector('form').onsubmit=async event=>{event.preventDefault();const form=event.currentTarget,submit=panel.querySelector('[type=submit]');if(submit.disabled)return;submit.disabled=true;
      try{await api.post(`/automation/rotation-tracks/${track.id}/correct`,{expected_revision:track.revision,next_member_id:Number(form.elements.member.value),reason:form.elements.reason.value.trim()||null});
        await modal.close({force:true});await onSaved();}catch(error){errorAt(panel,error);}finally{submit.disabled=false;}};
  }});
}
/** Refresh read-only content in place. A child editor keeps its DOM, revision,
 * focus and dirty snapshot; a suspended parent paints only after it resumes. */
async function liveDetail(live,{load,title,render,onAction}) {
  let current=await load(),pending=current,request=0,closed=false,acting=false,unsubscribe,observer;
  if(!live.active())return;
  let modal;
  const apply=()=>{
    const panel=modal?.panel,overlay=panel?.closest('.modal-overlay');
    if(!pending||!panel?.isConnected||overlay.inert)return;
    const content=panel.querySelector('.modal-panel__body'),scroll=content.scrollTop;
    const expanded=[...content.querySelectorAll('details[open][data-rotation-explanation]')].map(el=>el.dataset.rotationExplanation);
    const focused=content.contains(document.activeElement)?document.activeElement:null;
    const focusAttributes=focused?[...focused.attributes].filter(a=>a.name.startsWith('data-rotation-')):[];
    const occurrence=focused?.closest('[data-rotation-occurrence]')?.dataset.rotationOccurrence;
    current=pending;pending=null;
    panel.querySelector('.modal-panel__title').textContent=title(current);
    content.innerHTML=render(current);
    for(const id of expanded)content.querySelector(`[data-rotation-explanation="${CSS.escape(id)}"]`)?.setAttribute('open','');
    if(focusAttributes.length){
      const scope=occurrence?content.querySelector(`[data-rotation-occurrence="${CSS.escape(occurrence)}"]`):content;
      scope?.querySelector(focusAttributes.map(a=>`[${a.name}="${CSS.escape(a.value)}"]`).join(''))?.focus({preventScroll:true});
    }
    content.scrollTop=scroll;
  };
  const refresh=async()=>{
    const ticket=++request;
    try{const value=await load();if(closed||!live.active()||ticket!==request)return;pending=value;apply();}
    catch(error){if(!closed&&live.active()&&ticket===request)errorAt(modal.panel,error,null,{focus:false});}
  };
  modal=openChildModal({title:title(current),size:'lg',content:render(current),onSave(panel){
    panel.addEventListener('click',async event=>{
      const action=event.target.closest('button');if(!action||action.disabled||acting)return;
      action.disabled=true;acting=true;
      try{await onAction(action,current,live.refresh);}catch(error){errorAt(panel,error);}finally{action.disabled=false;acting=false;}
    });
  },onClose(){closed=true;request++;unsubscribe?.();observer?.disconnect();}});
  pending=null;
  unsubscribe=live.watch(refresh,()=>{closed=true;request++;observer?.disconnect();});
  observer=new MutationObserver(apply);
  observer.observe(modal.panel.closest('.modal-overlay'),{attributes:true,attributeFilter:['inert']});
}
async function trackHistory(trackId,live) {
  return liveDetail(live,{
    load:async()=>{const [{data:track},{data:history,events=[]}]=await Promise.all([api.get(`/automation/rotation-tracks/${trackId}`),api.get(`/automation/rotation-tracks/${trackId}/history`)]);return {track,history,events};},
    title:({track})=>trackLabel(track),
    render:({track,history,events})=>`${errorBox}<div class="rotation-detail" data-rotation-track-detail="${track.id}">
    ${consumerStatus(track)?`<p class="form-hint" data-rotation-consumer-status>${esc(consumerStatus(track))}</p>`:''}
    <p class="rotation-badges"><span class="rotation-badge">${esc(methodText(track))}</span><span class="rotation-badge">${track.advance_count} advances</span></p>
    <section class="rotation-section"><div class="rotation-section__heading"><h3>Preview</h3><p class="form-hint">Next results after successive advances. Preview does not change anything.</p></div>
    <ol class="rotation-previews" data-rotation-previews>${track.previews.map((preview,index)=>`<li><span class="rotation-eyebrow">${index?'Then':'Next'}</span><span>${esc(orderText(preview))}</span></li>`).join('')}</ol>
    ${canCapability('rotations.correct')&&track.strategy!=='fixed_order'?button('correct',track.consumer_type==='rotation_group_schedule'?'Set the next order':'Set who is next'):''}
    </section><section class="rotation-section"><h3>History</h3>${events.length?`<div data-rotation-corrections><h4>Track corrections</h4><p class="form-hint">Administrative changes to future resolutions, separate from occurrence outcomes.</p>${events.map(event=>`<section class="rotation-history-item" data-rotation-correction="${event.id}"><strong>Next member corrected</strong><p>${esc(event.details.previous_next_member_name||'Previous next member')} → ${esc(event.details.next_member_name||track.next.members.find(member=>member.id===event.details.next_member_id)?.display_name||'Former household member')}</p><p class="form-hint">${esc(event.actor_name||'Former household member')} · ${esc(event.created_at)}</p>${event.details.reason?`<p>${esc(event.details.reason)}</p>`:''}</section>`).join('')}</div>`:''}
    ${history.length?history.map(occ=>`<section class="rotation-history-item" data-rotation-occurrence="${occ.id}">
      <div class="rotation-heading"><strong>${esc(occ.period_date?formatDate(occ.period_date):occ.context.label||formatDate(occ.context.due_date||occ.resolved_at.slice(0,10)))}</strong><span class="rotation-badge">${esc(names[occ.status])}${!occ.order.length?' · Unresolved':''}</span></div>
      <p>${esc(orderText(occ))}</p>${occ.overridden_at?`<p class="form-hint">Original plan: ${esc(orderText({order:occ.original_order}))} · Overridden ${esc(occ.overridden_at)}</p>`:''}
      <p class="form-hint">${occ.advanced?'Advanced once':`No advance${occ.advance_reason?': '+occ.advance_reason.replaceAll('_',' '):''}`}</p>
      ${occ.skipped.length?`<details data-rotation-explanation="${occ.id}"><summary data-rotation-explanation-toggle="${occ.id}">Eligibility explanation</summary><ul>${occ.skipped.map(m=>`<li>${esc(m.display_name)}: ${esc(m.reason)}</li>`).join('')}</ul></details>`:''}
      ${occ.status==='resolved'&&canCapability('rotations.override')?`${occ.eligible.length?button('override',occ.period_date?'Change this evening’s order':occ.order.length?'Override':'Resolve with eligible members'):''}${!occ.order.length?button('recheck','Recheck eligibility'):''}`:''}
      ${occ.status==='resolved'&&canCapability('rotations.advance')?`${occ.order.length&&!occ.period_date?button('finalize','Finalize'):''}${button('skip',occ.period_date?'Skip this evening':'Skip')}`:''}
      ${!occ.period_date&&occ.config.advance_policy==='manual'&&!occ.advanced&&occ.order.length&&occ.status!=='skipped'&&canCapability('rotations.advance')?button('advance','Advance once'):''}
    </section>`).join(''):'<p class="rotation-empty">No occurrences yet.</p>'}</section></div>`,
    onAction:async(action,{track,history},reload)=>{
        if(action.hasAttribute('data-rotation-correct'))return correctTrack(track,reload);
        const section=action.closest('[data-rotation-occurrence]');if(!section)return;
        const occ=history.find(o=>o.id===Number(section.dataset.rotationOccurrence));
        if(action.hasAttribute('data-rotation-override'))return changeOccurrence(occ,reload);
        const verb=['finalize','skip','advance','recheck'].find(key=>action.hasAttribute(`data-rotation-${key}`));if(!verb)return;
        await api.post(`/automation/rotation-occurrences/${occ.id}/${verb==='advance'?'finalize':verb}`,{expected_revision:occ.revision,...(verb==='advance'?{manual:true,outcome:occ.status==='resolved'?'finalized':occ.status}:{})});await reload();
    }
  });
}
async function groupDetail(groupId,live) {
  return liveDetail(live,{
    load:async()=>(await api.get(`/automation/rotation-groups/${groupId}`)).data,
    title:group=>group.name,
    render:group=>`${errorBox}<div class="rotation-detail" data-rotation-group-detail="${group.id}">
      <div class="rotation-heading"><div class="rotation-badges"><span class="rotation-badge rotation-badge--mode">${modeLabel(group)}</span><span class="rotation-badge">${group.active?'Active':'Inactive'}</span></div>${canCapability('rotations.manage')?button('edit','Edit Group'):''}</div>
      ${group.description?`<p class="rotation-description">${esc(group.description)}</p>`:''}
      ${!isShared(group)&&group.usage_effective_date?`<p class="form-hint">Effective from ${esc(formatDate(group.usage_effective_date))}</p>`:''}
      <section class="rotation-section"><div class="rotation-section__heading"><h3>Members <span class="rotation-count">${group.members.length}</span></h3><p class="form-hint">Baseline order${isShared(group)?' · Current turns follow the shared schedule.':'. Each activity keeps its own turns.'}</p></div>${orderList(group.members)}</section>
      ${isShared(group)?sharedState(group):''}
      <section class="rotation-section"><div class="rotation-section__heading"><h3>Used by</h3><p class="form-hint">Activities and other routines using this group.</p></div>
      ${group.tracks.length?group.tracks.map(track=>`<section class="rotation-usage" data-rotation-usage="${track.id}"><div><strong>${esc(trackLabel(track))}</strong>
        ${consumerStatus(track)?`<p class="form-hint" data-rotation-consumer-status>${esc(consumerStatus(track))}</p>`:''}
        <p class="form-hint">${esc(methodText(track))} · Next: ${esc(orderText(track.next))}</p></div>
        ${canCapability('rotations.history')?`<button type="button" class="btn btn--secondary btn--sm" data-rotation-history="${track.id}">History and controls</button>`:''}</section>`).join(''):'<p class="rotation-empty">Not used yet. Choose this group in an Activity, Workflow or Meal Plan to get started.</p>'}</section></div>`,
    onAction:async(action,group,reload)=>{
      if(action.hasAttribute('data-rotation-edit'))return editGroup(group,reload,live);
      if(action.hasAttribute('data-rotation-history'))return trackHistory(action.dataset.rotationHistory,live);
      if(action.hasAttribute('data-rotation-shared-override'))return changeOccurrence(group.shared.current,reload);
      if(action.hasAttribute('data-rotation-shared-skip')) {
        await api.post(`/automation/rotation-occurrences/${group.shared.current.id}/skip`,{expected_revision:group.shared.current.revision});await reload();
      }
    }
  });
}

function sharedState(group) {
  const config=sharedConfig(group),current=group.shared?.current;
  return `<section class="rotation-section" data-rotation-shared-state>
    <div class="rotation-section__heading"><h3>Shared schedule</h3><p class="form-hint">${esc(names[config.strategy])} · ${esc(dayText(config.weekdays))}</p></div>
    <dl class="rotation-summary-grid">
      <div><dt>Evening starts</dt><dd>${esc(formatTime(config.active_time))}</dd></div>
      <div><dt>${config.strategy==='fixed_order'?'Evening ends':'Moves to next turn'}</dt><dd>${esc(formatTime(config.finalize_time))}<span>${config.finalize_day_offset?'Following day':'Same evening'}</span></dd></div>
      <div><dt>Effective from</dt><dd>${esc(formatDate(config.effective_date))}</dd></div>
      <div><dt>When skipped</dt><dd>${config.strategy==='fixed_order'?'Keeps fixed order':config.advance_on_skip?'Advances to next turn':'Keeps the same turn'}</dd></div>
      ${config.strategy==='rotating_order'?`<div><dt>Rotation direction</dt><dd>${esc(directions[config.direction])}</dd></div>`:''}
    </dl>
    <p class="form-hint">Household time zone${group.shared?.schedule?.timezone?`: ${esc(group.shared.schedule.timezone)}`:''}. Individual completion and absence do not advance this rotation.</p>
    <div class="rotation-periods">
      <div class="rotation-preview"><span class="rotation-eyebrow">Current evening${current?` · ${esc(formatDate(current.period_date))}`:''}</span>${current?`${orderList(current.order,'No eligible member')}<span class="rotation-badge">${esc(names[current.status]||current.status)}</span>`:'<p>No active period</p>'}</div>
      <div class="rotation-preview"><span class="rotation-eyebrow">Next${group.shared?.next?.period_date?` · ${esc(formatDate(group.shared.next.period_date))}`:''}</span>${orderList(group.shared?.next?.order,'No eligible member')}<p class="form-hint">Preview · confirmed when the evening starts</p></div>
    </div>
    <div class="rotation-actions">
      ${current?.status==='resolved'&&canCapability('rotations.override')?button('shared-override','Change this evening’s order'):''}
      ${current?.status==='resolved'&&canCapability('rotations.advance')?button('shared-skip','Skip this evening'):''}
      ${group.shared?.track_id&&canCapability('rotations.history')?`<button type="button" class="btn btn--secondary" data-rotation-history="${group.shared.track_id}">Shared history and controls</button>`:''}
    </div>
  </section>`;
}

/** Open management above a consumer draft, without replacing that draft. */
export async function openRotationGroup(groupId,{onChanged}={}) {
  let closed=false,source;const views=new Set();
  const live={active:()=>!closed,refresh:async()=>{await Promise.all([...views].map(refresh=>refresh()));await onChanged?.();},
    watch(refresh){views.add(refresh);return ()=>{views.delete(refresh);if(!views.size){closed=true;source?.close();}};}};
  if(typeof EventSource!=='undefined') {
    source=new EventSource(`/api/v1/automation/rotation-changes${deviceContext()?`?context=${encodeURIComponent(deviceContext())}`:''}`);
    source.addEventListener('change',()=>{if(!closed)void live.refresh();});
  }
  try{return await groupDetail(groupId,live);}catch(error){closed=true;source?.close();throw error;}
}

/** Household Automation resource view; live invalidation never replaces an edited draft. */
export async function renderRotationGroups(body) {
  body.rotationDispose?.();let disposed=false,request=0,source,observer;
  const views=new Map();
  const live={active:()=>!disposed&&body.isConnected,watch(fn,cleanup){views.set(fn,cleanup);return ()=>views.delete(fn);},
    refresh:()=>Promise.all([refresh(),...[...views.keys()].map(fn=>fn())])};
  const dispose=()=>{disposed=true;request++;source?.close();observer?.disconnect();for(const cleanup of views.values())cleanup?.();views.clear();};
  body.rotationDispose=dispose;
  const refresh=async()=>{
    const ticket=++request;
    try{const {data:groups}=await api.get('/automation/rotation-groups?include_inactive=1');if(disposed||ticket!==request)return;
      body.innerHTML=`<div class="rotation-groups"><div class="rotation-heading rotation-heading--intro"><div><h3>Rotation Groups</h3><p class="form-hint">Set who takes part and in what order. Keep turns independent or share a schedule across activities.</p></div>${canCapability('rotations.manage')?button('create','New Rotation Group','primary'):''}</div>${errorBox}
        <div class="rotation-group-list">${groups.length?groups.map(group=>`<button type="button" class="rotation-group-card" data-rotation-open="${group.id}">
          <span class="rotation-group-card__heading"><strong>${esc(group.name)}</strong><span class="rotation-badges"><span class="rotation-badge rotation-badge--mode">${modeLabel(group)}</span>${group.active?'':'<span class="rotation-badge">Inactive</span>'}</span><span class="rotation-group-card__chevron" aria-hidden="true">›</span></span>
          ${group.description?`<span class="rotation-group-card__description">${esc(group.description)}</span>`:''}
          <span class="rotation-group-card__members">${group.members.length?group.members.map((m,index)=>`<span class="rotation-member-chip"><span aria-hidden="true">${index+1}</span>${esc(m.display_name)}</span>`).join(''):'No current members'}</span>
          <span class="form-hint">${isShared(group)&&group.shared_config?`${esc(methodText(group.shared_config))} · ${esc(scheduleText(sharedConfig(group)))}`:`${group.members.length} member${group.members.length===1?'':'s'}`}${group.usage_effective_date?` · Effective from ${esc(formatDate(group.usage_effective_date))}`:''}</span></button>`).join(''):'<div class="rotation-empty"><strong>No Rotation Groups yet</strong><p>Create a group to organize household turns for activities, meals, and more.</p></div>'}</div></div>`;
      body.querySelector('[data-rotation-create]')?.addEventListener('click',async event=>{
        const control=event.currentTarget;control.disabled=true;
        try{await editGroup(null,live.refresh,live);}catch(error){if(!disposed)errorAt(body,error);}finally{control.disabled=false;}
      });
      body.querySelectorAll('[data-rotation-open]').forEach(control=>control.addEventListener('click',async()=>{
        control.disabled=true;
        try{await groupDetail(control.dataset.rotationOpen,live);}catch(error){if(!disposed)errorAt(body,error);}finally{control.disabled=false;}
      }));
    }catch(error){if(!disposed&&ticket===request){body.innerHTML=errorBox;errorAt(body,error,null,{focus:false});}}
  };
  await refresh();
  if(!live.active())return;
  let version=null;
  if(typeof EventSource!=='undefined'){
    source=new EventSource(`/api/v1/automation/rotation-changes${deviceContext()?`?context=${encodeURIComponent(deviceContext())}`:''}`);
    source.addEventListener('change',event=>{
      let next;try{next=JSON.parse(event.data).version;}catch{return;}
      if(disposed||version===next)return;const initial=version===null;version=next;
      if(!initial)document.querySelectorAll('[data-rotation-draft-notice]').forEach(el=>{el.hidden=false;el.textContent='Rotation data changed elsewhere. Your draft is preserved; saving checks its revision.';});
      // The initial version also closes the window between the list fetch and stream connection.
      void live.refresh();
    });
  }
  observer=new MutationObserver(()=>{if(!body.isConnected)dispose();});observer.observe(document.body,{childList:true,subtree:true});
}
