import {esc} from '/utils/html.js';
import {t} from '/i18n.js';
import {NAMED_THEMES,CARD_SLOTS,cardColor,defaultNamedAppearance,normalizeNamedAppearance,validateNamedAppearance,resolveNamedAppearance} from '/utils/named-appearance.js';
import {currentNamedTheme} from '/utils/named-appearance-runtime.js';

const groups=[...new Set(NAMED_THEMES.map(theme=>theme.group))],fixed=id=>NAMED_THEMES.find(theme=>theme.id===id);
const label=key=>t('namedAppearance.'+key);
const option=(id,name,selected)=>`<option value="${esc(id)}"${id===selected?' selected':''}>${esc(name)}</option>`;
function fixedOptions(selected,{seasons=false}={}){return(seasons?`<optgroup label="${esc(label('dynamic'))}">${option('seasons',label('seasons'),selected)}</optgroup>`:'')+groups.map(group=>`<optgroup label="${esc(group)}">${NAMED_THEMES.filter(theme=>theme.group===group).map(theme=>option(theme.id,theme.name,selected)).join('')}</optgroup>`).join('');}
function tile(theme,selected){const p=cardColor(theme,'slot-01-v1'),style={'--tile-canvas':theme.canvas,'--tile-surface':theme.surface,'--tile-text':theme.text,'--tile-line':theme.line,'--tile-pattern':theme.pattern,'--tile-radius':theme.round+'px','--tile-font':theme.font,'--tile-fill':p.fill,'--tile-ink':p.text,'--tile-edge':p.edge};return`<button type="button" class="named-theme-tile" data-theme-choice="${theme.id}" data-focus-key="tile-${theme.id}" data-material="${theme.motif}" aria-pressed="${selected===theme.id}" style="${esc(Object.entries(style).map(([key,value])=>key+':'+value).join(';'))}"><span class="named-theme-name">${esc(theme.name)}</span><small>${esc(theme.identity)}</small><span class="named-theme-examples"><span class="named-example-card">${esc(label('task'))}<span class="named-example-points" aria-label="${esc(label('points'))}">5</span></span><span class="named-example-card">${esc(label('note'))}</span></span><span class="named-theme-slots" aria-label="${esc(label('slots'))}">${CARD_SLOTS.map((slot,index)=>{const c=cardColor(theme,slot);return`<span style="background:${c.fill};border-color:${c.edge}" title="${esc((index<12?label('slot')+' '+(index+1):label('neutral'))+' · '+c.name)}"></span>`;}).join('')}</span></button>`;}

/** The same picker edits personal, Wall and device-owned configurations.
 * It never writes or applies appearance itself; its owning form supplies authority. */
export function mountNamedAppearancePicker(host,{value=null,onChange,prefix='named-theme',timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC',previewCurrentWeather=true,signal}={}){
  let chosen=normalizeNamedAppearance(value),draft=chosen||defaultNamedAppearance(timeZone),filters=new Set(['light','dark']),query='',group='all',pending=false,disposed=false;
  const controller=new AbortController();signal?.addEventListener('abort',()=>controller.abort(),{once:true});
  const id=key=>prefix+'-'+key;
  function weatherTile(){
    const current=previewCurrentWeather?currentNamedTheme():null,live=current?.id.startsWith('local-weather-')&&filters.has(current.kind),now=new Date(),instant=now.toISOString();
    // Browsing never starts a weather read. Reuse the active owner's resolved
    // weather when available; otherwise label the day/night illustration.
    const preview=live?current:resolveNamedAppearance({...draft,theme:'local-weather'},now,{condition:'sunny',is_day:filters.has('light'),observed_at:instant,fetched_at:instant,expires_at:new Date(+now+60000).toISOString(),sunrise_at:null,sunset_at:null}).theme;
    return{...preview,id:'local-weather',name:label('localWeather'),group:'dynamic',identity:label('localWeatherDescription')+' '+label(live?'localWeatherCurrentPreview':'localWeatherExamplePreview'),aliases:['Local Weather']};
  }
  function shown(){return [...NAMED_THEMES,weatherTile()].filter(theme=>filters.has(theme.kind)&&(group==='all'||theme.group===group)&&[theme.name,...theme.aliases].some(name=>name.toLowerCase().includes(query.toLowerCase())));}
  function paintPending(focusKey=null){
    const picker=host.querySelector('.named-appearance-picker');
    if(pending)picker.setAttribute('aria-busy','true');else picker.removeAttribute('aria-busy');
    host.querySelectorAll('[data-named-field],[data-season],[data-window],[data-remove-window],[data-theme-choice]').forEach(node=>node.disabled=pending);
    const add=host.querySelector('[data-add-window]');if(add)add.disabled=pending||draft.holidays.length>=24;
    if(!pending&&focusKey)host.querySelector(`[data-focus-key="${focusKey}"]`)?.focus();
  }
  function paintSelection(focusKey){
    host.querySelector('[data-named-field="theme"]').value=chosen.theme;
    host.querySelectorAll('[data-theme-choice]').forEach(node=>node.setAttribute('aria-pressed',String(node.dataset.themeChoice===chosen.theme)));
    host.querySelector('[data-named-error]').hidden=true;
    paintPending(focusKey);
  }
  function render(focusKey=null){
    const seasonOpen=host.querySelector('.named-season-settings')?.open??false;
    const visible=shown(),selection=chosen?.theme||'',dynamic=selection==='seasons'||selection==='holidays',holidays=selection==='holidays',usesSeasons=selection==='seasons'||holidays&&draft.outside==='seasons';
    const dynamicOptions=`<optgroup label="${esc(label('dynamic'))}">${option('seasons',label('seasons'),selection)}${option('holidays',label('holidays'),selection)}${option('local-weather',label('localWeather'),selection)}</optgroup>`;
    let options=option('',label('legacy'),selection)+dynamicOptions+groups.map(g=>`<optgroup label="${esc(g)}">${visible.filter(theme=>theme.group===g).map(theme=>option(theme.id,theme.name,selection)).join('')}</optgroup>`).join('');
    if(selection&&fixed(selection)&&!visible.some(theme=>theme.id===selection))options+=`<optgroup label="${esc(label('outsideFilter'))}">${option(selection,fixed(selection).name,selection)}</optgroup>`;
    host.replaceChildren();host.insertAdjacentHTML('beforeend',`<div class="named-appearance-picker"${pending?' aria-busy="true"':''}><div class="named-theme-choice"><label class="form-label" for="${id('choice')}">${esc(label('theme'))}</label><div class="named-theme-select"><select class="form-input" id="${id('choice')}" data-named-field="theme" data-focus-key="theme"${pending?' disabled':''}>${options}</select><div role="group" class="named-theme-filters" aria-label="${esc(label('filter'))}">${['light','dark'].map(kind=>`<button type="button" class="named-theme-filter named-theme-filter--${kind}" data-theme-filter="${kind}" aria-label="${esc(label(kind))}" aria-pressed="${filters.has(kind)}"><span aria-hidden="true"></span></button>`).join('')}</div></div></div>
    <div class="named-date-context"${dynamic?'':' hidden'}><label>${esc(label('timezone'))}<input class="form-input" data-named-field="timeZone" data-focus-key="timeZone" value="${esc(draft.timeZone)}" list="${id('zones')}"></label><datalist id="${id('zones')}">${['UTC',...(Intl.supportedValuesOf?.('timeZone')||[])].map(zone=>option(zone,zone,'')).join('')}</datalist><label${usesSeasons?'':' hidden'}>${esc(label('hemisphere'))}<select class="form-input" data-named-field="hemisphere" data-focus-key="hemisphere">${option('north',label('north'),draft.hemisphere)}${option('south',label('south'),draft.hemisphere)}</select></label></div>
    <div class="form-group"${holidays?'':' hidden'}><label for="${id('outside')}">${esc(label('outside'))}</label><select class="form-input" id="${id('outside')}" data-named-field="outside" data-focus-key="outside">${fixedOptions(draft.outside,{seasons:true})}</select></div>
    <details class="named-season-settings"${seasonOpen?' open':''}${usesSeasons?'':' hidden'}><summary>${esc(label('seasonSettings'))}</summary><div class="named-season-grid">${Object.keys(draft.seasons).map(season=>`<label>${esc(label(season))}<select class="form-input" data-season="${season}" data-focus-key="${season}">${fixedOptions(draft.seasons[season])}</select></label>`).join('')}</div></details>
    <div class="named-holiday-settings"${holidays?'':' hidden'}>${draft.holidays.map((window,index)=>`<fieldset class="named-holiday-window"><legend>${esc(label('holidayWindow'))} ${index+1}</legend><label class="named-window-include"><input type="checkbox" data-window="${index}" data-window-field="enabled" data-focus-key="window-${index}-enabled"${window.enabled?' checked':''}>${esc(label('include'))}</label><label>${esc(label('theme'))}<select class="form-input" data-window="${index}" data-window-field="theme" data-focus-key="window-${index}-theme">${fixedOptions(window.theme)}</select></label><div class="named-window-dates"><label>${esc(label('firstDay'))}<input class="form-input" type="date" data-window="${index}" data-window-field="start" data-focus-key="window-${index}-start" value="${window.start}"></label><label>${esc(label('lastDay'))}<input class="form-input" type="date" data-window="${index}" data-window-field="end" data-focus-key="window-${index}-end" value="${window.end}"></label></div><button type="button" class="btn btn--secondary" data-remove-window="${index}" aria-label="${esc(label('removeWindow'))}">${esc(label('remove'))}</button></fieldset>`).join('')}<button type="button" class="btn btn--secondary" data-add-window${draft.holidays.length>=24?' disabled':''}>${esc(label('addWindow'))}</button></div>
    <p class="form-error" role="alert" data-named-error hidden></p><div class="named-catalog-tools"><label class="sr-only" for="${id('search')}">${esc(label('search'))}</label><input class="form-input" id="${id('search')}" type="search" data-theme-search placeholder="${esc(label('search'))}" value="${esc(query)}"><label class="sr-only" for="${id('group')}">${esc(label('category'))}</label><select class="form-input" id="${id('group')}" data-theme-group>${option('all',label('all'),group)}${option('dynamic',label('dynamic'),group)}${groups.map(g=>option(g,g,group)).join('')}</select></div><div class="named-theme-grid">${visible.map(theme=>tile(theme,selection)).join('')}</div><span class="sr-only" role="status" data-filter-status></span></div>`);
    paintPending(focusKey);
  }
  async function commit(next,focusKey=null){
    if(pending||disposed)return;const old=chosen,oldDraft=draft;
    try{next=validateNamedAppearance(next);}catch(error){const el=host.querySelector('[data-named-error]');el.textContent=error.message;el.hidden=false;return;}
    // Fixed choices share the same controls and catalog. Retain their DOM rather
    // than recomputing every tile's contrast colors twice for a single preview.
    const simple=value=>value&&!['seasons','holidays'].includes(value.theme);
    const selectionOnly=simple(old)&&simple(next);
    chosen=next;if(next)draft=next;pending=true;
    if(selectionOnly)paintSelection(focusKey);else render(focusKey);
    try{await onChange?.(next);}catch(error){chosen=old;draft=oldDraft;pending=false;if(!disposed){render(focusKey);const el=host.querySelector('[data-named-error]');el.textContent=error.message;el.hidden=false;}return;}
    pending=false;if(!disposed)paintPending(focusKey);
  }
  host.addEventListener('change',event=>{
    const node=event.target;if(node.matches('[data-theme-group]')){group=node.value;render();return;}
    const next=structuredClone(draft);
    if(node.dataset.namedField==='theme'){void commit(node.value?{...next,theme:node.value}:null,'theme');return;}
    if(node.dataset.namedField)next[node.dataset.namedField]=node.value;
    else if(node.dataset.season)next.seasons[node.dataset.season]=node.value;
    else if(node.dataset.windowField)next.holidays[Number(node.dataset.window)][node.dataset.windowField]=node.type==='checkbox'?node.checked:node.value;
    else return;
    void commit(next,node.dataset.focusKey);
  },{signal:controller.signal});
  host.addEventListener('input',event=>{if(event.target.matches('[data-theme-search]')){const position=event.target.selectionStart;query=event.target.value;render();const input=host.querySelector('[data-theme-search]');input.focus();input.setSelectionRange(position,position);}}, {signal:controller.signal});
  host.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button||pending)return;
    if(button.dataset.themeChoice){void commit({...structuredClone(draft),theme:button.dataset.themeChoice},'tile-'+button.dataset.themeChoice);return;}
    if(button.dataset.themeFilter){const kind=button.dataset.themeFilter;if(filters.size===1&&filters.has(kind)){host.querySelector('[data-filter-status]').textContent=label('oneFilter');return;}filters.has(kind)?filters.delete(kind):filters.add(kind);render();host.querySelector(`[data-theme-filter="${kind}"]`).focus();return;}
    const next=structuredClone(draft);
    if(button.hasAttribute('data-add-window')){const date=resolveNamedAppearance(next).date;next.holidays.push({enabled:false,theme:'christmas',start:date,end:date});void commit(next);}
    if(button.hasAttribute('data-remove-window')){next.holidays.splice(Number(button.dataset.removeWindow),1);void commit(next);}
  },{signal:controller.signal});
  const repaintWeather=()=>{
    const button=host.querySelector('[data-theme-choice="local-weather"]');if(!button)return;
    const focused=document.activeElement===button;button.outerHTML=tile(weatherTile(),chosen?.theme||'');
    const next=host.querySelector('[data-theme-choice="local-weather"]');next.disabled=pending;if(focused)next.focus();
  };
  const dispose=()=>{disposed=true;controller.abort();};
  const observer=new MutationObserver(()=>{if(!host.isConnected)dispose();});observer.observe(document.body,{childList:true,subtree:true});controller.signal.addEventListener('abort',()=>observer.disconnect(),{once:true});
  window.addEventListener('named-appearance-changed',repaintWeather,{signal:controller.signal});
  render();return dispose;
}
