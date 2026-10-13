import {api} from '/api.js';
import {deviceBootstrap,isDevicePrincipal,authenticationSnapshot,sameAuthentication,acceptAuthentication} from '/utils/device-context.js';
import {applyAppearancePreferences} from '/utils/appearance-preferences.js';
import {clearNamedAppearance} from '/utils/named-appearance-runtime.js';
import {currentUiSounds} from '/utils/ui-sounds.js';
import {openModal,closeModal} from '/components/modal.js';
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
function applyOwnedTheme(value,snapshot){
  const boot=deviceBootstrap(),device=boot?.device;
  if(!sameAuthentication(snapshot)||!isDevicePrincipal()||value.device_id!==device?.id||older(value,{revision:device.revision,theme_revision:device.preferences?.theme_revision}))return false;
  const prior=device.preferences?.appearance||{},changed=JSON.stringify([prior.theme,prior.named_appearance??null])!==JSON.stringify([value.theme,value.named_appearance]);
  acceptAuthentication({...boot,device:{...device,revision:value.revision,preferences:{...device.preferences,theme_revision:value.theme_revision,allow_theme_changes:value.allow_theme_changes,appearance:{...prior,theme:value.theme,named_appearance:value.named_appearance}}}});
  if(changed){
    const sounds=currentUiSounds();clearNamedAppearance({removeCache:false});
    if(value.theme==='light'||value.theme==='dark')document.documentElement.setAttribute('data-theme',value.theme);else document.documentElement.removeAttribute('data-theme');
    applyAppearancePreferences({color_theme:prior.palette,heading_font:prior.font,named_appearance:value.named_appearance,ui_sounds:sounds},{persist:false});
  }
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
  controller?.abort();const active=new AbortController();controller=active;let destroyPicker;
  openModal({title:t('deviceTheme.title'),size:'xl',content:`<div data-shared-device-theme><div data-shared-theme-picker></div><label class="label" data-shared-legacy${model.named_appearance?' hidden':''}>${esc(t('deviceTheme.legacyMode'))}<select class="form-input" data-shared-legacy-theme>${['system','light','dark'].map(mode=>`<option value="${mode}"${model.theme===mode?' selected':''}>${esc(t('deviceTheme.'+mode))}</option>`).join('')}</select></label></div>`,onClose(){active.abort();destroyPicker?.();if(controller===active)controller=null;if(reconcileOpen?.controller===active)reconcileOpen=null;},onSave(panel){
    let saving=false,queued=null;
    const mount=()=>{
      destroyPicker?.();
      panel.querySelector('[data-shared-legacy]').hidden=!!model.named_appearance;
      panel.querySelector('[data-shared-legacy-theme]').value=model.theme;
      destroyPicker=mountNamedAppearancePicker(panel.querySelector('[data-shared-theme-picker]'),{value:model.named_appearance,prefix:'shared-device-theme',signal:active.signal,onChange:async named_appearance=>{await save({named_appearance});if(panel.isConnected)panel.querySelector('[data-shared-legacy]').hidden=!!model.named_appearance;}});
    };
    const reconcile=value=>{
      if(active.signal.aborted||!sameAuthentication(snapshot)||!panel.isConnected||older(value,model))return;
      if(saving){queued=value;return;}
      if(!value.allow_theme_changes){void closeModal({force:true});return;}
      if(value.revision===model.revision&&value.theme_revision===model.theme_revision)return;
      model=value;mount();
    };
    reconcileOpen={controller:active,accept:reconcile};
    const save=async patch=>{
      saving=true;
      try{const result=await api.patch('/device/appearance',{revision:model.revision,theme_revision:model.theme_revision,...patch});if(!active.signal.aborted&&applyOwnedTheme(result.data,snapshot))model=result.data;}
      catch(error){await refreshDeviceTheme();if(!active.signal.aborted)window.yuvomi?.showToast(error.message,'error');throw error;}
      finally{saving=false;if(queued){const value=queued;queued=null;reconcile(value);}}
    };
    mount();
    panel.querySelector('[data-shared-legacy-theme]').addEventListener('change',async event=>{const node=event.target,previous=model.theme;node.disabled=true;try{await save({theme:node.value});}catch(error){node.value=previous;window.yuvomi?.showToast(error.message,'error');}finally{node.disabled=false;}},{signal:active.signal});
  }});
}
export function installDeviceThemeControls(){
  if(installed)return;installed=true;
  window.addEventListener('task-data-changed',()=>{if(isDevicePrincipal())void refreshDeviceTheme();});
  window.addEventListener('vidamia:auth-context',paintButtons);
  window.addEventListener('auth:context-ending',()=>{controller?.abort();controller=null;if(document.querySelector('[data-shared-device-theme]'))void closeModal({force:true});});
}
