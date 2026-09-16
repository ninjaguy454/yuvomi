import { api } from '/api.js';
import { esc } from '/utils/html.js';
import { openModal, closeModal } from '/components/modal.js';
import { rewardRequest, pendingPointAdjustment } from '/utils/reward-request.js';

/** An append-only correction; never edit the award or redemption it refers to. */
export function openPointAdjustment({actorId,members,reference=null,onSaved=()=>{}}) {
  const restored=pendingPointAdjustment(actorId);
  if(!members.length&&!restored)return;
  const option=(id,label,selected)=>`<option value="${id}"${String(id)===String(selected)?' selected':''}>${esc(label)}</option>`;
  openModal({title:'Adjust points',content:`<form id="rw-adjustment-form" novalidate>
    <div class="form-group"><label class="label" for="rw-adjust-member">Member</label><select class="input" id="rw-adjust-member">${members.map(m=>option(m.id,`${m.display_name} · ${m.balance} points`,reference?.user_id)).join('')}</select></div>
    <div class="form-group"><label class="label" for="rw-adjust-points">Points to add or remove</label><input class="input" id="rw-adjust-points" type="text" inputmode="text" autocomplete="off" placeholder="+5 or -5" required><p class="rw-hint">Use a positive number to add points or a negative number to remove them.</p></div>
    <div class="form-group"><label class="label" for="rw-adjust-reason">Reason (required)</label><input class="input" id="rw-adjust-reason" maxlength="200" required placeholder="Explain why these points are being added or removed"></div>
    <p class="rw-hint">This adds an adjustment to history. Existing awards and redemptions stay unchanged.</p>
    <p class="rw-hint" id="rw-adjust-preview" aria-live="polite"></p>
    <details${reference?' open':''}><summary>Related records (optional)</summary>
      <div class="form-group"><label class="label" for="rw-adjust-task">Related Task</label><select class="input" id="rw-adjust-task"><option value="">None</option>${reference?.task_id?option(reference.task_id,`Task #${reference.task_id}`,reference.task_id):''}</select></div>
      <div class="form-group"><label class="label" for="rw-adjust-reward">Related Reward</label><select class="input" id="rw-adjust-reward"><option value="">None</option></select></div>
      <div class="form-group"><label class="label" for="rw-adjust-ledger">Related ledger entry</label><select class="input" id="rw-adjust-ledger"><option value="">None</option>${reference?option(reference.id,`#${reference.id} · ${reference.reason||reference.type}`,reference.id):''}</select></div>
    </details>
    <p id="rw-adjust-error" class="form-error" role="alert" hidden></p>
    <div class="modal-panel__footer modal-panel__footer--plain"><button type="submit" class="btn btn--primary" id="rw-adjust-submit">Save adjustment</button></div>
  </form>`,onSave(panel){
    let pending=restored ? {body:Object.freeze(restored.body),request:rewardRequest(actorId,{...restored.body,operation:'adjustment'}),uncertain:true} : null;
    const memberInput=panel.querySelector('#rw-adjust-member'),pointsInput=panel.querySelector('#rw-adjust-points');
    const ledgerInput=panel.querySelector('#rw-adjust-ledger');
    const error=message=>{const el=panel.querySelector('#rw-adjust-error');el.textContent=message;el.hidden=false;};
    const freeze=locked=>panel.querySelectorAll('input,select').forEach(input=>input.disabled=locked);
    const preview=()=>{const member=members.find(m=>m.id===Number(memberInput.value)),delta=Number(pointsInput.value);panel.querySelector('#rw-adjust-preview').textContent=pending?`Confirming the original ${pending.body.delta>0?'+':''}${pending.body.delta}-point adjustment. Retrying does not create another adjustment.`:member&&Number.isSafeInteger(delta)&&delta!==0?`${member.display_name}: ${member.balance} → ${member.balance+delta} points`:'';};
    if(pending){
      for(const [id,value]of [['member',pending.body.user_id],['points',pending.body.delta],['reason',pending.body.reason],['task',pending.body.related_task_id],['reward',pending.body.related_reward_id],['ledger',pending.body.related_ledger_id]]){
        const input=panel.querySelector(`#rw-adjust-${id}`);
        if(input.tagName==='SELECT'&&value&&!Array.from(input.options).some(option=>option.value===String(value)))input.insertAdjacentHTML('beforeend',option(value,`Saved reference #${value}`,value));
        input.value=value??'';
      }
      freeze(true);preview();panel.querySelector('#rw-adjust-submit').textContent='Confirm pending adjustment';
      error('A previous adjustment still needs confirmation. Retry it before starting another adjustment.');
    }
    pointsInput.addEventListener('input',preview);
    let referenceLoad=0;
    const loadLedger=async()=>{
      const generation=++referenceLoad,memberId=Number(memberInput.value),selected=ledgerInput.value;
      try{const result=await api.get(`/rewards/ledger?user_id=${memberId}&limit=500`);
        if(!panel.isConnected||generation!==referenceLoad)return;
        const rows=result.data||[];
        ledgerInput.innerHTML='<option value="">None</option>'+rows.map(row=>option(row.id,`#${row.id} · ${row.delta>0?'+':''}${row.delta} · ${row.reason||row.type}`,selected)).join('');
        if(selected&&!rows.some(row=>String(row.id)===selected))ledgerInput.insertAdjacentHTML('beforeend',option(selected,`Ledger entry #${selected}`,selected));
      }catch{/* Linking is optional; preserve a selected known record. */}
    };
    memberInput.addEventListener('change',()=>{ledgerInput.value='';preview();void loadLedger();});
    void loadLedger();
    api.get('/rewards/adjustment-options').then(result=>{
      if(!panel.isConnected)return;
      for(const [selector,rows,label]of [['#rw-adjust-task',result.data?.tasks,'title'],['#rw-adjust-reward',result.data?.rewards,'name']]){
        const input=panel.querySelector(selector),selected=input.value,options=rows||[];
        input.innerHTML='<option value="">None</option>'+options.map(row=>option(row.id,`${row[label]} (#${row.id})`,selected)).join('');
        if(selected&&!options.some(row=>String(row.id)===selected))input.insertAdjacentHTML('beforeend',option(selected,`Task #${selected}`,selected));
      }
    }).catch(()=>{});
    panel.querySelector('form').addEventListener('submit',async event=>{
      event.preventDefault();const submit=panel.querySelector('#rw-adjust-submit');if(submit.disabled)return;
      const delta=pending?.body.delta??Number(pointsInput.value),reason=pending?.body.reason??panel.querySelector('#rw-adjust-reason').value.trim();
      if(!Number.isSafeInteger(delta)||delta===0||Math.abs(delta)>1_000_000){error('Enter a non-zero whole number between -1,000,000 and 1,000,000.');return;}
      if(!reason){error('A reason is required for every points adjustment.');return;}
      const body=pending?.body||{user_id:Number(memberInput.value),delta,reason,
        related_task_id:Number(panel.querySelector('#rw-adjust-task').value)||null,
        related_reward_id:Number(panel.querySelector('#rw-adjust-reward').value)||null,
        related_ledger_id:Number(ledgerInput.value)||null};
      if(!pending)pending={body:Object.freeze(body),request:rewardRequest(actorId,{...body,operation:'adjustment'}),uncertain:false};
      const {request}=pending;
      freeze(true);preview();
      submit.disabled=true;panel.querySelector('#rw-adjust-error').hidden=true;
      try{await api.post('/rewards/adjustments',body,{headers:{'Idempotency-Key':request.key}});}catch(err){
        // Only an initial, definite rejection proves no adjustment committed.
        // After a lost response, even a later permission error cannot disprove
        // the first commit; retain its immutable snapshot and key until resolved.
        const definite=!pending.uncertain&&[400,403,404,422,428].includes(err.status);
        if(definite){request.finish();pending=null;freeze(false);submit.textContent='Save adjustment';preview();error(err.message);}
        else {pending.uncertain=true;submit.textContent='Confirm pending adjustment';error(`${err.message} Retry this unchanged adjustment to confirm its result before starting another.`);}
        submit.disabled=false;
        return;
      }
      request.finish();await closeModal({force:true});window.yuvomi?.showToast('Points adjustment recorded.','success');await onSaved();
    });
  }});
}
