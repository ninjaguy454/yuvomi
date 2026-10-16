import {api} from '/api.js';
import {openChildModal} from '/components/modal.js';
import {renderRuntimeQuestion,collectRuntimeInputs} from '/components/activity-automation.js';
import {memberLabel} from '/utils/member-label.js';
import {esc} from '/utils/html.js';
import {authenticationSnapshot,sameAuthentication} from '/utils/device-context.js';
import {launchAttemptStore} from '/utils/template-launch-attempt.js';

const h=value=>esc(String(value??''));
const replace=(node,html)=>{node.replaceChildren();node.insertAdjacentHTML('afterbegin',html);};
export async function openTemplatePeopleLauncher({onCreated=null}={}){
  try{
    const response=await api.get('/automation/activity-options'),context=authenticationSnapshot();
    const {activities=[],members=[],places=[],launch_actor_id:actor}=response.data;
    let storage;try{storage=window.sessionStorage;}catch{storage=null;}
    const attempts=launchAttemptStore(storage,`${actor}:${context.context||'personal'}`);
    let pending=attempts.load(),preview=null,previewBody=null,busy=false,child;
    child=openChildModal({title:'Create Activities for people',size:'lg',content:`
      <form id="template-people-form">
        <fieldset id="template-people-fields" style="border:0;padding:0;min-width:0">
          <label class="label" for="template-people-template">Activity Template</label>
          <select class="input" id="template-people-template" required><option value="">Choose a template</option>${activities.map(a=>`<option value="${a.id}">${h(a.name)}</option>`).join('')}</select>
          <p class="form-hint" id="template-people-mode">Choose a saved template, then select people and preview.</p>
          <fieldset class="form-group" style="border:0;padding:0;min-width:0"><legend class="label">People</legend>${members.map(member=>`<label class="checkbox-label" style="display:flex;align-items:center;gap:8px;min-height:44px"><input type="checkbox" name="recipient" value="${member.id}"> ${h(memberLabel(member))}</label>`).join('')}</fieldset>
          <div id="template-people-primary-row" hidden><label class="label" for="template-people-primary">Primary person</label><select class="input" id="template-people-primary"><option value="">Choose a primary person</option></select><p class="form-hint">Template text and existing primary-owner behavior use this person. The other people are co-assignees.</p></div>
          <label class="label" for="template-people-start">Start Date</label><input class="input" type="date" id="template-people-start" required>
          <div id="template-people-inputs"></div>
        </fieldset>
        <p id="template-people-error" class="form-error" role="alert" hidden></p>
        <div id="template-people-preview" aria-live="polite"></div>
        <div class="modal-footer"><button type="button" class="btn btn--secondary" id="template-people-close">Close</button><button type="submit" class="btn btn--primary" id="template-people-submit">Preview</button></div>
      </form>`,onSave(panel){
        const form=panel.querySelector('#template-people-form'),fields=panel.querySelector('#template-people-fields'),select=panel.querySelector('#template-people-template'),primary=panel.querySelector('#template-people-primary'),output=panel.querySelector('#template-people-preview'),error=panel.querySelector('#template-people-error'),submit=panel.querySelector('#template-people-submit');
        const selected=()=>activities.find(row=>Number(row.id)===Number(select.value));
        const people=()=>[...form.querySelectorAll('[name="recipient"]:checked')].map(row=>Number(row.value));
        const showError=message=>{error.textContent=message;error.hidden=!message;};
        const syncPrimary=()=>{
          const previous=primary.value,ids=people();replace(primary,'<option value="">Choose a primary person</option>'+members.filter(row=>ids.includes(Number(row.id))).map(row=>`<option value="${row.id}">${h(memberLabel(row))}</option>`).join(''));primary.value=previous;
        };
        const invalidate=()=>{if(pending)return;preview=null;previewBody=null;output.replaceChildren();submit.textContent='Preview';showError('');syncPrimary();};
        const renderTemplate=()=>{
          const template=selected(),individual=template?.category_max_assignees===1;
          panel.querySelector('#template-people-mode').textContent=template?(individual?'One individual Activity will be created for each selected person.':`One shared Activity will be created for the selected people.${template.category_max_assignees==null?'':` This category allows up to ${template.category_max_assignees} direct assignees.`}`):'Choose a saved template, then select people and preview.';
          panel.querySelector('#template-people-primary-row').hidden=!template||individual;primary.required=!!template&&!individual;
          replace(panel.querySelector('#template-people-inputs'),(template?.input_schema||[]).map(question=>renderRuntimeQuestion(question,members,places)).join(''));
          for(const question of template?.input_schema||[]){const field=[...form.querySelectorAll('[data-runtime-input]')].find(el=>el.dataset.runtimeInput===(question.id??question.key));if(field&&question.default_value!=null){if(field.multiple)for(const option of field.options)option.selected=question.default_value.includes(Number(option.value));else field.value=String(question.default_value);}}
          invalidate();
        };
        const showPending=()=>{
          fields.disabled=true;submit.textContent='Retry to confirm creation';
          replace(output,'<p class="form-hint">A creation attempt is awaiting confirmation. Retry confirms the same request and will not create duplicates.</p>');
        };
        form.addEventListener('input',invalidate);form.addEventListener('change',event=>{if(event.target===select)renderTemplate();else invalidate();});
        panel.querySelector('#template-people-close').addEventListener('click',()=>child.close({force:true}));
        form.addEventListener('submit',async event=>{
          event.preventDefault();if(busy||!sameAuthentication(context))return;
          const wasPending=!!pending;
          showError('');busy=true;submit.disabled=true;
          try{
            if(pending||preview){
              if(!pending){const candidate={...previewBody,request_key:crypto.randomUUID()};attempts.save(candidate);pending=candidate;}
              showPending();
              const attempt=pending,result=await api.post('/tasks/template-launch/create',attempt,{requireFresh:true});
              attempts.clear(attempt.request_key);pending=null;await child.close({force:true});await onCreated?.(result.data);return;
            }
            const template=selected();if(!template)throw Error('Choose an Activity Template.');
            const ids=people();if(!ids.length)throw Error('Choose at least one person.');
            const body={activity_template_id:Number(template.id),recipient_user_ids:ids,mode:template.category_max_assignees===1?'individual':'shared',start_date:panel.querySelector('#template-people-start').value,inputs:collectRuntimeInputs(form)};
            if(body.mode==='shared')body.primary_user_id=Number(primary.value);
            const signature=JSON.stringify(body),result=await api.post('/tasks/template-launch/preview',body,{requireFresh:true});
            if(!form.isConnected||!sameAuthentication(context))return;
            const current={...body,recipient_user_ids:people(),start_date:panel.querySelector('#template-people-start').value,inputs:collectRuntimeInputs(form),...(body.mode==='shared'?{primary_user_id:Number(primary.value)}:{})};
            if(Number(select.value)!==body.activity_template_id||JSON.stringify(current)!==signature)throw Error('Your choices changed. Preview the latest selection.');
            preview=result.data;previewBody=body;
            replace(output,`<p><strong>${preview.task_count} ${preview.task_count===1?'Activity':'Activities'} will be created.</strong></p><ol>${preview.activities.map(row=>`<li><strong>${h(row.title)}</strong><p class="form-hint">${h(row.recipient_user_ids.map(id=>memberLabel(members.find(m=>Number(m.id)===id))).join(', '))}${row.is_recurring?' · Repeats':''} · ${row.checklist.length} checklist steps · ${h(row.scoring_mode||'Existing')} scoring</p></li>`).join('')}</ol>`);
            submit.textContent=`Create ${preview.task_count} ${preview.task_count===1?'Activity':'Activities'}`;
          }catch(cause){
            // A rejected replay does not prove the earlier attempt failed.
            // Retain its key through revoked permissions and later restoration.
            if(pending&&!wasPending&&cause.outcome==='rejected'&&![409,410].includes(cause.status)){attempts.clear(pending.request_key);pending=null;fields.disabled=false;invalidate();}
            if(pending)showPending();showError(cause.message||'Could not create Activities.');
            if(pending&&cause.status===410){
              const note=document.createElement('p');note.className='form-hint';note.textContent='Some Activities from the earlier launch may still exist. Starting a separate launch will preserve them.';output.append(note);
              const restart=document.createElement('button');restart.type='button';restart.className='btn btn--secondary';restart.id='template-people-separate';restart.textContent='Start a separate launch';
              restart.addEventListener('click',()=>{attempts.clear(pending.request_key);pending=null;fields.disabled=false;invalidate();});output.append(restart);
            }
          }finally{busy=false;submit.disabled=false;}
        });
        if(pending)showPending();
      }});
  }catch(error){window.yuvomi?.showToast?.(error.message||'Could not load Activity Templates.','danger');}
}
