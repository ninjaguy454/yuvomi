import {esc} from '/utils/html.js';

/** Member order belongs to an independent Activity. Group membership remains
 * shared, so new members are appended without changing an existing choice. */
export function bindGroupAssignmentOrder(root,{onChange=()=>{}}={}) {
  let groupId=null,members=[],order=[],locked=false;
  const current=()=>members.map(member=>Number(member.id));
  const normalized=preferred=>{
    const available=new Set(current());
    const saved=[...new Set((Array.isArray(preferred)?preferred:[]).map(Number))].filter(id=>available.has(id));
    return [...saved,...current().filter(id=>!saved.includes(id))];
  };
  const draw=()=>{
    root.hidden=!groupId||locked||members.length<2;
    root.replaceChildren();
    if(root.hidden)return;
    root.insertAdjacentHTML('afterbegin',`<strong>Order for this Activity</strong><ol class="rotation-order">${order.map((id,index)=>{
      const member=members.find(row=>Number(row.id)===id);
      return `<li data-group-order-id="${id}"><span>${esc(member?.display_name||member?.name||'Member')}</span>
        <button type="button" class="btn btn--ghost btn--sm" data-group-order-move="up" ${index===0?'disabled':''} aria-label="Move ${esc(member?.display_name||'member')} earlier">↑</button>
        <button type="button" class="btn btn--ghost btn--sm" data-group-order-move="down" ${index===order.length-1?'disabled':''} aria-label="Move ${esc(member?.display_name||'member')} later">↓</button></li>`;
    }).join('')}</ol>`);
  };
  const click=event=>{
    const button=event.target.closest('[data-group-order-move]');
    if(!button||!root.contains(button)||button.disabled||locked)return;
    const id=Number(button.closest('[data-group-order-id]').dataset.groupOrderId),at=order.indexOf(id);
    const target=at+(button.dataset.groupOrderMove==='up'?-1:1);
    if(at<0||target<0||target>=order.length)return;
    [order[at],order[target]]=[order[target],order[at]];draw();
    root.querySelector(`[data-group-order-id="${id}"] [data-group-order-move="${button.dataset.groupOrderMove}"]`)?.focus();
    onChange();
  };
  root.addEventListener('click',click);
  return {
    set(group,preferred,{readOnly=false}={}){
      const nextId=Number(group?.id)||null;
      if(nextId!==groupId){groupId=nextId;order=[];}
      members=(group?.members||[]).filter(member=>member.active==null||Boolean(member.active));
      locked=readOnly||group?.usage_mode==='shared'||!!group?.legacy_compatibility;
      order=normalized(preferred===undefined?order:preferred);draw();
    },
    getValue(){return groupId&&order.some((id,index)=>id!==current()[index])?[...order]:null;},
    getOrder(){return [...order];},
    dispose(){root.removeEventListener('click',click);},
  };
}
