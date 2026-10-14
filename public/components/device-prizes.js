import { api } from '/api.js';
import { t, getNumberFormat, initI18n } from '/i18n.js';
import { esc } from '/utils/html.js';
import { openChildModal } from '/components/modal.js';
import { approveDevicePrize } from '/components/device-approval.js';
import { canCapability } from '/permissions.js';
import { claimDevicePrize, pendingDevicePrize } from '/utils/reward-request.js';
import { authenticationSnapshot, sameAuthentication, deviceBootstrap } from '/utils/device-context.js';
import { memberLabel } from '/utils/member-label.js';
import { AVATAR_FALLBACK_COLOR, getReadableTextColor } from '/utils/color.js';
import { CART_UNIT_LIMIT, cartBudget, canAddCartUnit, cartPurchaseBody, validPrizeReceipt } from '/utils/reward-cart.js';

export const canRedeemDevicePrize = () => canCapability('device_rewards.redeem');
const number = value => getNumberFormat().format(value);
const points = value => `${number(value)} ${t('rewards.pointsUnit')}`;
// Keep identity stable across changes in browser storage availability.
const purchaseStorage={get length(){return window.localStorage.length;},key:index=>window.localStorage.key(index),getItem:key=>window.localStorage.getItem(key),setItem:(key,value)=>window.localStorage.setItem(key,value),removeItem:key=>window.localStorage.removeItem(key)};
const area = (deviceId,memberId) => `device:${deviceId}:member:${memberId}`;
const setContent=(element,markup)=>{element.replaceChildren();element.insertAdjacentHTML('afterbegin',markup);};
const safePhoto=value=>typeof value==='string'&&value.length<=768*1024&&/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)?value:null;
const safeColor=value=>/^#[0-9a-f]{6}$/i.test(value||'')?value:AVATAR_FALLBACK_COLOR;
const initials=name=>name.trim().split(/\s+/).slice(0,2).map(part=>[...part][0]||'').join('').toUpperCase();

/** Scoped profiles and local drafts; every purchase still requires server validation. */
export async function renderDevicePrizes(container) {
  // A tab opened before the cart release can load this lazy module while its
  // i18n singleton still holds the previous locale. Reload the real dictionaries
  // before drawing the new namespace, including the default-locale fallback.
  if (canRedeemDevicePrize() && ['total', 'remaining', 'units', 'quantity', 'addOne', 'removeOne', 'redeem', 'refunded', 'rejected']
    .some(key => t(`rewards.deviceCart.${key}`) === `rewards.deviceCart.${key}`)) await initI18n();
  const context=authenticationSnapshot(),drafts=new Map();
  let disposed=false,options,selected=null,purchaseModal=null,opening=false;
  const active=()=>!disposed&&container.isConnected&&sameAuthentication(context);
  const quantities=()=>{if(!drafts.has(selected))drafts.set(selected,new Map());return drafts.get(selected);};
  const label=member=>memberLabel(member,options.members);
  const acceptOptions=data=>{
    const device=deviceBootstrap()?.device;
    if(data?.device_id!==device?.id||!Array.isArray(data.members)||!Array.isArray(data.catalog))throw new Error(t('rewards.devicePrize.unconfirmed'));
    const allowed=new Set(device.scope?.member_ids||[]);
    // An empty configured scope means all eligible household members, matching
    // the server's deviceMembers policy; this response is already enrollment-filtered.
    const members=data.members.filter(member=>Number.isSafeInteger(member.id)&&member.id>0&&(!allowed.size||allowed.has(member.id))).map(member=>{
      const profile={id:member.id,display_name:String(member.display_name||''),avatar_color:safeColor(member.avatar_color),avatar_data:safePhoto(member.avatar_data)};
      if(device.scope?.show_points===true&&Number.isSafeInteger(member.balance))profile.balance=member.balance;
      return profile;
    });
    const catalog=data.catalog.filter(item=>Number.isSafeInteger(item.id)&&item.id>0&&Number.isSafeInteger(item.cost)&&item.cost>=0)
      .map(item=>({id:item.id,name:String(item.name||''),description:String(item.description||''),icon:String(item.icon||'🎁'),cost:item.cost}));
    options={device_id:data.device_id,mode:data.mode==='trusted_display'?'trusted_display':'member_signin',members,catalog,
      limit:Number.isSafeInteger(data.limits?.max_units)&&data.limits.max_units>0?Math.min(data.limits.max_units,CART_UNIT_LIMIT):CART_UNIT_LIMIT};
    for(const [id,draft]of drafts){if(!members.some(member=>member.id===id)){drafts.delete(id);continue;}for(const itemId of draft.keys())if(!catalog.some(item=>item.id===itemId))draft.delete(itemId);}
    if(!members.some(member=>member.id===selected))selected=null;
  };
  setContent(container,`<div class="rewards-page page-measure--narrow"><header class="page-toolbar page-toolbar--narrow"><h1 class="page-toolbar__title">${esc(t('rewards.devicePrize.title'))}</h1></header><div class="rewards-content" data-device-prizes></div></div>`);
  const target=container.querySelector('[data-device-prizes]');
  const stop=()=>{disposed=true;void purchaseModal?.close({force:true});window.removeEventListener('auth:context-ending',stop);};
  window.addEventListener('auth:context-ending',stop);
  if(!canRedeemDevicePrize()){setContent(target,`<p>${esc(t('rewards.devicePrize.disabled'))}</p>`);return stop;}
  const updateCart=()=>{
    const member=options.members.find(item=>item.id===selected),draft=quantities();
    const pending=member?pendingDevicePrize(area(options.device_id,member.id),purchaseStorage):null;
    const budget=cartBudget(options.catalog,draft,member?.balance),locked=!member||!!pending||!!purchaseModal||opening;
    target.querySelector('[data-device-prize-total]').textContent=points(budget.total);
    const remaining=target.querySelector('[data-device-prize-remaining]');if(remaining)remaining.textContent=points(budget.remaining);
    target.querySelector('[data-device-prize-units]').textContent=t('rewards.deviceCart.units',{count:number(budget.units)});
    for(const item of options.catalog){
      const quantity=draft.get(item.id)||0,canAdd=!locked&&canAddCartUnit(item,budget,options.limit);
      const card=target.querySelector(`[data-device-prize-card="${item.id}"]`),toggle=card.querySelector('[data-device-prize-buy]');
      card.classList.toggle('device-prize-card--selected',quantity>0);card.classList.toggle('device-prize-card--unaffordable',!canAdd);
      toggle.setAttribute('aria-pressed',String(quantity>0));toggle.disabled=locked||(!quantity&&!canAdd);
      card.querySelector('[data-device-prize-quantity]').textContent=number(quantity);
      card.querySelector('[data-device-prize-add]').disabled=!canAdd;
      card.querySelector('[data-device-prize-minus]').disabled=locked||quantity===0;
    }
    target.querySelector('[data-device-prize-checkout]').disabled=locked||budget.units===0||(budget.remaining!==null&&budget.remaining<0);
  };
  const edit=(id,change)=>{
    const member=options.members.find(item=>item.id===selected);
    if(!active()||!member||purchaseModal||opening||pendingDevicePrize(area(options.device_id,member.id),purchaseStorage))return;
    const draft=quantities(),quantity=draft.get(id)||0,item=options.catalog.find(item=>item.id===id);
    if(change>0&&!canAddCartUnit(item,cartBudget(options.catalog,draft,member.balance),options.limit))return;
    const next=quantity+change;if(next>0)draft.set(id,next);else draft.delete(id);updateCart();
  };
  const draw=()=>{
    if(!active())return;
    const member=options.members.find(item=>item.id===selected);
    const pending=member?pendingDevicePrize(area(options.device_id,member.id),purchaseStorage):null;
    setContent(target,`<div class="rewards-content__inner device-prize-cart">
      <p class="device-prize-disclosure">${esc(t(options.mode==='trusted_display'?'rewards.devicePrize.trustedDisclosure':'rewards.devicePrize.signinDisclosure'))}</p>
      <div><p class="label" id="device-prize-member-label">${esc(t('rewards.devicePrize.chooseMember'))}</p><div class="device-prize-profiles" data-device-prize-member role="group" aria-labelledby="device-prize-member-label">${options.members.map(person=>`<button class="device-prize-profile" type="button" data-device-prize-profile="${person.id}" aria-pressed="${person.id===selected}"><span class="rw-avatar device-prize-profile__avatar" style="background:${person.avatar_color};color:${getReadableTextColor(person.avatar_color)}">${person.avatar_data?`<img src="${esc(person.avatar_data)}" alt="">`:esc(initials(label(person)))}</span><span>${esc(label(person))}</span></button>`).join('')}</div></div>
      ${member&&Number.isSafeInteger(member.balance)?`<p data-device-prize-balance>${esc(t('rewards.devicePrize.balance',{member:label(member),points:points(member.balance)}))}</p>`:''}
      ${pending?`<p role="status">${esc(t('rewards.devicePrize.pendingHint'))}</p><button class="btn btn--secondary" type="button" data-device-prize-check>${esc(t('rewards.devicePrize.checkPrevious'))}</button>`:''}
      <div class="device-prize-budget" aria-live="polite" aria-atomic="true"><span>${esc(t('rewards.deviceCart.total'))} <strong data-device-prize-total></strong></span>${member&&Number.isSafeInteger(member.balance)?`<span>${esc(t('rewards.deviceCart.remaining'))} <strong data-device-prize-remaining></strong></span>`:''}<span data-device-prize-units></span></div>
      ${options.catalog.length?`<div class="device-prize-grid">${options.catalog.map(item=>`<article class="device-prize-card" data-device-prize-card="${item.id}"><button type="button" class="device-prize-card__select" data-device-prize-buy="${item.id}" aria-pressed="false"><span class="device-prize-card__icon" aria-hidden="true">${esc(item.icon)}</span><span class="device-prize-card__name">${esc(item.name)}</span>${item.description?`<span class="device-prize-card__description">${esc(item.description)}</span>`:''}<span class="device-prize-card__price">${esc(points(item.cost))}</span></button><div class="device-prize-card__quantity"><button class="btn btn--secondary" type="button" data-device-prize-minus="${item.id}" aria-label="${esc(t('rewards.deviceCart.removeOne',{reward:item.name}))}">−</button><span data-device-prize-quantity aria-label="${esc(t('rewards.deviceCart.quantity'))}">0</span><button class="btn btn--secondary" type="button" data-device-prize-add="${item.id}" aria-label="${esc(t('rewards.deviceCart.addOne',{reward:item.name}))}">+</button></div></article>`).join('')}</div>`:`<p>${esc(t('rewards.noRewardsYet'))}</p>`}
      <button class="btn btn--primary device-prize-checkout" type="button" data-device-prize-checkout>${esc(t('rewards.deviceCart.redeem'))}</button>
      <div data-device-prize-receipt-area></div></div>`);
    target.querySelectorAll('[data-device-prize-profile]').forEach(button=>button.onclick=()=>{if(purchaseModal||opening)return;selected=Number(button.dataset.devicePrizeProfile);draw();target.querySelector(`[data-device-prize-profile="${selected}"]`)?.focus({preventScroll:true});});
    target.querySelectorAll('[data-device-prize-buy]').forEach(button=>button.onclick=()=>{const id=Number(button.dataset.devicePrizeBuy);edit(id,quantities().has(id)?-quantities().get(id):1);});
    target.querySelectorAll('[data-device-prize-add]').forEach(button=>button.onclick=()=>edit(Number(button.dataset.devicePrizeAdd),1));
    target.querySelectorAll('[data-device-prize-minus]').forEach(button=>button.onclick=()=>edit(Number(button.dataset.devicePrizeMinus),-1));
    target.querySelector('[data-device-prize-checkout]').onclick=()=>purchase();
    // Capture the original key even if a different browser tab clears the slot.
    target.querySelector('[data-device-prize-check]')?.addEventListener('click',()=>purchase(pending));
    updateCart();
  };
  const statusDetail=unit=>unit.status==='fulfilled'?t('rewards.delivered'):unit.status==='cancelled'?t('rewards.deviceCart.refunded'):unit.status==='rejected'?t('rewards.deviceCart.rejected'):t(unit.requires_delivery?'rewards.devicePrize.deliveryHint':'rewards.pendingApprovals');
  const showReceipt=response=>{
    const receipt=response.data,member=options.members.find(item=>item.id===receipt.user_id);
    if(member&&Object.hasOwn(member,'balance')&&Number.isSafeInteger(response.balance))member.balance=response.balance;
    drafts.delete(receipt.user_id);draw();
    const content=Array.isArray(receipt.items)
      ? `<p>${esc(t(receipt.status==='cancelled'?'rewards.devicePrize.cancelledReceipt':receipt.status==='rejected'?'rewards.devicePrize.rejectedReceipt':'rewards.devicePrize.success',{reward:receipt.items.map(item=>`${number(item.quantity)} × ${item.reward_name}`).join(', '),member:member?label(member):'',points:points(receipt.cost)}))}</p><ul>${receipt.items.map(item=>`<li>${esc(item.reward_name)}<ul>${item.units.map(unit=>`<li>${esc(statusDetail(unit))}</li>`).join('')}</ul></li>`).join('')}</ul>`
      : `${esc(t(receipt.status==='cancelled'?'rewards.devicePrize.cancelledReceipt':receipt.status==='rejected'?'rewards.devicePrize.rejectedReceipt':'rewards.devicePrize.success',{reward:receipt.reward_name,member:member?label(member):'',points:points(receipt.cost)}))} ${esc(statusDetail(receipt))}`;
    setContent(target.querySelector('[data-device-prize-receipt-area]'),`<div role="status" tabindex="-1" data-device-prize-receipt>${content}</div>`);
    target.querySelector('[data-device-prize-receipt]').focus({preventScroll:true});
  };
  async function purchase(captured) {
    if(!active()||purchaseModal||opening)return;
    const member=options.members.find(item=>item.id===selected);if(!member)return;
    const requestArea=area(options.device_id,member.id),previous=captured||pendingDevicePrize(requestArea,purchaseStorage);
    let body;try{body=previous?.body||cartPurchaseBody(member.id,options.catalog,quantities(),options.limit);}catch{return;}
    const summary=Array.isArray(body.items)?body.items.map(item=>`${number(item.quantity)} × ${options.catalog.find(reward=>reward.id===item.catalog_id)?.name||t('rewards.devicePrize.previousPrize')}`).join(', '):options.catalog.find(item=>item.id===body.catalog_id)?.name||t('rewards.devicePrize.previousPrize');
    let busy=false,attempt=null;
    purchaseModal=openChildModal({title:t(previous?'rewards.devicePrize.checkPrevious':'rewards.deviceCart.redeem'),size:'sm',initialFocus:'none',
      content:`<form data-device-prize-form autocomplete="off"><p>${esc(t('rewards.devicePrize.confirm',{reward:summary,member:label(member),points:points(body.expected_cost)}))}</p><p>${esc(t(options.mode==='trusted_display'?'rewards.devicePrize.trustedDisclosure':'rewards.devicePrize.signinDisclosure'))}</p><p class="form-error" role="alert" data-device-prize-error hidden></p><div class="modal-panel__footer"><button class="btn btn--secondary" type="button" data-device-prize-cancel>${esc(t('common.cancel'))}</button><button class="btn btn--primary" type="submit" data-device-prize-submit>${esc(t(previous?'rewards.devicePrize.checkPrevious':options.mode==='trusted_display'?'rewards.devicePrize.redeem':'rewards.devicePrize.signinBuy'))}</button></div></form>`,
      onClose:()=>{purchaseModal=null;if(active()){draw();(target.querySelector('[data-device-prize-check]')||target.querySelector('[data-device-prize-checkout]'))?.focus({preventScroll:true});}}});
    const modal=purchaseModal,form=modal.panel.querySelector('form'),submit=modal.panel.querySelector('[data-device-prize-submit]'),error=form.querySelector('[data-device-prize-error]');
    modal.panel.querySelector('[data-device-prize-cancel]').onclick=()=>modal.close({force:true});
    form.onsubmit=async event=>{
      event.preventDefault();if(busy||!active())return;busy=true;submit.disabled=true;error.hidden=true;
      try{
        attempt ||= await claimDevicePrize(requestArea,body,purchaseStorage,{requestKey:previous?.key});
        const original=attempt.body;
        if(JSON.stringify(original)!==JSON.stringify(body))throw new Error(t('rewards.devicePrize.pendingHint'));
        const {operation,...input}=original;
        const response=options.mode==='trusted_display'?await api.post('/rewards/redemptions',input,{headers:{'Idempotency-Key':attempt.key}}):await approveDevicePrize(input,{requestKey:attempt.key,member});
        if(!active()||!response)return;
        if(!validPrizeReceipt(body,response))throw new Error(t('rewards.devicePrize.unconfirmed'));
        attempt.finish();await modal.close({force:true});if(active())showReceipt(response);
      }catch(err){
        if(active()&&attempt&&['reward_price_changed','reward_unavailable','insufficient_points','device_prize_abandoned'].includes(err.data?.reason)){
          try{
            const {operation,...original}=attempt.body;
            const abandoned=await api.post('/device/rewards/request/abandon',original,{headers:{'Idempotency-Key':attempt.key}});
            if(!active())return;
            if(abandoned.abandoned!==true)throw new Error(t('rewards.devicePrize.unconfirmed'));
            attempt.finish();opening=true;await modal.close({force:true});
            const refreshed=await api.get('/rewards/device-options');if(active()){acceptOptions(refreshed.data);opening=false;draw();target.insertAdjacentHTML('afterbegin',`<p role="alert">${esc(err.message)}</p>`);}
          }catch(resolutionError){
            opening=false;
            if(active()&&modal.panel.isConnected){error.textContent=`${resolutionError.message||t('common.error')} ${t('rewards.devicePrize.retryHint')}`;error.hidden=false;}
            else if(active())setContent(target,`<p role="alert">${esc(resolutionError.message||t('common.error'))}</p>`);
          }
          return;
        }
        if(active()&&modal.panel.isConnected){error.textContent=err.reason==='device_prize_storage_unavailable'?t('rewards.devicePrize.storageUnavailable'):`${err.message||t('common.error')} ${t('rewards.devicePrize.retryHint')}`;error.hidden=false;}
      }finally{busy=false;if(modal.panel.isConnected)submit.disabled=false;}
    };
  }
  try{opening=true;const response=await api.get('/rewards/device-options');if(!active())return stop;acceptOptions(response.data);opening=false;draw();}
  catch(err){if(active())setContent(target,`<p role="alert">${esc(err.message||t('common.error'))}</p>`);}
  finally{opening=false;}
  return stop;
}
