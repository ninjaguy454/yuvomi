import { api } from '/api.js';
import { t, getNumberFormat } from '/i18n.js';
import { esc } from '/utils/html.js';
import { openChildModal } from '/components/modal.js';
import { approveDevicePrize } from '/components/device-approval.js';
import { canCapability } from '/permissions.js';
import { claimDevicePrize, pendingDevicePrize } from '/utils/reward-request.js';
import { authenticationSnapshot, sameAuthentication, deviceBootstrap } from '/utils/device-context.js';

export const canRedeemDevicePrize = () => canCapability('device_rewards.redeem');
const number = value => getNumberFormat().format(value);
const points = value => `${number(value)} ${t('rewards.pointsUnit')}`;
// Keep the cache identity stable when the browser changes storage availability.
// The request helper catches denied reads/writes and keeps this proxy's memory.
const purchaseStorage={get length(){return window.localStorage.length;},key:index=>window.localStorage.key(index),getItem:key=>window.localStorage.getItem(key),setItem:(key,value)=>window.localStorage.setItem(key,value),removeItem:key=>window.localStorage.removeItem(key)};
const storage = () => purchaseStorage;
const area = (deviceId,memberId) => `device:${deviceId}:member:${memberId}`;
const setContent=(element,markup)=>{element.replaceChildren();element.insertAdjacentHTML('afterbegin',markup);};

/** A device has scoped purchase options, never personal history or parent actions. */
export async function renderDevicePrizes(container) {
  const context=authenticationSnapshot();
  let disposed=false,options,selected=null,purchaseModal=null,opening=false;
  const active=()=>!disposed&&container.isConnected&&sameAuthentication(context);
  setContent(container,`<div class="rewards-page page-measure--narrow"><header class="page-toolbar page-toolbar--narrow"><h1 class="page-toolbar__title">${esc(t('rewards.devicePrize.title'))}</h1></header><div class="rewards-content" data-device-prizes></div></div>`);
  const target=container.querySelector('[data-device-prizes]');
  const stop=()=>{disposed=true;void purchaseModal?.close({force:true});window.removeEventListener('auth:context-ending',stop);};
  window.addEventListener('auth:context-ending',stop);
  if(!canRedeemDevicePrize()) {setContent(target,`<p>${esc(t('rewards.devicePrize.disabled'))}</p>`);return stop;}
  const draw=()=>{
    if(!active())return;
    const member=options.members.find(item=>item.id===selected);
    const pending=member?pendingDevicePrize(area(options.device_id,member.id),storage()):null;
    setContent(target,`<div class="rewards-content__inner">
      <p>${esc(t(options.mode==='trusted_display'?'rewards.devicePrize.trustedDisclosure':'rewards.devicePrize.signinDisclosure'))}</p>
      <div class="form-group"><label class="label" for="device-prize-member">${esc(t('rewards.devicePrize.chooseMember'))}</label><select class="input" id="device-prize-member" data-device-prize-member><option value="">${esc(t('rewards.devicePrize.chooseMember'))}</option>${options.members.map(item=>`<option value="${item.id}"${item.id===selected?' selected':''}>${esc(item.display_name)}</option>`).join('')}</select></div>
      ${member&&Number.isFinite(member.balance)?`<p data-device-prize-balance>${esc(t('rewards.devicePrize.balance',{member:member.display_name,points:points(member.balance)}))}</p>`:''}
      ${pending?`<p role="status">${esc(t('rewards.devicePrize.pendingHint'))}</p><button class="btn btn--secondary" type="button" data-device-prize-check>${esc(t('rewards.devicePrize.checkPrevious'))}</button>`:''}
      ${options.catalog.length?`<ul class="rw-catalog">${options.catalog.map(item=>`<li class="rw-reward-card"><h2>${esc(item.name)}</h2>${item.description?`<p>${esc(item.description)}</p>`:''}<p>${esc(points(item.cost))}</p><button class="btn btn--primary" type="button" data-device-prize-buy="${item.id}"${!member||pending||Number.isFinite(member.balance)&&member.balance<item.cost?' disabled':''}>${esc(t('rewards.devicePrize.redeem'))}</button></li>`).join('')}</ul>`:`<p>${esc(t('rewards.noRewardsYet'))}</p>`}
      <div data-device-prize-receipt-area></div></div>`);
    target.querySelector('[data-device-prize-member]').onchange=event=>{const id=Number(event.target.value);selected=options.members.some(item=>item.id===id)?id:null;draw();};
    target.querySelectorAll('[data-device-prize-buy]').forEach(button=>button.onclick=()=>purchase(Number(button.dataset.devicePrizeBuy)));
    target.querySelector('[data-device-prize-check]')?.addEventListener('click',()=>purchase(pending.body.catalog_id));
  };
  const showReceipt=response=>{
    const receipt=response.data;
    const member=options.members.find(item=>item.id===receipt.user_id);
    if(member&&Number.isFinite(response.balance))member.balance=response.balance;
    draw();
    const label=t(receipt.status==='cancelled'?'rewards.devicePrize.cancelledReceipt':receipt.status==='rejected'?'rewards.devicePrize.rejectedReceipt':'rewards.devicePrize.success',{reward:receipt.reward_name,member:member?.display_name||'',points:points(receipt.cost)});
    const detail=receipt.status==='fulfilled'?t('rewards.delivered'):receipt.status==='pending'?t(receipt.requires_delivery?'rewards.devicePrize.deliveryHint':'rewards.pendingApprovals'):'';
    setContent(target.querySelector('[data-device-prize-receipt-area]'),`<p role="status" tabindex="-1" data-device-prize-receipt>${esc(label)} ${esc(detail)}</p>`);
    target.querySelector('[data-device-prize-receipt]').focus({preventScroll:true});
  };
  async function purchase(catalogId) {
    if(!active()||purchaseModal||opening)return;
    const member=options.members.find(item=>item.id===selected);
    if(!member)return;
    const requestArea=area(options.device_id,member.id),saved=storage();
    const previous=pendingDevicePrize(requestArea,saved);
    const item=options.catalog.find(item=>item.id===(previous?.body.catalog_id??catalogId));
    if(!previous&&!item)return;
    const body=previous?.body||{operation:'device-prize',catalog_id:item.id,user_id:member.id,expected_cost:item.cost};
    let busy=false,attempt=null;
    purchaseModal=openChildModal({title:t(previous?'rewards.devicePrize.checkPrevious':'rewards.devicePrize.redeem'),size:'sm',initialFocus:'none',
      content:`<form data-device-prize-form autocomplete="off"><p>${esc(t('rewards.devicePrize.confirm',{reward:item?.name||t('rewards.devicePrize.previousPrize'),member:member.display_name,points:points(body.expected_cost)}))}</p><p>${esc(t(options.mode==='trusted_display'?'rewards.devicePrize.trustedDisclosure':'rewards.devicePrize.signinDisclosure'))}</p><p class="form-error" role="alert" data-device-prize-error hidden></p><div class="modal-panel__footer"><button class="btn btn--secondary" type="button" data-device-prize-cancel>${esc(t('common.cancel'))}</button><button class="btn btn--primary" type="submit" data-device-prize-submit>${esc(t(previous?'rewards.devicePrize.checkPrevious':options.mode==='trusted_display'?'rewards.devicePrize.redeem':'rewards.devicePrize.signinBuy'))}</button></div></form>`,
      onClose:()=>{purchaseModal=null;if(active())draw();}});
    const modal=purchaseModal,form=modal.panel.querySelector('form'),submit=modal.panel.querySelector('[data-device-prize-submit]'),error=form.querySelector('[data-device-prize-error]');
    modal.panel.querySelector('[data-device-prize-cancel]').onclick=()=>modal.close({force:true});
    form.onsubmit=async event=>{
      event.preventDefault();if(busy||!active())return;busy=true;submit.disabled=true;error.hidden=true;
      // Create intent only when confirmed. The exact original body survives all
      // failures, closing this modal and reloading, until a receipt is confirmed.
      try {
        attempt ||= await claimDevicePrize(requestArea,body,saved,{requestKey:previous?.key});
        const original=attempt.body;
        if(original.catalog_id!==body.catalog_id||original.user_id!==body.user_id||original.expected_cost!==body.expected_cost)throw new Error(t('rewards.devicePrize.pendingHint'));
        const {operation,...input}=original;
        const response=options.mode==='trusted_display'
          ? await api.post('/rewards/redemptions',input,{headers:{'Idempotency-Key':attempt.key}})
          : await approveDevicePrize(input,{requestKey:attempt.key,member});
        if(!active()||!response)return;
        if(!Number.isSafeInteger(response.data?.id)||response.data?.user_id!==body.user_id||response.data?.cost!==body.expected_cost)throw new Error(t('rewards.devicePrize.unconfirmed'));
        attempt.finish();await modal.close({force:true});if(active())showReceipt(response);
      } catch(err) {
        // Resolve explicit price/funds denials through the server's atomic fence.
        // It refuses abandonment if an earlier or racing purchase already exists.
        if(active()&&attempt&&['reward_price_changed','insufficient_points','device_prize_abandoned'].includes(err.data?.reason)) {
          try {
            const {operation,...original}=attempt.body;
            const abandoned=await api.post('/device/rewards/request/abandon',original,{headers:{'Idempotency-Key':attempt.key}});
            if(!active())return;
            if(abandoned.abandoned!==true)throw new Error(t('rewards.devicePrize.unconfirmed'));
            attempt.finish();await modal.close({force:true});
            const refreshed=await api.get('/rewards/device-options');
            if(active()){options=refreshed.data;options.mode=options.mode==='trusted_display'?'trusted_display':'member_signin';draw();}
            if(active())target.insertAdjacentHTML('afterbegin',`<p role="alert">${esc(err.message)}</p>`);
          }catch(resolutionError){
            if(active()&&modal.panel.isConnected){error.textContent=`${resolutionError.message||t('common.error')} ${t('rewards.devicePrize.retryHint')}`;error.hidden=false;}
            else if(active())setContent(target,`<p role="alert">${esc(resolutionError.message||t('common.error'))}</p>`);
          }
          return;
        }
        if(active()&&modal.panel.isConnected){error.textContent=err.reason==='device_prize_storage_unavailable'?t('rewards.devicePrize.storageUnavailable'):`${err.message||t('common.error')} ${t('rewards.devicePrize.retryHint')}`;error.hidden=false;error.focus?.({preventScroll:true});}
      } finally {busy=false;if(modal.panel.isConnected)submit.disabled=false;}
    };
  }
  try {
    opening=true;
    const response=await api.get('/rewards/device-options');if(!active())return stop;
    options=response.data;
    if(options.device_id!==deviceBootstrap()?.device?.id||!Array.isArray(options.members)||!Array.isArray(options.catalog))throw new Error(t('rewards.devicePrize.unconfirmed'));
    options.mode=options.mode==='trusted_display'?'trusted_display':'member_signin';draw();
  }catch(err){if(active())setContent(target,`<p role="alert">${esc(err.message||t('common.error'))}</p>`);}
  finally{opening=false;}
  return stop;
}
