import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync,mkdirSync} from 'node:fs';import {fileURLToPath} from 'node:url';import express from 'express';import puppeteer from 'puppeteer';
const root=fileURLToPath(new URL('../public',import.meta.url)),styles=[...readFileSync(root+'/index.html','utf8').matchAll(/<link rel="stylesheet" href="[^"]+"\s*\/>/g)].map(([tag])=>tag).join('');
let prefs,writes,server,browser,origin,failTheme=false,heldField=null,heldResponse=null;const errors=[],external=[];const app=express();app.use(express.json());
app.get('/fixture',(_req,res)=>res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#F5F3ED"><meta name="theme-color" content="#191816"><script src="/named-appearance-init.js"></script><script src="/theme-init.js"></script>${styles}<link rel="stylesheet" href="/styles/settings.css"></head><body><main id="main-content" style="padding:16px;max-width:1080px;margin:auto"></main><script type="module">import {setLocale} from '/i18n.js';import {render} from '/settings/pages/personal-appearance.js';await setLocale('en');window.yuvomi={showToast(){},navigate(){},getCurrentUser:()=>({id:1,role:'member'})};await render(document.querySelector('main'),{user:{id:1,role:'member'}});window.fixtureReady=true;</script></body></html>`));
app.get('/api/v1/auth/me',(_req,res)=>res.json({user:{id:1,role:'member'},permissions:{},csrfToken:'synthetic'}));
app.get('/api/v1/preferences',(_req,res)=>res.json({data:prefs}));app.put('/api/v1/preferences',(req,res)=>{writes.push(req.body);if(heldField&&Object.hasOwn(req.body,heldField)){heldResponse=res;return;}if(failTheme&&Object.hasOwn(req.body,'named_appearance'))return res.status(500).json({error:'Synthetic theme failure'});prefs={...prefs,...req.body};res.json({data:prefs});});app.use(express.static(root));
app.get('/login/fixture',(_req,res)=>res.sendFile(root+'/offline.html'));
test.before(async()=>{prefs={color_theme:'neutral',heading_font:'default',named_appearance:null,ui_sounds:{version:1,mode:'off',pack:'soft',volume:15}};writes=[];server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));origin=`http://127.0.0.1:${server.address().port}`;browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',args:['--disable-background-networking']});});
test.after(async()=>{await browser?.close();await new Promise(r=>server?.close(r));});
test('real personal settings unifies all46 themes, persists choices and preserves Dynamic/filter/legacy behavior',async()=>{
  const page=await browser.newPage();page.on('pageerror',e=>{errors.push(String(e));console.log('Fixture page error: '+String(e));});await page.setRequestInterception(true);page.on('request',r=>{if(r.url().startsWith(origin)||r.url().startsWith('data:'))r.continue();else{external.push(r.url());r.abort();}});await page.setViewport({width:1280,height:1000});await page.goto(origin+'/fixture',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.fixtureReady||document.querySelector('#appearance-retry'),{timeout:5000});assert.deepEqual(errors,[]);
  assert.equal(await page.$$eval('.named-theme-tile',nodes=>nodes.length),47,'46 fixed themes plus Local Weather');
  for(const name of['Liquid Glass','Medieval Parchment','Coffee','Cozy Cafe','Christmas'])assert.ok(await page.$$eval('.named-theme-name',(nodes,name)=>nodes.some(n=>n.textContent===name),name));
  await page.type('[data-theme-search]','Ocean Glass');assert.equal(await page.$$eval('.named-theme-tile',n=>n.length),1);assert.equal(await page.$eval('.named-theme-name',n=>n.textContent),'Liquid Glass');assert.equal(writes.length,0,'browsing writes nothing');
  await page.$eval('[data-theme-search]',n=>{n.value='';n.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.select('[data-named-field=theme]','coffee');await page.waitForFunction(()=>!document.querySelector('.named-appearance-picker').hasAttribute('aria-busy'));assert.equal(prefs.named_appearance.theme,'coffee');assert.equal(await page.$eval('html',n=>n.dataset.namedTheme),'coffee');
  await page.reload();await page.waitForFunction(()=>window.fixtureReady);assert.equal(await page.$eval('[data-named-field=theme]',n=>n.value),'coffee');assert.equal(await page.$eval('html',n=>n.dataset.namedTheme),'coffee');
  await page.select('[data-named-field=theme]','holidays');await page.waitForFunction(()=>!document.querySelector('.named-appearance-picker').hasAttribute('aria-busy'));await page.select('[data-named-field=outside]','coffee');await page.waitForFunction(()=>!document.querySelector('.named-appearance-picker').hasAttribute('aria-busy'));const saved=JSON.stringify(prefs.named_appearance);
  await page.click('[data-theme-filter=light]');assert.equal(JSON.stringify(prefs.named_appearance),saved,'filters do not change Dynamic configuration');assert.equal(await page.$$eval('[data-named-field=theme] option[value=holidays]',n=>n.length),1);assert.equal(await page.$eval('[data-named-field=theme]',n=>n.value),'holidays');assert.equal(await page.$eval('html',n=>n.dataset.namedTheme),'coffee');
  await page.select('[data-named-field=theme]','christmas');await page.waitForFunction(()=>!document.querySelector('.named-appearance-picker').hasAttribute('aria-busy'));assert.equal(await page.$eval('html',n=>n.dataset.theme),'dark');assert.equal(prefs.named_appearance.outside,'coffee','fixed choice retains configured fallback');
  for(const width of[390,320,1920]){await page.setViewport({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${width}px no overflow`);}
  await page.setViewport({width:320,height:1000});await page.evaluate(()=>document.documentElement.style.fontSize='32px');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'200% text fits');await page.evaluate(()=>document.documentElement.style.fontSize='16px');
  await page.select('[data-named-field=theme]','');await page.waitForFunction(()=>!document.querySelector('.named-appearance-picker').hasAttribute('aria-busy'));assert.equal(prefs.named_appearance,null);assert.equal(await page.$eval('html',n=>n.hasAttribute('data-named-theme')),false);assert.equal(prefs.color_theme,'neutral');assert.equal(prefs.heading_font,'default');
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);await page.close();
});
test('offline prepaint and visibility refresh share the dated resolver while public and paired launches exclude personal caches',async()=>{
  const page=await browser.newPage();const config={version:1,theme:'holidays',timeZone:'America/New_York',hemisphere:'north',seasons:{spring:'spring-bloom',summer:'summer-coast',autumn:'autumn-leaves',winter:'winter-frost'},outside:'coffee',holidays:[{enabled:true,theme:'christmas',start:'2026-12-20',end:'2026-12-29'}]};
  await page.evaluateOnNewDocument(config=>{localStorage.setItem('yuvomi-theme','dark');localStorage.setItem('vidamia-named-appearance',JSON.stringify(config));const RealDate=Date;window.__appearanceNow='2026-12-30T04:59:00Z';window.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[window.__appearanceNow]));}static now(){return new RealDate(window.__appearanceNow).getTime();}};},config);
  await page.goto(origin+'/offline.html');await page.waitForFunction(()=>document.documentElement.dataset.namedTheme==='christmas');
  await page.waitForFunction(async()=>!!(await import('/utils/named-appearance-runtime.js')).currentNamedAppearance());
  const saved=await page.evaluate(()=>localStorage.getItem('vidamia-named-appearance'));
  await page.evaluate(()=>{window.__appearanceNow='2026-12-30T05:01:00Z';document.dispatchEvent(new Event('visibilitychange'));});assert.equal(await page.$eval('html',n=>n.dataset.namedTheme),'coffee');assert.equal(await page.evaluate(()=>localStorage.getItem('vidamia-named-appearance')),saved);
  await page.evaluate(async()=>{(await import('/utils/named-appearance-runtime.js')).clearNamedAppearance();});assert.equal(await page.$eval('html',n=>n.dataset.theme),'dark','reset preserves legacy intrinsic mode');
  await page.close();
  for(const paired of[false,true]){const p=await browser.newPage();await p.evaluateOnNewDocument(({paired,config})=>{localStorage.clear();localStorage.setItem('vidamia-named-appearance',JSON.stringify(config));if(paired)localStorage.setItem('vidamia-paired-device','1');}, {paired,config});await p.goto(origin+(paired?'/offline.html':'/login/fixture'));assert.equal(await p.$eval('html',n=>n.hasAttribute('data-named-theme')),false);assert.equal(await p.evaluate(()=>localStorage.getItem('vidamia-named-appearance')),null);await p.evaluate(()=>localStorage.clear());await p.close();}
});
test('indexed radios preserve saved choice through theme changes and provide keyboard/touch targets',async()=>{
  const page=await browser.newPage();await page.goto(origin+'/fixture');await page.waitForFunction(()=>window.fixtureReady);
  await page.evaluate(async()=>{const host=document.createElement('div');host.id='synthetic-colors';document.querySelector('main').prepend(host);window.colorWrites=[];const {mountCardColorPicker}=await import('/components/card-color-picker.js');window.colorControl=mountCardColorPicker(host,{value:{version:1,mode:'fixed',slot:'slot-03-v1'},onChange:value=>window.colorWrites.push(value)});});
  assert.equal(await page.$$eval('#synthetic-colors [role=radio]',n=>n.length),15);
  await page.focus('#synthetic-colors [data-card-choice="slot-03-v1"]');await page.keyboard.press('ArrowRight');assert.equal(await page.$eval('#synthetic-colors [aria-checked=true]',n=>n.dataset.cardChoice),'slot-04-v1');
  await page.evaluate(()=>document.getElementById('synthetic-colors').dir='rtl');await page.keyboard.press('ArrowRight');assert.equal(await page.$eval('#synthetic-colors [aria-checked=true]',n=>n.dataset.cardChoice),'slot-03-v1');
  const before=await page.evaluate(()=>JSON.stringify(window.colorControl.getValue())),count=await page.evaluate(()=>window.colorWrites.length);
  await page.evaluate(async()=>{const {applyNamedAppearance}=await import('/utils/named-appearance-runtime.js');const {defaultNamedAppearance}=await import('/utils/named-appearance.js');applyNamedAppearance({...defaultNamedAppearance(),theme:'ocean-glass'},{persist:false});});
  assert.equal(await page.evaluate(()=>JSON.stringify(window.colorControl.getValue())),before);assert.equal(await page.evaluate(()=>window.colorWrites.length),count);assert.match(await page.$eval('#synthetic-colors [data-card-choice="slot-01-v1"]',n=>n.getAttribute('aria-label')),/Color 1/);
  assert.ok(await page.$$eval('#synthetic-colors [role=radio]',n=>n.every(b=>{const r=b.getBoundingClientRect();return r.width>=44&&r.height>=44;})));await page.close();
});
test('sound settings remain silent on load/save and permit deliberate native audio preview only',async()=>{
  const page=await browser.newPage();await page.evaluateOnNewDocument(()=>{window.audioStarts=0;const start=OscillatorNode.prototype.start;OscillatorNode.prototype.start=function(...args){window.audioStarts++;return start.apply(this,args);};});
  await page.goto(origin+'/fixture');await page.waitForFunction(()=>window.fixtureReady);assert.equal(await page.evaluate(()=>window.audioStarts),0);
  await page.select('[data-sound-mode]','pack');await page.waitForFunction(()=>!document.querySelector('[data-sound-mode]').disabled);assert.equal(await page.evaluate(()=>window.audioStarts),0);await page.click('[data-preview-sound]');assert.equal(await page.evaluate(()=>window.audioStarts),1);
  await page.select('[data-sound-mode]','off');await page.waitForFunction(()=>!document.querySelector('[data-sound-mode]').disabled);assert.equal(await page.$eval('[data-preview-sound]',n=>n.disabled),true);assert.equal(await page.evaluate(()=>window.audioStarts),1);await page.close();
});

async function independentPreferences(named=true){
  const {defaultNamedAppearance}=await import('../public/utils/named-appearance.js');
  prefs={color_theme:'neutral',heading_font:'default',named_appearance:named?{...defaultNamedAppearance(),theme:'coffee'}:null,ui_sounds:{version:1,mode:'pack',pack:'wood',volume:42}};
  const page=await browser.newPage();await page.goto(origin+'/fixture');await page.waitForFunction(()=>window.fixtureReady);return page;
}
test('failed theme save cannot undo a successfully saved mute or independent pack/volume',async()=>{
  const page=await independentPreferences();
  try{
    await page.select('[data-sound-mode]','off');await page.waitForFunction(()=>!document.querySelector('[data-sound-mode]').disabled);failTheme=true;
    await page.select('[data-named-field=theme]','christmas');await page.waitForFunction(()=>!document.querySelector('.named-appearance-picker').hasAttribute('aria-busy'));
    assert.equal((await page.evaluate(async()=>(await import('/utils/ui-sounds.js')).currentUiSounds())).mode,'off');assert.equal(prefs.ui_sounds.mode,'off');assert.equal(await page.$eval('[data-sound-mode]',n=>n.value),'off');assert.equal(await page.$eval('html',n=>n.dataset.namedTheme),'coffee');
    failTheme=false;await page.select('[data-sound-mode]','pack');await page.waitForFunction(()=>!document.querySelector('[data-sound-mode]').disabled);await page.select('[data-sound-pack]','glass');await page.waitForFunction(()=>!document.querySelector('[data-sound-pack]').disabled);failTheme=true;
    await page.select('[data-named-field=theme]','matcha');await page.waitForFunction(()=>!document.querySelector('.named-appearance-picker').hasAttribute('aria-busy'));
    assert.deepEqual(await page.evaluate(async()=>(await import('/utils/ui-sounds.js')).currentUiSounds()),prefs.ui_sounds);assert.equal(prefs.ui_sounds.pack,'glass');assert.equal(prefs.ui_sounds.volume,42);
  }finally{failTheme=false;await page.close();}
});
test('legacy palette and heading-font saves retain enabled independent sound configuration',async()=>{
  const page=await independentPreferences(false);
  try{
    await page.select('#color-theme-select','cool');await page.waitForFunction(()=>!document.querySelector('#color-theme-select').disabled);
    assert.deepEqual(await page.evaluate(async()=>(await import('/utils/ui-sounds.js')).currentUiSounds()),prefs.ui_sounds);
    await page.select('#heading-font-select','serif');await page.waitForFunction(()=>!document.querySelector('#heading-font-select').disabled);
    assert.deepEqual(await page.evaluate(async()=>(await import('/utils/ui-sounds.js')).currentUiSounds()),prefs.ui_sounds);assert.equal(prefs.ui_sounds.mode,'pack');assert.equal(prefs.ui_sounds.volume,42);
  }finally{await page.close();}
});
test('independently pending theme and sound saves roll back only their own failed field',async()=>{
  for(const field of['named_appearance','ui_sounds']){
    const page=await independentPreferences();heldField=field;heldResponse=null;
    try{
      if(field==='named_appearance')await page.select('[data-named-field=theme]','christmas');else await page.select('[data-sound-mode]','off');
      for(let attempt=0;!heldResponse&&attempt<30;attempt++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(heldResponse);
      if(field==='named_appearance'){await page.select('[data-sound-mode]','off');await page.waitForFunction(()=>!document.querySelector('[data-sound-mode]').disabled);}
      else{await page.select('[data-named-field=theme]','christmas');await page.waitForFunction(()=>!document.querySelector('.named-appearance-picker').hasAttribute('aria-busy'));}
      heldResponse.status(500).json({error:'Synthetic held save failure'});heldResponse=null;heldField=null;
      await page.waitForFunction(()=>!document.querySelector('[data-sound-mode]').disabled&&!document.querySelector('.named-appearance-picker').hasAttribute('aria-busy'));
      assert.equal(await page.$eval('html',n=>n.dataset.namedTheme),field==='named_appearance'?'coffee':'christmas');assert.deepEqual(await page.evaluate(async()=>(await import('/utils/ui-sounds.js')).currentUiSounds()),prefs.ui_sounds);
    }finally{heldResponse?.status(500).json({error:'Synthetic cleanup'});heldResponse=null;heldField=null;await page.close();}
  }
});
test('failed clear-theme save after context end cannot restore the former account appearance',async()=>{
  const page=await independentPreferences();heldField='named_appearance';heldResponse=null;
  try{
    await page.select('[data-named-field=theme]','');
    for(let attempt=0;!heldResponse&&attempt<30;attempt++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(heldResponse);
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('auth:context-ending')));heldResponse.status(500).json({error:'Synthetic ended-context save failure'});heldResponse=null;heldField=null;
    await page.waitForFunction(()=>!document.querySelector('.named-appearance-picker').hasAttribute('aria-busy'));
    assert.equal(await page.$eval('html',n=>n.getAttribute('data-named-theme')),null);assert.equal((await page.evaluate(async()=>(await import('/utils/ui-sounds.js')).currentUiSounds())).mode,'off');assert.equal(await page.evaluate(()=>localStorage.getItem('vidamia-named-appearance')),null);
  }finally{heldResponse?.status(500).json({error:'Synthetic cleanup'});heldResponse=null;heldField=null;await page.close();}
});
