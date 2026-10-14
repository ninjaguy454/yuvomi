import {t} from '/i18n.js';import {esc} from '/utils/html.js';import {normalizeUiSounds} from '/utils/named-appearance.js';import {currentNamedAppearance} from '/utils/named-appearance-runtime.js';import {previewUiSound,setWeatherThunderOptIn,weatherThunderEnabled,cancelWeatherThunder} from '/utils/ui-sounds.js';
// Weak registrations let theme changes refresh mounted controls without retaining
// settings panels after navigation or closing a Wall/device editor.
const mounted=new Set(),refreshers=new WeakMap();
function refreshMounted(){for(const reference of mounted){const host=reference.deref();if(!host||host.isConnected===false){mounted.delete(reference);continue;}refreshers.get(host)?.();}}
if(typeof window!=='undefined')for(const type of['named-appearance-changed','named-appearance-configuration-changed','auth:context-ending','pagehide'])window.addEventListener(type,refreshMounted);
export function mountUiSoundSettings(host,{value,onChange,prefix='ui-sounds',theme=()=>document.documentElement.getAttribute('data-named-theme')}={}){
  let saved=normalizeUiSounds(value),pending=false;
  const label=key=>t('uiSounds.'+key);
  function render(){host.replaceChildren();host.insertAdjacentHTML('beforeend',`<h3>${esc(label('title'))}</h3><div class="ui-sound-fields"><label for="${prefix}-mode">${esc(label('mode'))}<select class="form-input" id="${prefix}-mode" data-sound-mode>${['off','theme','pack'].map(mode=>`<option value="${mode}"${saved.mode===mode?' selected':''}>${esc(label(mode))}</option>`).join('')}</select></label><label for="${prefix}-pack"${saved.mode==='pack'?'':' hidden'}>${esc(label('pack'))}<select class="form-input" id="${prefix}-pack" data-sound-pack>${['soft','glass','wood','playful'].map(pack=>`<option value="${pack}"${saved.pack===pack?' selected':''}>${esc(label(pack))}</option>`).join('')}</select></label><label for="${prefix}-volume">${esc(label('volume'))}<input id="${prefix}-volume" type="range" min="0" max="100" step="1" value="${saved.volume}" data-sound-volume><output>${saved.volume}%</output></label><button type="button" class="btn btn--secondary" data-preview-sound${saved.mode==='off'||saved.volume===0?' disabled':''}>${esc(label('preview'))}</button>${currentNamedAppearance()?.theme==='local-weather'?`<label for="${prefix}-thunder"><input id="${prefix}-thunder" type="checkbox" data-weather-thunder${weatherThunderEnabled()?' checked':''}> ${esc(label('weatherThunder'))}</label>`:''}</div><p role="alert" class="form-error" data-sound-error hidden></p>`);host.querySelectorAll('select,input').forEach(n=>n.disabled=pending);}
  function input(event){if(event.target.matches('[data-sound-volume]')){cancelWeatherThunder();host.querySelector('output').textContent=event.target.value+'%';}}
  async function change(event){
    if(pending)return;
    if(event.target.matches('[data-weather-thunder]')){if(currentNamedAppearance()?.theme==='local-weather')setWeatherThunderOptIn(event.target.checked,event);render();return;}
    if(!event.target.matches('[data-sound-mode],[data-sound-pack],[data-sound-volume]'))return;
    cancelWeatherThunder();if(weatherThunderEnabled())setWeatherThunderOptIn(true,event);
    const previous=saved;saved={...saved,mode:host.querySelector('[data-sound-mode]').value,pack:host.querySelector('[data-sound-pack]').value,volume:Number(host.querySelector('[data-sound-volume]').value)};const key=event.target.id;pending=true;render();
    try{await onChange?.({...saved});}catch(error){saved=previous;render();host.querySelector('[data-sound-error]').textContent=error.message;host.querySelector('[data-sound-error]').hidden=false;}finally{pending=false;host.querySelectorAll('select,input').forEach(n=>n.disabled=false);document.getElementById(key)?.focus();}
  }
  function click(event){if(event.target.closest('[data-preview-sound]'))previewUiSound(saved,event,theme());}
  const reference=new WeakRef(host);mounted.add(reference);refreshers.set(host,render);
  host.addEventListener('input',input);host.addEventListener('change',change);host.addEventListener('click',click);render();
  return()=>{mounted.delete(reference);refreshers.delete(host);host.removeEventListener('input',input);host.removeEventListener('change',change);host.removeEventListener('click',click);};
}
