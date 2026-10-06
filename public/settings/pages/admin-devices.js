import { deviceConfigContent } from './admin-device-config.js';
import { api } from '/api.js';
import { esc } from '/utils/html.js';
import { openModal, closeModal, confirmModal } from '/components/modal.js';

const modules=['tasks','calendar','meals','shopping','rewards'];
const noteActions={view:'View notes',create:'Create notes',edit:'Edit content, checklist and Dashboard visibility',delete:'Delete notes'};
const actions={complete:'Complete existing independent steps',reopen:'Reopen completed steps',reset:'Reset existing progress',claim:'Accept eligible unassigned Tasks for an explicit member',accept_with_helpers:'Add co-assignees and allocate unassigned subtasks during initial acceptance (requires Claim; does not grant reassignment)'};
const definitions={'tasks.create':'Create plain Tasks','tasks.edit_others':'Edit plain Task titles and descriptions','tasks.change_assignment':'Choose a Task assignee','tasks.reassign':'Reassign existing Tasks','tasks.change_dates':'Change Start and Due windows','tasks.change_points':'Set or change Task point values'};
export async function render(container) {
  let model, disposed=false;
  const styles=['/styles/device.css','/styles/admin-device-config.css'].map(href=>{const link=document.createElement('link');link.rel='stylesheet';link.href=href;document.head.append(link);return link;});
  const error=message=>{const target=container.querySelector('[data-devices-error]');if(target)target.textContent=message;};
  async function refresh(){
    try{
      model=await api.get('/devices');if(disposed)return;
      const devices=model.data || [];
      container.innerHTML=`<section class="settings-section"><h2>Household Devices</h2><p>Pair a shared display with its own permissions and preferences. Devices are not household members and never receive points.</p><p>Anyone using a display can complete the permitted Tasks shown there. Supervised work can request authenticated approval on the Task board. Full temporary personal sign-in remains available for rewards redemption and administration.</p><button type="button" class="btn btn--primary" data-device-approve>Approve pairing code</button><a href="/device/pair" data-link class="btn btn--secondary">Pair this browser as a device</a><p role="alert" data-devices-error></p><div>${devices.length?devices.map(device=>`<article class="settings-card"><h3>${esc(device.name)}</h3><p>${esc(device.status)} · Last connection: ${esc(device.last_seen_at || 'Not connected yet')}</p><button type="button" class="btn btn--secondary" data-device-edit="${device.id}">Configure</button><button type="button" class="btn btn--secondary" data-device-replace="${device.id}">Replace access</button>${device.status==='active'?`<button type="button" class="btn btn--danger" data-device-revoke="${device.id}">Revoke</button>`:''}</article>`).join(''):'<p>No paired devices.</p>'}</div></section>`;
      container.querySelector('[data-device-approve]').onclick=()=>pair();
      container.querySelectorAll('[data-device-edit]').forEach(button=>button.onclick=()=>edit(devices.find(device=>device.id===Number(button.dataset.deviceEdit))));
      container.querySelectorAll('[data-device-replace]').forEach(button=>button.onclick=()=>pair(devices.find(device=>device.id===Number(button.dataset.deviceReplace))));
      container.querySelectorAll('[data-device-revoke]').forEach(button=>button.onclick=async()=>{
        const device=devices.find(item=>item.id===Number(button.dataset.deviceRevoke));
        if(!await confirmModal(`Revoke ${device.name}?`,{detail:'This ends its device access and bound temporary sessions. Other personal sessions remain signed in.',danger:true,confirmLabel:'Revoke device'}))return;
        try{await api.post(`/devices/${device.id}/revoke`,{revision:device.revision});await refresh();}catch(err){error(err.message);}
      });
    }catch(err){container.innerHTML='<p role="alert">Devices could not be loaded.</p>';error(err.message);}
  }
  function pair(existing){
    openModal({title:existing?`Replace ${existing.name} access`:'Approve a household device',content:`<form data-device-approve-form><label class="label">Pairing code<input class="input" name="code" autocomplete="off" required maxlength="24"></label>${existing?'':`<label class="label">Display name<input class="input" name="name" maxlength="80" required placeholder="Kitchen Wall"></label>`}<p>${existing?'The existing credential and temporary sessions will be revoked. The replacement retains this device’s configured permissions.':'The Shared family checklist preset grants only shared reads and independent Task completion. It never copies your permissions.'}</p><p role="alert" data-device-form-error></p><div class="modal-footer"><button class="btn btn--secondary" type="button" data-action="close-modal">Cancel</button><button class="btn btn--primary" type="submit">Approve device</button></div></form>`,onSave(panel){
      panel.querySelector('form').onsubmit=async event=>{event.preventDefault();const form=new FormData(event.target);const submit=event.target.querySelector('[type=submit]');submit.disabled=true;
        try{await api.post('/devices/pairing-approve',{code:form.get('code'),...(existing?{replace_device_id:existing.id,revision:existing.revision}:{name:form.get('name')})});await closeModal({force:true});await refresh();}catch(err){panel.querySelector('[data-device-form-error]').textContent=err.message;}finally{submit.disabled=false;}};
    }});
  }
  function edit(device){
    // Older devices have no Weather layout entry. Offer it without enabling it.
    if(!device.preferences.widgets.some(widget=>widget.id==='weather'))device={...device,preferences:{...device.preferences,widgets:[...device.preferences.widgets,{id:'weather',visible:false,size:'medium',order:device.preferences.widgets.length}]}};
    const prefs=structuredClone(device.preferences),permissions=structuredClone(device.permissions),scope=structuredClone(device.scope);
    openModal({title:`Configure ${device.name}`,size:'xl',content:deviceConfigContent(device,model,{modules,actions,definitions,noteActions}),onSave(panel){
      window.lucide?.createIcons({el:panel});
      panel.querySelector('form').addEventListener('invalid',event=>{const details=event.target.closest('details');if(details)details.open=true;},true);
      panel.querySelector('form').onsubmit=async event=>{event.preventDefault();const form=new FormData(event.target),submit=event.submitter||panel.querySelector('[data-device-save]');submit.disabled=true;
        for(const key of modules)permissions.modules[key]=form.has(`module:${key}`)?'read':'none';
        permissions.widgets.weather=form.has('weather')?'allow':'none';
        for(const key of Object.keys(actions))permissions.capabilities[`device_tasks.${key}`]=form.has(`action:${key}`)?'allow':'none';
        for(const key of Object.keys(definitions))permissions.capabilities[key]=form.has(`definition:${key}`)?'allow':'none';
        for(const key of Object.keys(noteActions))permissions.capabilities[`device_notes.${key}`]=form.has(`note:${key}`)?'allow':'none';
        for(const key of ['move','pin','group','ungroup']){
          const value=form.get(`note:${key}`);
          if(value==='legacy')delete permissions.capabilities[`device_notes.${key}`];
          else permissions.capabilities[`device_notes.${key}`]=value;
        }
        permissions.capabilities['rotations.view']=form.has('rotations')?'allow':'none';
        scope.member_ids=form.getAll('members').map(Number);scope.show_points=form.has('points');
        prefs.default_view=form.get('default_view');for(const key of ['theme','palette','font','density'])prefs.appearance[key]=form.get(key);
        prefs.widgets=prefs.widgets.map(widget=>({...widget,visible:form.has(`widget:${widget.id}`),order:Number(form.get(`order:${widget.id}`)),size:form.get(`size:${widget.id}`)}));
        try{await api.patch(`/devices/${device.id}`,{revision:device.revision,name:form.get('name'),permissions,scope,preferences:prefs,idle_seconds:Number(form.get('idle')),maximum_seconds:Number(form.get('maximum'))});await closeModal({force:true});await refresh();}catch(err){panel.querySelector('[data-device-form-error]').textContent=err.message;}finally{submit.disabled=false;}
      };
    }});
  }
  await refresh();return()=>{disposed=true;styles.forEach(link=>link.remove());};
}
