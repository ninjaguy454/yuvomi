import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import puppeteer from 'puppeteer';
import { mkdirSync,readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const app=express();let browser,server,base,reads,writes;
const note={id:1,title:'Instructions for Grace and the children',content:'# Evening instructions\n\nRead together before dinner.\n\n- [ ] Feed the pets\n- [x] Put school bags away\n\n'+('A long instruction that stays readable on a phone. '.repeat(30)),color:'#C7DED9',pinned:1,creator_name:'Parent'};
app.use(express.json());app.use(express.static(fileURLToPath(new URL('../public',import.meta.url))));
const links='<link rel="stylesheet" href="/styles/notes.css">'+[...readFileSync(new URL('../public/index.html',import.meta.url),'utf8').matchAll(/<link rel="stylesheet" href="([^"]+)"\s*\/>/g)].map(m=>`<link rel="stylesheet" href="${m[1]}">`).join('');
app.get('/notes-test',(_req,res)=>res.send(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">${links}<style>html,body{height:100%;margin:0}#main-content{height:100vh;padding:16px}*,*::before,*::after{animation:none!important;transition:none!important}</style></head><body><main id="main-content"></main></body></html>`));
app.use('/api/v1',(req,res)=>{
  if(req.path==='/auth/me')return res.json({csrfToken:'fixture'});
  if(req.path==='/notes'&&req.method==='GET'){reads++;return res.json({data:[note]});}
  if(req.path==='/notes'&&req.method==='POST'){writes.push(req.body);return res.status(201).json({data:{...note,...req.body,id:2}});}
  if(req.method!=='GET')writes.push({path:req.path,method:req.method});
  return res.json({data:[]});
});
test.before(async()=>{server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});});
test.after(async()=>{await browser?.close();await new Promise(r=>server.close(r));});
async function mount(width,theme,rights=['view','create']){
  reads=0;writes=[];const page=await browser.newPage();page.setDefaultTimeout(6000);await page.setViewport({width,height:900});await page.goto(base+'/notes-test');
  await page.evaluate(async({theme,rights})=>{
    localStorage.setItem('yuvomi-locale','en');await(await import('/i18n.js')).initI18n();
    document.documentElement.dataset.theme=theme;window.yuvomi={showToast:()=>{}};
    (await import('/permissions.js')).setPermissions({principal_kind:'device',modules:{notes:'read'},capabilities:Object.fromEntries(rights.map(a=>[`device_notes.${a}`,'allow']))});
    window.stopNotes=await(await import('/pages/notes.js')).render(document.getElementById('main-content'),{user:{kind:'device',id:null}});
  },{theme,rights});return page;
}
for(const width of [320,390,1280])for(const theme of ['light','dark'])test(`View+Create Notes ${width}px ${theme}: readable reader, create allowed, existing writes absent`,async()=>{
  const page=await mount(width,theme);try{
    assert.equal(await page.$eval('.note-card__title',el=>el.textContent),note.title);
    assert.equal(await page.$$eval('[data-action="pin"],[data-action="delete"],.note-md-box[data-md-line]',els=>els.length),0);
    assert.ok(await page.$('#fab-new-note'));
    await page.focus('[data-action="open"]');await page.keyboard.press('Enter');await page.waitForSelector('.note-read__body');
    assert.equal(await page.$$eval('#note-tab-edit,#note-modal-save,#note-modal-delete',els=>els.length),0);
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);assert.equal(overflow,false);
    if(process.env.NOTES_SCREENSHOTS){mkdirSync(process.env.NOTES_SCREENSHOTS,{recursive:true});await page.screenshot({path:`${process.env.NOTES_SCREENSHOTS}/notes-reader-${width}-${theme}.png`});}
    await page.evaluate(async()=>await(await import('/components/modal.js')).closeModal({force:true}));
    await page.waitForSelector('.modal-overlay',{hidden:true});
    await page.click('#fab-new-note');await page.waitForSelector('#note-content');await page.type('#note-content','Synthetic child-created note');
    await page.click('#note-modal-save');await page.waitForFunction(()=>!document.querySelector('#note-modal-save'));
    assert.equal(writes.length,1);assert.equal(writes[0].content,'Synthetic child-created note');
    assert.equal(await page.$$eval('[data-action="pin"],[data-action="delete"]',els=>els.length),0);
    await page.reload();await page.evaluate(async()=>{(await import('/permissions.js')).setPermissions({principal_kind:'device',modules:{notes:'none'},capabilities:{}});await(await import('/pages/notes.js')).render(document.getElementById('main-content'),{user:{kind:'device'}});});
    assert.equal(await page.$$eval('.note-card',els=>els.length),0);
  }finally{await page.close();}
});
test('Create-only sends no Notes read, hides created note, clears state on session ending',async()=>{
  const page=await mount(390,'light',['create']);try{
    assert.equal(reads,0);await page.click('#fab-new-note');await page.type('#note-content','Create without reading');await page.click('#note-modal-save');
    await page.waitForFunction(()=>!document.querySelector('#note-modal-save'));assert.equal(reads,0);assert.equal(await page.$$eval('.note-card',els=>els.length),0);
    await page.evaluate(()=>window.dispatchEvent(new Event('auth:context-ending')));
    assert.equal(await page.$eval('#main-content',el=>el.textContent),'');
  }finally{await page.close();}
});
test('View-only and View+Delete expose exactly the permitted existing-note actions',async()=>{
  for(const rights of [['view'],['view','delete'],['view','edit']]){
    const page=await mount(1280,'dark',rights);try{
      assert.equal(await page.$('#fab-new-note'),null);
      assert.equal(!!await page.$('[data-action="delete"]'),rights.includes('delete'));
      assert.equal(!!await page.$('[data-action="pin"]'),rights.includes('edit'));
      await page.focus('[data-action="open"]');await page.keyboard.press('Enter');assert.equal(!!await page.$('#note-tab-edit'),rights.includes('edit'));
      assert.equal(!!await page.$('#note-modal-delete'),rights.includes('delete'));
    }finally{await page.close();}
  }
});
test('queued deletion cannot inherit a later authentication context',async()=>{
  const page=await mount(390,'light',['view','delete']);try{
    await page.focus('[data-action="delete"]');await page.keyboard.press('Enter');
    await page.evaluate(async()=>{(await import('/utils/device-context.js')).invalidateAuthentication();(await import('/permissions.js')).setPermissions({admin:true});});
    await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,5500)));
    assert.equal(writes.length,0);
  }finally{await page.close();}
});
