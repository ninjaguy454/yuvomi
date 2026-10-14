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
async function choose(page){await page.waitForSelector('[data-device-prize-member]');await page.select('[data-device-prize-member]','3');await page.click(await page.$('[data-device-prize-check]')?'[data-device-prize-check]':'[data-device-prize-buy="1"]');await page.waitForSelector('[data-device-prize-form]');}
const purchases=()=>state.requests.filter(item=>['/rewards/redemptions','/device/rewards/approval/begin'].includes(item.path)&&item.method==='POST');
async function backgroundSelector(page,selector) {
  const deadline=Date.now()+5000;
  do{if(await page.evaluate(selector=>!!document.querySelector(selector),selector))return;await new Promise(resolve=>setTimeout(resolve,20));}while(Date.now()<deadline);
  throw Error('Background fixture did not reach '+selector);
}


const photo='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX5cAAAAASUVORK5CYII=';
function cartReset(){state.members=[{id:3,display_name:'Scoped Child',avatar_color:'#336699',avatar_data:photo,balance:50},{id:4,display_name:'Second Child',avatar_color:'#996633',avatar_data:'https://private.example/photo',balance:20}];state.catalog=[{id:1,name:'Movie reward',cost:10,icon:'🎬',is_active:1},{id:2,name:'Book reward',cost:25,icon:'📖',is_active:1},{id:3,name:'Free reward',cost:0,icon:'🎁',is_active:1}];}
async function confirm(page){await page.waitForFunction(()=>{const b=document.querySelector('[data-device-prize-submit]'),panel=b?.closest('.modal-panel');return b&&!b.disabled&&panel.getAnimations().every(a=>a.playState==='finished');});await page.click('[data-device-prize-submit]');}
async function profile(page,id=3){await page.waitForSelector('[data-device-prize-profile]');await page.click('[data-device-prize-profile="'+id+'"]');}
async function selectCart(page){await profile(page);await page.click('[data-device-prize-buy="1"]');await page.click('[data-device-prize-add="1"]');await page.click('[data-device-prize-buy="2"]');}

test('keyboard selection keeps profile focus and cancellation restores checkout focus',async()=>{
 cartReset();const page=await mount();try{
 await page.focus('[data-device-prize-profile="3"]');await page.keyboard.press('Enter');
 assert.equal(await page.evaluate(()=>document.activeElement?.dataset.devicePrizeProfile),'3');
 await page.focus('[data-device-prize-buy="1"]');await page.keyboard.press('Space');await page.focus('[data-device-prize-add="1"]');await page.keyboard.press('Enter');
 assert.equal(await page.$eval('[data-device-prize-total]',n=>n.textContent),'20 points');
 await page.focus('[data-device-prize-checkout]');await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('[data-device-prize-submit]')?.closest('.modal-panel').getAnimations().every(a=>a.playState==='finished'));
 await page.click('[data-device-prize-cancel]');await page.waitForFunction(()=>!document.querySelector('[data-device-prize-form]'));
 assert.equal(await page.evaluate(()=>document.activeElement?.hasAttribute('data-device-prize-checkout')),true);assert.equal(purchases().length,0);
 }finally{await page.close();}
});
for(const width of [320,390,768,1280])test('avatar grid quantity budget and explicit checkout at '+width,async()=>{
 cartReset();const page=await mount({width});try{
  assert.equal(await page.$('select[data-device-prize-member]'),null);assert.equal((await page.$$('[data-device-prize-profile]')).length,2);
  assert.equal((await page.$$('[data-device-prize-profile] img')).length,1);assert.equal(await page.$eval('[data-device-prize-profile="4"]',n=>n.textContent.includes('SC')),true);
  await selectCart(page);const read=()=>page.evaluate(()=>({total:document.querySelector('[data-device-prize-total]').textContent,remaining:document.querySelector('[data-device-prize-remaining]').textContent,add:document.querySelector('[data-device-prize-add="1"]').disabled,remove:document.querySelector('[data-device-prize-minus="1"]').disabled,overflow:document.documentElement.scrollWidth>innerWidth+1}));
  assert.deepEqual(await read(),{total:'45 points',remaining:'5 points',add:true,remove:false,overflow:false});assert.equal(state.sequence,0);assert.equal(purchases().length,0);
  const grid=await page.$$eval('[data-device-prize-card]',nodes=>nodes.slice(0,2).map(n=>({x:n.getBoundingClientRect().x,y:n.getBoundingClientRect().y})));assert.equal(grid[0].y,grid[1].y);assert.ok(grid[1].x>grid[0].x);
  const before=state.requests.length;const immediate=await page.evaluate(()=>{document.querySelector('[data-device-prize-minus="1"]').click();return {total:document.querySelector('[data-device-prize-total]').textContent,remaining:document.querySelector('[data-device-prize-remaining]').textContent,add:document.querySelector('[data-device-prize-add="1"]').disabled};});assert.deepEqual(immediate,{total:'35 points',remaining:'15 points',add:false});assert.equal(state.requests.length,before);
  await page.click('[data-device-prize-add="1"]');const output=process.env.CART_BROWSER_EVIDENCE_DIR;if(output){await page.screenshot({path:resolve(output,'cart-'+width+'.png'),fullPage:true});}
  await page.click('[data-device-prize-checkout]');await page.waitForSelector('[data-device-prize-form]');assert.equal(purchases().length,0);assert.match(await page.$eval('[data-device-prize-form]',n=>n.textContent),/2.*Movie reward/);
  await confirm(page);await page.waitForSelector('[data-device-prize-receipt]');assert.equal(state.members[0].balance,5);assert.equal(state.sequence,3);assert.equal(purchases().length,1);assert.deepEqual(purchases()[0].body,{user_id:3,items:[{catalog_id:1,quantity:2,expected_cost:10},{catalog_id:2,quantity:1,expected_cost:25}],expected_cost:45});assert.deepEqual(page.errors,[]);
 }finally{await page.close();}
});
test('profiles keep separate unsent drafts and never use another member balance',async()=>{
 cartReset();const page=await mount();try{await profile(page);await page.click('[data-device-prize-buy="2"]');await profile(page,4);assert.equal(await page.$eval('[data-device-prize-total]',n=>n.textContent),'0 points');assert.equal(await page.$eval('[data-device-prize-buy="2"]',n=>n.disabled),true);await page.click('[data-device-prize-buy="1"]');await profile(page,3);assert.equal(await page.$eval('[data-device-prize-total]',n=>n.textContent),'25 points');assert.equal(purchases().length,0);}finally{await page.close();}
});
test('hidden balances stay outside the DOM while cart public cost and removal remain usable',async()=>{
 cartReset();state.showPoints=false;const page=await mount({width:390});try{await profile(page);await page.click('[data-device-prize-buy="2"]');await page.click('[data-device-prize-add="2"]');await page.click('[data-device-prize-add="2"]');assert.equal(await page.$('[data-device-prize-balance]'),null);assert.equal(await page.$('[data-device-prize-remaining]'),null);assert.equal(await page.$eval('[data-device-prize-total]',n=>n.textContent),'75 points');assert.equal(purchases().length,0);await page.click('[data-device-prize-minus="2"]');assert.equal(await page.$eval('[data-device-prize-total]',n=>n.textContent),'50 points');}finally{await page.close();}
});
test('member sign-in verifies one exact three-unit cart and leaves device context intact',async()=>{
 cartReset();state.mode='member_signin';const page=await mount({width:390});try{await selectCart(page);await page.click('[data-device-prize-checkout]');await confirm(page);await page.waitForFunction(()=>document.querySelector('[data-approval-submit]')?.disabled===false&&document.querySelector('[data-approval-submit]').closest('.modal-panel').getAnimations().every(a=>a.playState==='finished'));await page.type('#approval-username','Scoped Child');await page.type('#approval-password','synthetic-password');await page.click('[data-approval-submit]');await page.waitForSelector('[data-device-prize-receipt]');assert.equal(state.loginCalls.length,1);assert.equal(purchases()[0].body.items.length,2);assert.equal(state.sequence,3);assert.equal(state.members[0].balance,5);assert.equal(await page.evaluate(async()=> (await import('/utils/device-context.js')).isDevicePrincipal()),true);}finally{await page.close();}
});
test('a lost committed cart reply is restored with its original quantities price and key',async()=>{
 cartReset();const page=await mount();let cdp;try{cdp=await page.createCDPSession();await cdp.send('Fetch.enable',{patterns:[{urlPattern:'*/api/v1/rewards/redemptions',requestStage:'Response'}]});cdp.on('Fetch.requestPaused',e=>void cdp.send('Fetch.failRequest',{requestId:e.requestId,errorReason:'Aborted'}));await selectCart(page);await page.click('[data-device-prize-checkout]');await page.click('[data-device-prize-submit]');await page.waitForSelector('[data-device-prize-error]:not([hidden])');const original=purchases()[0];assert.equal(state.sequence,3);await cdp.send('Fetch.disable');await cdp.detach();cdp=null;await page.reload();await page.evaluate(async device=>{(await import('/i18n.js')).initI18n();(await import('/permissions.js')).setPermissions({...device.permissions,widgets:{rewards:'allow'},principal_kind:'device'});(await import('/utils/device-context.js')).acceptAuthentication({authContext:'synthetic-device-context',principal:{kind:'device'},device});window.dispose=await(await import('/pages/rewards.js')).render(document.querySelector('main'),{user:{id:null,role:'device'}});},{...device()});await profile(page);await page.click('[data-device-prize-check]');await page.click('[data-device-prize-submit]');await page.waitForSelector('[data-device-prize-receipt]');assert.equal(purchases()[1].key,original.key);assert.deepEqual(purchases()[1].body,original.body);assert.equal(state.sequence,3);assert.equal(state.members[0].balance,5);}finally{if(cdp)await cdp.detach();await page.close();}
});
