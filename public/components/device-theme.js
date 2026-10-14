import {api} from '/api.js';
import {deviceBootstrap,isDevicePrincipal,authenticationSnapshot,sameAuthentication,acceptAuthentication} from '/utils/device-context.js';
import {applyAppearancePreferences} from '/utils/appearance-preferences.js';
import {clearNamedAppearance} from '/utils/named-appearance-runtime.js';
import {currentUiSounds} from '/utils/ui-sounds.js';
import {openModal,closeModal,refreshDirtySnapshot} from '/components/modal.js';
import {mountNamedAppearancePicker} from '/components/named-appearance-picker.js';
import {esc} from '/utils/html.js';
import {t} from '/i18n.js';

let installed=false,refreshing=null,controller=null,reconcileOpen=null;
const themeRevision=value=>value?.theme_revision||0;
const older=(value,other)=>value.revision<other.revision||value.revision===other.revision&&themeRevision(value)<themeRevision(other);
export function deviceThemeChangesAllowed(){
  if(!isDevicePrincipal())return false;
  const prefs=deviceBootstrap()?.device?.preferences||{};
  return!Object.hasOwn(prefs,'allow_theme_changes')||prefs.allow_theme_changes===true;
}
function paintButtons(){
  for(const button of document.querySelectorAll('[data-device-theme]')){button.disabled=!deviceThemeChangesAllowed();button.title=button.disabled?t('deviceTheme.locked'):t('deviceTheme.title');button.setAttribute('aria-disabled',String(button.disabled));}
}
function paintTheme(value){
  const prior=deviceBootstrap()?.device?.preferences?.appearance||{},sounds=currentUiSounds();
  clearNamedAppearance({removeCache:false});
  if(value.theme==='light'||value.theme==='dark')document.documentElement.setAttribute('data-theme',value.theme);else document.documentElement.removeAttribute('data-theme');
  applyAppearancePreferences({color_theme:prior.palette,heading_font:prior.font,named_appearance:value.named_appearance,ui_sounds:sounds},{persist:false});
}
function applyOwnedTheme(value,snapshot){
  const boot=deviceBootstrap(),device=boot?.device;
  if(!sameAuthentication(snapshot)||!isDevicePrincipal()||value.device_id!==device?.id||older(value,{revision:device.revision,theme_revision:device.preferences?.theme_revision}))return false;
  const prior=device.preferences?.appearance||{},changed=JSON.stringify([prior.theme,prior.named_appearance??null])!==JSON.stringify([value.theme,value.named_appearance]);
  acceptAuthentication({...boot,device:{...device,revision:value.revision,preferences:{...device.preferences,theme_revision:value.theme_revision,allow_theme_changes:value.allow_theme_changes,appearance:{...prior,theme:value.theme,named_appearance:value.named_appearance}}}});
  if(changed)paintTheme(value);
  paintButtons();return true;
}
export async function refreshDeviceTheme(){
  if(!isDevicePrincipal())return null;if(refreshing)return refreshing;
  const snapshot=authenticationSnapshot();
  refreshing=api.get('/device/appearance').then(response=>{if(!applyOwnedTheme(response.data,snapshot))return null;reconcileOpen?.accept(response.data);return response.data;}).catch(()=>null).finally(()=>{refreshing=null;});
  return refreshing;
}
export async function openDeviceTheme(){
  if(!isDevicePrincipal())return;
  const snapshot=authenticationSnapshot(),response=await api.get('/device/appearance');let model=response.data;
  if(!applyOwnedTheme(model,snapshot))return;
  if(!model.allow_theme_changes){window.yuvomi?.showToast(t('deviceTheme.locked'),'error');return;}
  paintTheme(model);
  controller?.abort();const active=new AbortController();controller=active;let destroyPicker,saving=false,unconfirmed=false;
  const choice=value=>({theme:value.theme,named_appearance:value.named_appearance}),key=value=>JSON.stringify(choice(value));
  let draft=choice(model);
  openModal({title:t('deviceTheme.title'),size:'xl',canClose:()=>!saving&&!unconfirmed,content:`<div data-shared-device-theme><input type="hidden" name="shared-device-theme-draft" data-shared-theme-draft><div data-shared-theme-picker></div><label class="label" data-shared-legacy${model.named_appearance?' hidden':''}>${esc(t('deviceTheme.legacyMode'))}<select class="form-input" data-shared-legacy-theme>${['system','light','dark'].map(mode=>`<option value="${mode}"${model.theme===mode?' selected':''}>${esc(t('deviceTheme.'+mode))}</option>`).join('')}</select></label></div><div class="modal-panel__footer"><p class="form-error" role="alert" data-shared-theme-error hidden></p><button type="button" class="btn btn--secondary" data-action="close-modal" data-shared-theme-cancel>${esc(t('common.cancel'))}</button><button type="button" class="btn btn--primary" data-shared-theme-confirm>${esc(t('common.confirm'))}</button></div>`,onClose(){
    // Restore the latest canonical device choice, including a peer's save. Never
    // repaint an ending account/device context with the old dialog's preview.
    const device=deviceBootstrap()?.device;
    if(!active.signal.aborted&&sameAuthentication(snapshot)&&isDevicePrincipal()&&device?.id===model.device_id)paintTheme(device.preferences?.appearance||model);
    active.abort();destroyPicker?.();if(controller===active)controller=null;if(reconcileOpen?.controller===active)reconcileOpen=null;
  },onSave(panel){
    let queued=null;
    const root=panel.querySelector('[data-shared-device-theme]'),confirm=panel.querySelector('[data-shared-theme-confirm]'),errorNode=panel.querySelector('[data-shared-theme-error]');
    const current=()=>!active.signal.aborted&&panel.isConnected&&sameAuthentication(snapshot)&&isDevicePrincipal()&&deviceBootstrap()?.device?.id===model.device_id;
    const trackDraft=()=>{
      // Catalog search/filter fields are navigation, not unsaved configuration.
      root.querySelectorAll('input:not([data-shared-theme-draft]),select,textarea').forEach(node=>node.setAttribute('data-immediate-action',''));
      root.querySelector('[data-shared-theme-draft]').value=key(draft);
    };
    const observe=new MutationObserver(trackDraft);observe.observe(root,{childList:true,subtree:true});active.signal.addEventListener('abort',()=>observe.disconnect(),{once:true});
    const busy=()=>{
      root.inert=saving;root.setAttribute('aria-busy',String(saving));confirm.disabled=saving;confirm.classList.toggle('btn--loading',saving);
      for(const button of panel.querySelectorAll('[data-action="close-modal"]'))button.disabled=saving||unconfirmed;
    };
    const preview=()=>{if(current())paintTheme(draft);trackDraft();if(!unconfirmed)errorNode.hidden=true;};
    const mount=()=>{
      destroyPicker?.();
      panel.querySelector('[data-shared-legacy]').hidden=!!draft.named_appearance;
      panel.querySelector('[data-shared-legacy-theme]').value=draft.theme;
      destroyPicker=mountNamedAppearancePicker(panel.querySelector('[data-shared-theme-picker]'),{value:draft.named_appearance,prefix:'shared-device-theme',signal:active.signal,onChange:named_appearance=>{if(!current()||saving)return;draft={...draft,named_appearance};preview();panel.querySelector('[data-shared-legacy]').hidden=!!named_appearance;}});
      trackDraft();refreshDirtySnapshot({defer:false});
    };
    const reconcile=value=>{
      if(!current()||older(value,model))return;
      if(saving||panel.closest('.modal-overlay')?.inert){if(!queued||!older(value,queued))queued=value;return;}
      if(!value.allow_theme_changes){model=value;void closeModal({force:true});return;}
      if(value.revision===model.revision&&value.theme_revision===model.theme_revision)return;
      model=value;draft=choice(model);paintTheme(model);mount();
    };
    reconcileOpen={controller:active,snapshot,accept:reconcile,overlay:panel.closest('.modal-overlay')};
    const resume=new MutationObserver(()=>{
      if(!saving&&!panel.closest('.modal-overlay')?.inert&&queued){const value=queued;queued=null;reconcile(value);}
    });
    resume.observe(panel.closest('.modal-overlay'),{attributes:true,attributeFilter:['inert']});active.signal.addEventListener('abort',()=>resume.disconnect(),{once:true});
    const fresh=async()=>{
      const response=await api.get('/device/appearance',{requireFresh:true});
      if(!current()||!applyOwnedTheme(response.data,snapshot))return null;
      return response.data;
    };
    const save=async()=>{
      if(saving||!current())return;
      // Enter can activate Confirm before a focused dynamic field blurs.
      const field=document.activeElement;
      if(root.contains(field)&&field.matches('[data-named-field],[data-season],[data-window-field]'))field.dispatchEvent(new Event('change',{bubbles:true}));
      const invalid=root.querySelector('[data-named-error]:not([hidden])');
      if(invalid){invalid.setAttribute('tabindex','-1');invalid.focus();return;}
      saving=true;busy();errorNode.hidden=true;let saved=false;
      try{
        if(unconfirmed){const value=await fresh();if(!value)return;model=value;unconfirmed=false;}
        if(key(draft)!==key(model)){
          const patch={};if(draft.theme!==model.theme)patch.theme=draft.theme;if(JSON.stringify(draft.named_appearance)!==JSON.stringify(model.named_appearance))patch.named_appearance=draft.named_appearance;
          const result=await api.patch('/device/appearance',{revision:model.revision,theme_revision:model.theme_revision,...patch});
          if(!current())return;
          if(!applyOwnedTheme(result.data,snapshot))throw Error('This device changed. Choose a theme again.');
          model=result.data;
        }
        saved=true;
      }catch(error){
        if(!current())return;
        unconfirmed=unconfirmed||error.outcome==='unknown';
        try{const value=await fresh();if(value){unconfirmed=false;queued=value;}}catch{/* An uncertain save cannot be dismissed or replayed without a current read. */}
        if(current()){errorNode.textContent=error.message;errorNode.hidden=false;}
      }finally{
        saving=false;if(queued){const value=queued;queued=null;reconcile(value);}if(current())busy();
      }
      if(saved&&current())await closeModal({force:true});
    };
    mount();
    panel.querySelector('[data-shared-legacy-theme]').addEventListener('change',event=>{if(!saving&&current()){draft={...draft,theme:event.target.value};preview();}},{signal:active.signal});
    confirm.addEventListener('click',()=>{void save();},{signal:active.signal});
  }});
}
function endThemeDialog(){
  if(!controller&&!reconcileOpen)return;
  const overlay=reconcileOpen?.overlay;
  controller?.abort();controller=null;reconcileOpen=null;
  // A forced close of the confirmation alone would resume its parked parent.
  if(overlay?.inert)overlay.remove();
  if(overlay)void closeModal({force:true});
}
export function installDeviceThemeControls(){
  if(installed)return;installed=true;
  window.addEventListener('task-data-changed',()=>{if(isDevicePrincipal())void refreshDeviceTheme();});
  window.addEventListener('vidamia:auth-context',()=>{paintButtons();if(reconcileOpen&&!sameAuthentication(reconcileOpen.snapshot))endThemeDialog();});
  window.addEventListener('auth:context-ending',endThemeDialog);
}
