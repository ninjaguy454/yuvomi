/** Synthetic loopback UI fixture. No household database or external requests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from './helpers/device-prize-document-guards-harness.mjs';
const root = fileURLToPath(new URL('../public/', import.meta.url));
let browser, server, origin, state;
const styles = [...readFileSync(resolve(root,'index.html'),'utf8').matchAll(/<link rel="stylesheet" href="([^\"]+)"\s*\/>/g)].map(match=>match[0]).join('');
function reset() {
  state = {mode:'trusted_display',enabled:true,showPoints:true,fail:null,requests:[],receipts:new Map(),abandoned:new Set(),sequence:0,approval:null,loginCalls:[],twoFactor:false,
    members:[{id:3,display_name:'Scoped Child',avatar_color:'#123456',balance:50}],catalog:[{id:1,name:'Synthetic movie',cost:10,is_active:1,requires_delivery:1}]};
}
function device() { return {id:7,revision:4,name:'Synthetic display',idle_seconds:90,maximum_seconds:600,status:'active',scope:{member_ids:state.members.map(m=>m.id),show_points:state.showPoints},permissions:{modules:{tasks:'read',calendar:'read',meals:'read',shopping:'read',rewards:'read'},widgets:{weather:'none'},capabilities:{'device_rewards.redeem':state.enabled?'allow':'none','device_tasks.complete':'allow'},...(state.mode===null?{}:{prize_redemption_mode:state.mode})},preferences:{default_view:'wall',appearance:{theme:'system',palette:'neutral',font:'default',density:'comfortable'},widgets:[{id:'points',visible:true,size:'medium',order:0}]}}; }
function receipt(body,key) {
 if(state.receipts.has(key))return {...state.receipts.get(key),replayed:true};
 let value;
 if(Array.isArray(body.items)){
  const items=body.items.map(item=>({catalog_id:item.catalog_id,quantity:item.quantity,unit_cost:item.expected_cost,total_cost:item.quantity*item.expected_cost,reward_name:state.catalog.find(r=>r.id===item.catalog_id)?.name||'Previous prize',units:Array.from({length:item.quantity},()=>({id:++state.sequence,status:'pending',requires_delivery:true}))}));
  value={data:{id:items[0].units[0].id,user_id:body.user_id,cost:body.expected_cost,unit_count:items.reduce((n,i)=>n+i.quantity,0),status:'pending',requires_delivery:true,items},replayed:false};
 }else value={data:{id:++state.sequence,user_id:body.user_id,reward_name:'Synthetic movie',cost:body.expected_cost,status:'pending',requires_delivery:true},replayed:false};
 const member=state.members.find(m=>m.id===body.user_id);member.balance-=body.expected_cost;if(state.showPoints)value.balance=member.balance;
 state.receipts.set(key,value);return value;
}
async function handle(req,res) {
  const url=new URL(req.url,origin),path=url.pathname;
  const json=(data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','X-CSRF-Token':'synthetic','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  if(path==='/fixture') {res.writeHead(200,{'Content-Type':'text/html'});res.end(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">${styles}<link rel="stylesheet" href="/styles/rewards.css"></head><body><main id="main-content"></main></body></html>`);return;}
  if(path.startsWith('/api/v1/')) {
    let input='';for await(const chunk of req)input+=chunk;const body=input?JSON.parse(input):{};
    const route=path.slice(7),key=req.headers['idempotency-key'];state.requests.push({path:route,method:req.method,body,key});
    if(route==='/auth/me')return json({user:{id:1,role:'admin'},csrfToken:'synthetic'});
    if(route==='/auth/oidc/config')return json({enabled:true,password_login_enabled:true});
    if(route==='/devices'&&req.method==='GET')return json({data:[device()],members:state.members});
    if(route==='/devices/7'&&req.method==='PATCH')return json({data:{...device(),...body}});
    if(route==='/rewards/device-options')return state.enabled?json({data:{device_id:7,device_revision:4,mode:state.mode||'member_signin',members:state.members.map(member=>{const copy={...member};if(!state.showPoints)delete copy.balance;return copy;}),catalog:state.catalog}}):json({reason:'permission_denied',error:'Prize redemption is disabled'},403);
    if(route==='/rewards/redemptions'&&req.method==='POST') {
      if(state.mode!=='trusted_display')return json({reason:'member_signin_required',error:'Member sign-in required'},403);
      if(state.abandoned.has(key))return json({reason:'device_prize_abandoned',error:'This purchase intent was cancelled'},410);
      if(state.fail==='reject'){state.fail=null;return json({reason:'device_context_changed',error:'Reload this display'},409);}
      if(state.fail==='price'){state.fail=null;state.catalog[0].cost=20;return json({reason:'reward_price_changed',error:'The prize price changed'},409);}
      if(state.fail==='price-abandon-invalid'){state.fail='abandon-invalid';state.catalog[0].cost=20;return json({reason:'reward_price_changed',error:'The prize price changed'},409);}
      if(state.fail==='funds'){state.fail=null;state.members[0].balance=5;return json({reason:'insufficient_points',error:'Not enough points'},400);}
      if(state.fail==='delayed-funds'){state.fail=null;state.releaseDenial=()=>json({reason:'insufficient_points',error:'Not enough points'},400);return;}
      const value=receipt(body,key);
      if(state.fail==='delayed-success'){state.fail=null;state.releaseSuccess=()=>json(value);return;}
      if(state.fail==='invalid'){state.fail=null;res.writeHead(200,{'Content-Type':'application/json'});res.end('{');return;}
      return json(value);
    }
    if(route==='/device/rewards/request/abandon') {
      if(state.receipts.has(key))return json({reason:'device_prize_already_recorded',error:'Check the original purchase result'},409);
      state.abandoned.add(key);
      if(state.fail==='abandon-invalid'){state.fail=null;res.writeHead(200,{'Content-Type':'application/json'});res.end('{');return;}
      return json({abandoned:true});
    }
    if(route==='/device/rewards/approval/begin') {
      if(state.fail==='price'){state.fail=null;state.catalog[0].cost=20;return json({reason:'reward_price_changed',error:'The prize price changed'},409);}
      state.approval={id:'approval-1',kind:'prize',approved:false,state:'pending',userId:body.user_id,catalogId:body.catalog_id};state.approvalBody=body;state.approvalKey=key;return json({approval:state.approval});
    }
    if(route==='/device/approval'&&req.method==='GET')return json(state.approval?.approved?{approval:state.approval,...receipt(state.approvalBody,state.approvalKey)}:{approval:state.approval});
    if(route==='/device/approval/cancel')return json({ok:true});
    if(route==='/auth/login'||route==='/auth/2fa/verify') {
      state.loginCalls.push({path:route,body});
      if(state.fail==='proof-price'){state.fail=null;state.catalog[0].cost=20;return json({reason:'reward_price_changed',error:'The prize price changed'},409);}
      if(state.fail==='proof-funds'){state.fail=null;state.members[0].balance=5;return json({reason:'insufficient_points',error:'Not enough points'},400);}
      if(route==='/auth/login'&&body.username!=='Scoped Child')return json({error:'Sign in as the selected member.',reason:'prize_member_mismatch'},403);
      if(route==='/auth/login'&&state.twoFactor)return json({twoFactorRequired:true,approval:{...state.approval,twoFactorRequired:true}});
      state.approval.approved=true;state.approval.state='completed';const result={approval:state.approval,...receipt(state.approvalBody,state.approvalKey)};
      if(state.fail==='proof-invalid'){state.fail=null;res.writeHead(200,{'Content-Type':'application/json'});res.end('{');return;}
      return json(result);
    }
    if(route==='/rewards/overview')return json({data:{me:1,isAdmin:true,balances:[{id:1,display_name:'Personal Parent',balance:50}],catalog:state.catalog,setup:{participantCount:1,pointedTaskCount:1,catalogCount:1}}});
    if(route==='/rewards/redemptions')return json({data:[{id:99,user_id:1,user_name:'Personal Parent',reward_name:'Personal receipt',cost:10,status:'pending',requires_delivery:1,can_fulfill:true,can_undo:true,created_at:'2026-10-13'}]});
    if(route==='/preferences')return json({data:{dashboard_today_glance:false,dashboard_widgets:[{id:'rewards',visible:true,size:'medium',order:0}]}});
    if(route==='/dashboard')return json({users:state.members,rewards:{standings:state.showPoints?state.members:[],participantCount:1,pending:0},urgentTasks:[],upcomingEvents:[],shoppingLists:[],todayMeals:[],pinnedNotes:[],birthdays:[],countdowns:[]});
    return json({data:[]});
  }
  const target=resolve(root,'.'+path);if(!target.startsWith(root)||!existsSync(target)){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':({'.js':'text/javascript','.json':'application/json','.css':'text/css','.html':'text/html','.svg':'image/svg+xml'})[extname(target)]||'application/octet-stream'});res.end(readFileSync(target));
}
test.before(async()=>{
  server=createServer((req,res)=>void handle(req,res).catch(error=>{res.writeHead(500);res.end(error.message);}));server.listen(0,'127.0.0.1');await new Promise(resolve=>server.on('listening',resolve));origin=`http://127.0.0.1:${server.address().port}`;
  const edge='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||(process.platform==='win32'&&existsSync(edge)?edge:undefined),args:['--disable-background-networking','--disable-dev-shm-usage']});
});
test.after(async()=>{await browser?.close();server?.closeAllConnections();await new Promise(resolve=>server?.close(resolve));});
test.beforeEach(reset);
async function mount({personal=false,admin=false,dashboard=false,width=1280,deniedStorage=false}={}) {
  const page=await browser.newPage();page.setDefaultTimeout(5000);await page.setViewport({width,height:900});page.errors=[];page.on('pageerror',error=>page.errors.push(error.message));
  await page.setRequestInterception(true);page.on('request',request=>{const url=new URL(request.url());url.origin===origin?request.continue():request.abort();});
  await page.goto(origin+'/fixture');
  await page.evaluate(async({personal,admin,dashboard,device,deniedStorage})=>{
    localStorage.clear();localStorage.setItem('yuvomi-locale','en');window.yuvomi={showToast(){},navigate(){},isModuleDisabled(){return false;}};
    await(await import('/i18n.js')).initI18n();
    if(!personal&&!admin){(await import('/permissions.js')).setPermissions({...device.permissions,widgets:{rewards:'allow'},principal_kind:'device'});(await import('/utils/device-context.js')).acceptAuthentication({authContext:'synthetic-device-context',principal:{kind:'device'},device});}
    if(deniedStorage){const original=localStorage;window.restorePrizeStorage=()=>Object.defineProperty(window,'localStorage',{configurable:true,value:original});Object.defineProperty(window,'localStorage',{configurable:true,get(){throw Error('storage denied');}});}
    window.dispose=await(await import(admin?'/settings/pages/admin-devices.js':dashboard?'/pages/dashboard.js':'/pages/rewards.js')).render(document.querySelector('main'),{user:personal?{id:1,role:'admin'}:{id:null,role:'device'}});
  },{personal,admin,dashboard,device:device(),deniedStorage});return page;
}
async function choose(page){await page.waitForSelector('[data-device-prize-profile]');await page.click('[data-device-prize-profile="3"]');if(await page.$('[data-device-prize-check]'))await page.click('[data-device-prize-check]');else{if(await page.$eval('[data-device-prize-card="1"] [data-device-prize-quantity]',n=>n.textContent==='0'))await page.click('[data-device-prize-buy="1"]');await page.click('[data-device-prize-checkout]');}await page.waitForSelector('[data-device-prize-form]');await page.waitForFunction(()=>document.querySelector('[data-device-prize-submit]').closest('.modal-panel').getAnimations().every(a=>a.playState==='finished'));}
const purchases=()=>state.requests.filter(item=>['/rewards/redemptions','/device/rewards/approval/begin'].includes(item.path)&&item.method==='POST');
async function backgroundSelector(page,selector) {
  const deadline=Date.now()+5000;
  do{if(await page.evaluate(selector=>!!document.querySelector(selector),selector))return;await new Promise(resolve=>setTimeout(resolve,20));}while(Date.now()<deadline);
  throw Error('Background fixture did not reach '+selector);
}

test('device grant is off by default, enabled control preserves saved flag and mode on harmless Save',async()=>{
  for(const [mode,enabled] of [[null,false],['trusted_display',true],['member_signin',true]]){
    state.mode=mode;state.enabled=enabled;const page=await mount({admin:true,width:390});try{
      await page.click('[data-device-edit="7"]');await page.waitForSelector('[name="reward:redeem"]');
      assert.deepEqual(await page.$eval('[name="reward:redeem"]',input=>({disabled:input.disabled,checked:input.checked})),{disabled:false,checked:enabled});
      assert.equal(await page.$eval('[name="reward:mode"]',input=>input.value),mode||'member_signin');
      assert.match(await page.$eval('[name="reward:mode"]',input=>input.closest('section').textContent),/anyone.*choose.*member.*spend/i);
      await page.waitForFunction(()=>{const r=document.querySelector('[data-device-save]').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;});
      await page.click('[data-device-save]');await page.waitForFunction(()=>!document.querySelector('[data-device-config]'));
      const saved=state.requests.filter(item=>item.method==='PATCH').at(-1).body;
      assert.equal(saved.permissions.capabilities['device_rewards.redeem'],enabled?'allow':'none');assert.equal(saved.permissions.prize_redemption_mode,mode||'member_signin');
      assert.equal(saved.permissions.capabilities['device_tasks.complete'],'allow');assert.deepEqual(saved.scope,device().scope);
    }finally{await page.close();}
  }
});
test('disabled device does not load personal history or expose purchasing, delivery or Undo',async()=>{
  state.enabled=false;const page=await mount();try{
    assert.equal(await page.$('[data-device-prize-buy]'),null);assert.equal(await page.$('[data-decide], [data-rw-undo], [data-rw-history]'),null);
    assert.match(await page.$eval('main',el=>el.textContent),/disabled|not enabled/i);
    assert.equal(state.requests.some(item=>item.path.startsWith('/rewards/')),false);
  }finally{await page.close();}
});
test('trusted display discloses anonymous choice and spends only the scoped member with expected cost',async()=>{
  const page=await mount();try{
    await choose(page);assert.match(await page.$eval('[data-device-prize-form]',el=>el.textContent),/anyone|using.*display/i);
    assert.deepEqual(await page.$$eval('[data-device-prize-profile]',nodes=>nodes.map(node=>node.querySelector('span:last-child').textContent)),['Scoped Child']);
    await page.click('[data-device-prize-submit]');await page.waitForSelector('[data-device-prize-receipt]');
    assert.deepEqual(purchases()[0].body,{user_id:3,items:[{catalog_id:1,quantity:1,expected_cost:10}],expected_cost:10});assert.ok(purchases()[0].key);assert.equal(state.members[0].balance,40);
    assert.equal(state.loginCalls.length,0);assert.equal(await page.$('[data-decide], [data-rw-undo], [data-rw-history], [data-tab-id="ledger"]'),null);
    assert.equal(state.requests.some(item=>['/rewards/overview','/rewards/ledger'].includes(item.path)||item.path==='/rewards/redemptions'&&item.method==='GET'),false);
    assert.deepEqual(page.errors,[]);
  }finally{await page.close();}
});
test('hidden points omit numerical balances while the catalog remains redeemable',async()=>{
  state.showPoints=false;const page=await mount();try{
    await choose(page);assert.equal(await page.$('[data-device-prize-balance]'),null);
    await page.click('[data-device-prize-submit]');await page.waitForSelector('[data-device-prize-receipt]');
    assert.equal(await page.$('[data-device-prize-balance]'),null);assert.equal(await page.$eval('[data-device-prize-buy="1"]',node=>node.disabled),false);
  }finally{await page.close();}
});
test('duplicate taps and a lost committed response reuse one durable key after browser reload',async()=>{
  const page=await mount();let cdp;try{
    cdp=await page.createCDPSession();await cdp.send('Fetch.enable',{patterns:[{urlPattern:'*/api/v1/rewards/redemptions',requestStage:'Response'}]});
    cdp.on('Fetch.requestPaused',event=>void cdp.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'Aborted'}));
    await choose(page);await page.evaluate(()=>{const form=document.querySelector('[data-device-prize-form]');form.requestSubmit();form.requestSubmit();});
    await page.waitForSelector('[data-device-prize-error]:not([hidden])');assert.equal(purchases().length,1);assert.equal(state.members[0].balance,40);
    await cdp.send('Fetch.disable');await cdp.detach();cdp=null;
    await page.reload();await page.evaluate(async device=>{
      await(await import('/i18n.js')).initI18n();(await import('/permissions.js')).setPermissions({...device.permissions,principal_kind:'device'});
      (await import('/utils/device-context.js')).acceptAuthentication({authContext:'synthetic-device-context',principal:{kind:'device'},device});
      await(await import('/pages/rewards.js')).render(document.querySelector('main'));
    },device());
    await choose(page);await page.click('[data-device-prize-submit]');await page.waitForSelector('[data-device-prize-receipt]');
    assert.equal(purchases().length,2);assert.equal(purchases()[0].key,purchases()[1].key);assert.equal(state.sequence,1);assert.equal(state.members[0].balance,40);
  }finally{await cdp?.detach();await page.close();}
});
test('malformed success and denied storage retain retry identity without another debit',async()=>{
  state.fail='invalid';const page=await mount({deniedStorage:true});try{
    await choose(page);await page.click('[data-device-prize-submit]');await page.waitForSelector('[data-device-prize-error]:not([hidden])');
    assert.equal(purchases().length,0,'no purchase is dispatched before durable storage is confirmed');await page.evaluate(()=>window.restorePrizeStorage());
    await page.click('[data-device-prize-submit]');await page.waitForFunction(()=>document.querySelector('[data-device-prize-error]')?.textContent.includes('response'));
    await page.click('[data-device-prize-submit]');await page.waitForSelector('[data-device-prize-receipt]');
    assert.equal(purchases()[0].key,purchases()[1].key);assert.equal(state.sequence,1);assert.equal(state.members[0].balance,40);
  }finally{await page.close();}
});
test('storage becoming available after an uncertain purchase and modal close preserves its key',async()=>{
  state.fail='invalid';const page=await mount({deniedStorage:true});try{
    await choose(page);await page.click('[data-device-prize-submit]');await page.waitForSelector('[data-device-prize-error]:not([hidden])');
    assert.equal(purchases().length,0);await page.evaluate(()=>window.restorePrizeStorage());await page.click('[data-device-prize-submit]');await page.waitForFunction(()=>document.querySelector('[data-device-prize-error]')?.textContent.includes('response'));
    await page.click('[data-device-prize-cancel]');await page.waitForFunction(()=>!document.querySelector('[data-device-prize-form]'));await page.evaluate(()=>window.restorePrizeStorage());
    await choose(page);await page.click('[data-device-prize-submit]');await page.waitForSelector('[data-device-prize-receipt]');
    assert.equal(purchases()[0].key,purchases()[1].key);assert.equal(state.sequence,1);assert.equal(state.members[0].balance,40);
  }finally{await page.close();}
});
test('unsafe context denial retains the exact retry body and key',async()=>{
  state.fail='reject';const page=await mount();try{
    await choose(page);await page.click('[data-device-prize-submit]');await page.waitForSelector('[data-device-prize-error]:not([hidden])');
    await page.click('[data-device-prize-submit]');await page.waitForSelector('[data-device-prize-receipt]');
    assert.equal(purchases()[0].key,purchases()[1].key);assert.deepEqual(purchases()[0].body,purchases()[1].body);assert.equal(state.sequence,1);
  }finally{await page.close();}
});
test('a first definitive price rejection refreshes options and permits a new confirmed purchase',async()=>{
  state.fail='price';const page=await mount();try{
    await choose(page);await page.click('[data-device-prize-submit]');await page.waitForFunction(()=>!document.querySelector('[data-device-prize-form]')&&document.querySelector('[data-device-prizes] > [role="alert"]'));
    assert.equal(state.sequence,0);assert.equal(await page.$('[data-device-prize-check]'),null);
    await choose(page);assert.match(await page.$eval('[data-device-prize-form]',node=>node.textContent),/20 points/);
    await page.click('[data-device-prize-submit]');await page.waitForSelector('[data-device-prize-receipt]');
    assert.notEqual(purchases()[0].key,purchases()[1].key);assert.equal(purchases()[1].body.expected_cost,20);assert.equal(state.members[0].balance,30);
  }finally{await page.close();}
});
test('a first definitive insufficient-points rejection refreshes balance and disables unaffordable prizes',async()=>{
  state.fail='funds';const page=await mount();try{
    await choose(page);await page.click('[data-device-prize-submit]');await page.waitForFunction(()=>!document.querySelector('[data-device-prize-form]')&&document.querySelector('[data-device-prizes] > [role="alert"]'));
    assert.equal(state.sequence,0);assert.equal(await page.$('[data-device-prize-check]'),null);assert.equal(await page.$eval('[data-device-prize-add="1"]',node=>node.disabled),true);assert.equal(await page.$eval('[data-device-prize-minus="1"]',node=>node.disabled),false);
    assert.match(await page.$eval('[data-device-prize-balance]',node=>node.textContent),/5 points/);
  }finally{await page.close();}
});
test('a lost abandonment receipt is reconciled before permitting a fresh purchase',async()=>{
  state.fail='price-abandon-invalid';const page=await mount();try{
    await choose(page);await page.click('[data-device-prize-submit]');await page.waitForSelector('[data-device-prize-error]:not([hidden])');assert.equal(state.sequence,0);
    const originalKey=purchases()[0].key;assert.equal(state.abandoned.has(originalKey),true);
    await page.click('[data-device-prize-submit]');await page.waitForFunction(()=>!document.querySelector('[data-device-prize-form]')&&document.querySelector('[data-device-prizes] > [role="alert"]'));
    assert.equal(state.requests.filter(item=>item.path==='/device/rewards/request/abandon').length,2);assert.equal(purchases()[1].key,originalKey);assert.equal(state.sequence,0);
    await choose(page);await page.click('[data-device-prize-submit]');await page.waitForSelector('[data-device-prize-receipt]');assert.notEqual(purchases()[2].key,originalKey);assert.equal(purchases()[2].body.expected_cost,20);assert.equal(state.sequence,1);
  }finally{await page.close();}
});
test('a price denial after an unknown result keeps the original purchase key and cost',async()=>{
  state.fail='invalid';const page=await mount();try{
    await choose(page);await page.click('[data-device-prize-submit]');await page.waitForSelector('[data-device-prize-error]:not([hidden])');
    state.fail='price';await page.click('[data-device-prize-submit]');await page.waitForFunction(()=>document.querySelector('[data-device-prize-error]')?.textContent.includes('original purchase result'));
    assert.ok(await page.$('[data-device-prize-form]'));assert.equal(purchases()[0].key,purchases()[1].key);assert.equal(purchases()[1].body.expected_cost,10);
    assert.equal(state.requests.find(item=>item.path==='/device/rewards/request/abandon').key,purchases()[0].key);
    await page.click('[data-device-prize-submit]');await page.waitForSelector('[data-device-prize-receipt]');assert.equal(purchases()[2].key,purchases()[0].key);assert.equal(state.sequence,1);assert.equal(state.members[0].balance,40);
  }finally{await page.close();}
});
test('an unknown request that never reached the server recovers after repricing and reload through fenced abandonment',async()=>{
  const page=await mount();let cdp,lostKey;try{
    cdp=await page.createCDPSession();await cdp.send('Fetch.enable',{patterns:[{urlPattern:'*/api/v1/rewards/redemptions',requestStage:'Request'}]});
    cdp.on('Fetch.requestPaused',event=>{lostKey=Object.entries(event.request.headers).find(([name])=>name.toLowerCase()==='idempotency-key')?.[1];void cdp.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'Aborted'});});
    await choose(page);await page.click('[data-device-prize-submit]');await page.waitForSelector('[data-device-prize-error]:not([hidden])');
    assert.ok(lostKey);assert.equal(purchases().length,0);assert.equal(state.sequence,0);
    await cdp.send('Fetch.disable');await cdp.detach();cdp=null;state.catalog[0].cost=20;
    await page.reload();await page.evaluate(async device=>{
      await(await import('/i18n.js')).initI18n();(await import('/permissions.js')).setPermissions({...device.permissions,principal_kind:'device'});
      (await import('/utils/device-context.js')).acceptAuthentication({authContext:'synthetic-device-context',principal:{kind:'device'},device});
      await(await import('/pages/rewards.js')).render(document.querySelector('main'));
    },device());
    state.fail='price';await choose(page);await page.click('[data-device-prize-submit]');
    await page.waitForFunction(()=>!document.querySelector('[data-device-prize-form]')&&document.querySelector('[data-device-prizes] > [role="alert"]'));
    const abandoned=state.requests.find(item=>item.path==='/device/rewards/request/abandon');assert.equal(abandoned.key,lostKey);assert.equal(abandoned.body.expected_cost,10);
    assert.equal(state.abandoned.has(lostKey),true);assert.equal(state.sequence,0);assert.equal(await page.$('[data-device-prize-check]'),null);
    await choose(page);await page.click('[data-device-prize-submit]');await page.waitForSelector('[data-device-prize-receipt]');
    assert.notEqual(purchases()[1].key,lostKey);assert.equal(purchases()[1].body.expected_cost,20);assert.equal(state.sequence,1);assert.equal(state.members[0].balance,30);
  }finally{await cdp?.detach();await page.close();}
});
test('replay after parent Undo shows cancelled and refunded status without promising delivery',async()=>{
  state.fail='invalid';const page=await mount();try{
    await choose(page);await page.click('[data-device-prize-submit]');await page.waitForSelector('[data-device-prize-error]:not([hidden])');
    const saved=state.receipts.get(purchases()[0].key);saved.data.status='cancelled';for(const item of saved.data.items||[])for(const unit of item.units)unit.status='cancelled';saved.balance=50;state.members[0].balance=50;
    await page.click('[data-device-prize-submit]');await page.waitForSelector('[data-device-prize-receipt]');
    const text=await page.$eval('[data-device-prize-receipt]',node=>node.textContent);assert.match(text,/cancelled/i);assert.doesNotMatch(text,/redeemed|arrange delivery/i);assert.equal(state.sequence,1);assert.equal(state.members[0].balance,50);
  }finally{await page.close();}
});
test('an uncertain purchase followed by another prize click confirms only the original prize',async()=>{
  state.fail='invalid';state.catalog.push({id:2,name:'Different synthetic prize',cost:3,is_active:1});const page=await mount();try{
    await choose(page);await page.click('[data-device-prize-submit]');await page.waitForSelector('[data-device-prize-error]:not([hidden])');await page.click('[data-device-prize-cancel]');await page.waitForFunction(()=>!document.querySelector('[data-device-prize-form]'));
    await page.evaluate(()=>{document.querySelector('[data-device-prize-buy="2"]').dispatchEvent(new MouseEvent('click',{bubbles:true}));});assert.equal(await page.$('[data-device-prize-form]'),null);assert.equal(await page.$eval('[data-device-prize-checkout]',n=>n.disabled),true);await page.click('[data-device-prize-check]');await page.waitForSelector('[data-device-prize-form]');
    const text=await page.$eval('[data-device-prize-form]',node=>node.textContent);assert.match(text,/Synthetic movie/);assert.doesNotMatch(text,/Different synthetic prize/);
    await page.click('[data-device-prize-submit]');await page.waitForSelector('[data-device-prize-receipt]');assert.equal(purchases()[1].body.items[0].catalog_id,1);assert.equal(purchases()[0].key,purchases()[1].key);assert.equal(state.sequence,1);
  }finally{await page.close();}
});
test('Check previous keeps its captured key after the original in-flight purchase succeeds and removes the slot',async()=>{
  state.fail='delayed-success';const page=await mount();try{
    await choose(page);await page.evaluate(()=>{document.querySelector('[data-device-prize-form]').requestSubmit();});
    const deadline=Date.now()+5000;while(!state.releaseSuccess&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(state.releaseSuccess);
    const key=purchases()[0].key;await page.click('[data-device-prize-cancel]');await page.waitForFunction(()=>!document.querySelector('[data-device-prize-form]'));
    await choose(page);state.releaseSuccess();await page.waitForFunction(key=>!Object.keys(localStorage).some(name=>name.endsWith(key)),{},key);
    await page.click('[data-device-prize-submit]');await page.waitForFunction(()=>!document.querySelector('[data-device-prize-form]'));
    assert.equal(purchases()[1].key,key);assert.equal(state.sequence,1);assert.equal(state.members[0].balance,40);
  }finally{await page.close();}
});
test('a delayed denial cannot discard another tab’s same-key purchase with a lost receipt',async()=>{
  const first=await mount(),second=await mount();try{
    for(const page of [first,second])await page.evaluate(()=>{Object.defineProperty(navigator,'locks',{configurable:true,value:undefined});});
    state.fail='delayed-funds';await first.evaluate(()=>document.querySelector('[data-device-prize-profile="3"]').click());await first.evaluate(()=>{document.querySelector('[data-device-prize-buy="1"]').click();document.querySelector('[data-device-prize-checkout]').click();});
    await first.waitForSelector('[data-device-prize-form]');await first.evaluate(()=>{document.querySelector('[data-device-prize-form]').requestSubmit();});
    await new Promise((resolve,reject)=>{const deadline=Date.now()+5000;const check=()=>state.releaseDenial?resolve():Date.now()>deadline?reject(Error('Held denial was not reached; requests='+JSON.stringify(state.requests.filter(item=>!item.path.startsWith('/auth/'))))):setTimeout(check,5);check();});
    state.fail='invalid';await choose(second);await second.click('[data-device-prize-submit]');
    await second.waitForSelector('[data-device-prize-error]:not([hidden])');
    assert.equal(purchases()[0].key,purchases()[1].key);state.releaseDenial();
    await backgroundSelector(first,'[data-device-prize-error]:not([hidden])');
    const key=purchases()[1].key;
    assert.ok(await first.evaluate(key=>Object.keys(localStorage).some(name=>name.endsWith(key)),key),'another tab’s unknown purchase must remain durable');
    await first.reload();await first.evaluate(async device=>{
      await(await import('/i18n.js')).initI18n();(await import('/permissions.js')).setPermissions({...device.permissions,principal_kind:'device'});
      (await import('/utils/device-context.js')).acceptAuthentication({authContext:'synthetic-device-context',principal:{kind:'device'},device});
      await(await import('/pages/rewards.js')).render(document.querySelector('main'));
    },device());
    await first.evaluate(()=>document.querySelector('[data-device-prize-profile="3"]').click());await first.evaluate(()=>{document.querySelector('[data-device-prize-check]').click();});
    await backgroundSelector(first,'[data-device-prize-form]');await first.evaluate(()=>{document.querySelector('[data-device-prize-form]').requestSubmit();});await backgroundSelector(first,'[data-device-prize-receipt]');assert.equal(purchases()[2].key,key);assert.equal(state.sequence,1);assert.equal(state.members[0].balance,40);
  }finally{await first.close();await second.close();}
});
test('a first price rejection before member sign-in refreshes the prize without opening a personal session',async()=>{
  state.mode='member_signin';state.fail='price';const page=await mount();try{
    await choose(page);await page.click('[data-device-prize-submit]');await page.waitForFunction(()=>!document.querySelector('[data-device-prize-form],#device-prize-approval'));
    assert.equal(state.sequence,0);assert.equal(await page.$('[data-device-prize-check]'),null);assert.equal(state.loginCalls.length,0);
    await choose(page);assert.match(await page.$eval('[data-device-prize-form]',node=>node.textContent),/20 points/);
  }finally{await page.close();}
});
test('a definitive price rejection after sign-in proof refreshes a fresh purchase',async()=>{
  state.mode='member_signin';const page=await mount();try{
    await choose(page);await page.click('[data-device-prize-submit]');await page.waitForFunction(()=>document.querySelector('[data-approval-submit]')?.disabled===false);
    await page.type('#approval-username','Scoped Child');await page.type('#approval-password','synthetic-password');state.fail='proof-price';await page.click('[data-approval-submit]');
    await page.waitForFunction(()=>!document.querySelector('[data-device-prize-form],#device-prize-approval'));assert.equal(state.sequence,0);assert.equal(await page.$('[data-device-prize-check]'),null);
  }finally{await page.close();}
});
test('an uncertain sign-in proof followed by a price denial retains its purchase intent',async()=>{
  state.mode='member_signin';const page=await mount();try{
    await choose(page);await page.click('[data-device-prize-submit]');await page.waitForFunction(()=>document.querySelector('[data-approval-submit]')?.disabled===false);
    await page.type('#approval-username','Scoped Child');await page.type('#approval-password','synthetic-password');state.fail='proof-invalid';await page.click('[data-approval-submit]');
    await page.waitForSelector('[data-approval-error]:not([hidden])');assert.equal(state.sequence,1);
    state.fail='proof-price';await page.click('[data-approval-submit]');await page.waitForSelector('[data-device-prize-error]:not([hidden])');
    assert.ok(await page.$('[data-device-prize-form]'));assert.equal(purchases().length,1);
    assert.equal(state.requests.find(item=>item.path==='/device/rewards/request/abandon').key,purchases()[0].key);assert.equal(state.sequence,1);
    await page.click('[data-device-prize-submit]');await page.waitForFunction(()=>document.querySelector('[data-approval-submit]')?.disabled===false);
    assert.equal(purchases()[0].key,purchases()[1].key);assert.equal(purchases()[1].body.expected_cost,10);
  }finally{await page.close();}
});
test('insufficient points during sign-in proof allow a cheaper fresh purchase after a definitive first rejection',async()=>{
  state.mode='member_signin';state.catalog.push({id:2,name:'Cheaper synthetic prize',cost:3,is_active:1});const page=await mount();try{
    await choose(page);await page.click('[data-device-prize-submit]');await page.waitForFunction(()=>document.querySelector('[data-approval-submit]')?.disabled===false);
    await page.type('#approval-username','Scoped Child');await page.type('#approval-password','synthetic-password');state.fail='proof-funds';await page.click('[data-approval-submit]');
    await page.waitForFunction(()=>!document.querySelector('[data-device-prize-form],#device-prize-approval')&&document.querySelector('[data-device-prizes] > [role="alert"]'));assert.equal(state.sequence,0);
    assert.equal(await page.$('[data-device-prize-check]'),null);await page.click('[data-device-prize-buy="1"]');await page.click('[data-device-prize-buy="2"]');await page.click('[data-device-prize-checkout]');await page.waitForSelector('[data-device-prize-form]');await page.click('[data-device-prize-submit]');
    await page.waitForFunction(()=>document.querySelector('[data-approval-submit]')?.disabled===false);await page.type('#approval-username','Scoped Child');await page.type('#approval-password','synthetic-password');await page.click('[data-approval-submit]');
    await page.waitForSelector('[data-device-prize-receipt]');assert.equal(purchases()[1].body.items[0].catalog_id,2);assert.notEqual(purchases()[0].key,purchases()[1].key);assert.equal(state.members[0].balance,2);
  }finally{await page.close();}
});
test('member sign-in uses one-action credentials, exact member and second factor without a personal session',async()=>{
  state.mode='member_signin';state.twoFactor=true;const page=await mount();try{
    await choose(page);await page.click('[data-device-prize-submit]');await page.waitForSelector('#device-prize-approval');
    await page.waitForFunction(()=>!document.querySelector('[data-approval-submit]').disabled);
    assert.match(await page.$eval('#device-prize-approval',el=>el.textContent),/Scoped Child/);
    await page.type('#approval-username','Wrong member');await page.type('#approval-password','synthetic-password');await page.click('[data-approval-submit]');
    await page.waitForSelector('[data-approval-error]:not([hidden])');assert.equal(state.sequence,0);
    await page.$eval('#approval-username',input=>input.value='Scoped Child');await page.click('[data-approval-submit]');await page.waitForSelector('[data-approval-factor]:not([hidden])');
    assert.equal(await page.$eval('#approval-password',input=>input.value),'');await page.type('#approval-code','synthetic-code');await page.click('[data-approval-submit]');
    await page.waitForSelector('[data-device-prize-receipt]');assert.equal(state.sequence,1);
    assert.equal(purchases().some(item=>item.path==='/rewards/redemptions'),false);assert.equal(purchases()[0].path,'/device/rewards/approval/begin');
    assert.equal(await page.evaluate(async()=>(await import('/utils/device-context.js')).isDevicePrincipal()),true);
    assert.equal(await page.evaluate(()=>JSON.stringify([...Object.keys(localStorage)].map(key=>localStorage.getItem(key))).includes('synthetic-password')),false);
    assert.deepEqual(page.errors,[]);
  }finally{await page.close();}
});
test('OIDC polling accepts the same one-action prize receipt and clears no device identity',async()=>{
  state.mode='member_signin';const page=await mount();try{
    await choose(page);await page.click('[data-device-prize-submit]');await page.waitForSelector('#device-prize-approval');await page.waitForFunction(()=>!document.querySelector('[data-approval-sso]').hidden);
    state.approval.approved=true;state.approval.state='completed';await page.waitForSelector('[data-device-prize-receipt]');
    assert.equal(state.sequence,1);assert.equal(await page.evaluate(async()=>(await import('/utils/device-context.js')).isDevicePrincipal()),true);assert.equal(state.loginCalls.length,0);
  }finally{await page.close();}
});
test('personal Rewards keeps parent delivery and Undo controls',async()=>{
  const page=await mount({personal:true});try{
    await page.waitForSelector('[data-decide="fulfill"]');assert.ok(await page.$('[data-rw-undo="99"]'));assert.ok(await page.$('[data-rw-history]'));assert.ok(await page.$('[data-tab-id="ledger"]'));
    assert.equal(state.requests.some(item=>item.path==='/rewards/device-options'),false);assert.deepEqual(page.errors,[]);
  }finally{await page.close();}
});
test('Dashboard offers prize redemption for an enabled device even with hidden points',async()=>{
  state.showPoints=false;const page=await mount({dashboard:true});try{
    await page.waitForSelector('[data-device-prize-entry]');assert.equal(await page.$eval('[data-device-prize-entry]',node=>node.dataset.route),'/rewards');
    assert.equal(await page.$('[data-route="/rewards?new=1"]'),null);assert.equal(await page.$('.rewards-widget-row__points'),null);
    assert.deepEqual(page.errors,[]);
  }finally{await page.close();}
});
