import {esc} from './html-escape.js';
export const PORTION_VALUES=Object.freeze(Array.from({length:20},(_,i)=>((i+1)/4).toFixed(2)));
export function portionControl(id,saved,labels={}) {
  const value=Number(saved??1).toFixed(2),legacy=!PORTION_VALUES.includes(value);
  return `${legacy?`<p class="form-hint">${esc(labels.saved||'Saved amount')}: ${esc(value)} ${esc(labels.hint||'portions — choose an amount only to replace it.')}</p>`:''}<select class="form-input" name="portion_amount" id="${esc(id)}" aria-label="${esc(labels.label||'Portions')}" data-legacy="${legacy}">${legacy?`<option value="" disabled selected>${esc(labels.prompt||'Choose a replacement')}</option>`:''}${PORTION_VALUES.map(n=>`<option value="${n}"${!legacy&&n===value?' selected':''}>${n}</option>`).join('')}</select>`;
}
export function portionPatch(saved,selected){
  if(selected==null||selected==='')return saved==null?{portion_amount:1}:{};
  if(!PORTION_VALUES.includes(String(selected)))throw new TypeError('Choose a listed portion amount.');
  return {portion_amount:Number(selected)};
}
export function bindPortionControl(select,saved){if(saved!=null&&!PORTION_VALUES.includes(Number(saved).toFixed(2)))select.value='';select.addEventListener('change',()=>{select.dataset.replaced='true';});}
