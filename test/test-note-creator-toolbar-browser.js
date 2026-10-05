import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import puppeteer from 'puppeteer';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const app = express(); app.use(express.json());
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
const links = '<link rel="stylesheet" href="/styles/notes.css">' + [...readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').matchAll(/<link rel="stylesheet" href="([^"]+)"\s*\/>/g)].map(match => `<link rel="stylesheet" href="${match[1]}">`).join('');
app.get('/creator-toolbar-test', (_req,res) => res.send(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">${links}<script src="/lucide.min.js"></script><style>html,body{height:100%;margin:0}#main-content{height:100vh}*,*::before,*::after{animation:none!important;transition:none!important}</style></head><body><main class="app-content" id="main-content"></main></body></html>`));
const names = ['Alexandra Long Author Name', 'Benjamin Other Member', 'Kitchen Display', 'Unknown Former Author', 'Emily Five', 'Farah Six', 'George Seven', 'Harriet Eight', 'Isaac Nine', 'Jules Ten'];
const fixture = () => ({notes:names.map((creator_name,index) => ({id:index+1,title:`Note ${index+1}`,content:index===1?'Needle matching body':'Ordinary body',creator_name,created_by:index===2||index===3?null:index+1,created_by_device:index===2?37:null,creator_color:'#C7DED9',color:'#C7DED9',revision:1,permissions:{view:true,edit:true,arrange:true,delete:true},layout:{x:index*2,y:0,width:4,height:6,revision:1,position_locked:false,always_on_top:false}})),groups:[]});
let snapshot,requests,writes,browser,server,base;
app.use('/api/v1',(req,res)=>{
  requests.push(req.path);
  if(req.path==='/auth/me')return res.json({csrfToken:'synthetic'});
  if(req.path==='/notes/board')return res.json({data:snapshot});
  if(req.method!=='GET')writes.push({path:req.path,body:req.body});
  return res.json({data:[]});
});
test.before(async()=>{
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
  browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
});
test.after(async()=>{await browser?.close();server?.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
async function mount({width=1280,height=800,touch=false,rtl=false,textScale=1,zoom=1}={}){
  snapshot=fixture();requests=[];writes=[];
  const page=await browser.newPage();page.setDefaultTimeout(4000);await page.setViewport({width,height,hasTouch:touch,isMobile:touch});await page.goto(base+'/creator-toolbar-test');
  await page.evaluate(async({rtl,textScale,zoom})=>{
    class Stream extends EventTarget{constructor(){super();window.noteStream=this;}close(){}}window.EventSource=Stream;window.yuvomi={showToast(){}};
    localStorage.setItem('yuvomi-locale','en');await(await import('/i18n.js')).initI18n();document.documentElement.dir=rtl?'rtl':'ltr';document.documentElement.style.fontSize=`${textScale*100}%`;document.body.style.zoom=zoom;
    (await import('/permissions.js')).setPermissions({admin:true});(await import('/utils/device-context.js')).acceptAuthentication({authContext:'toolbar-synthetic'});
    window.stopNotes=await(await import('/pages/notes.js')).render(document.getElementById('main-content'),{user:{id:1}});
  },{rtl,textScale,zoom});
  return page;
}
const ids=page=>page.$$eval('.note-card',nodes=>nodes.map(node=>Number(node.dataset.id)).sort((a,b)=>a-b));

test('author symbols retain names, selected styling, keyboard focus and single-author search semantics',async()=>{
  const page=await mount();try{
    assert.equal(await page.$eval('#notes-filters',node=>node.parentElement.classList.contains('notes-board-toolbar')),true);
    assert.equal(await page.$eval('[data-creator="member:1"]',node=>node.getAttribute('aria-label')),names[0]);
    assert.ok(await page.$('[data-creator="member:1"] .avatar-stack'));
    assert.ok(await page.$('[data-creator="device:37"] [data-lucide="monitor"]'));
    assert.equal(await page.$eval('[data-creator="name:Unknown Former Author"]',node=>node.getAttribute('aria-label')),names[3]);
    await page.focus('[data-creator="member:2"]');await page.keyboard.press('Enter');
    assert.deepEqual(await ids(page),[2]);
    assert.equal(await page.$eval('[data-creator="member:2"]',node=>node.classList.contains('filter-chip--active')),true);
    assert.equal(await page.evaluate(()=>document.activeElement.dataset.creator),'member:2');
    assert.equal(await page.$eval('#notes-organize',node=>node.hidden),true);
    await page.type('#notes-search','Needle');assert.deepEqual(await ids(page),[2]);
    await page.click('[data-creator="member:1"]');await page.waitForFunction(()=>document.querySelectorAll('.note-card').length===0);
    await page.click('[data-creator=""]');await page.waitForFunction(()=>document.querySelectorAll('.note-card').length===1);
    assert.deepEqual(await ids(page),[2]);
    await page.$eval('#notes-search',node=>{node.value='';node.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.waitForFunction(()=>document.querySelectorAll('.note-card').length===10);
    await page.click('[data-creator="device:37"]');assert.deepEqual(await ids(page),[3]);
    await page.click('[data-creator="device:37"]');assert.equal((await ids(page)).length,10);
    assert.equal(writes.length,0);assert.equal(requests.filter(path=>path==='/notes/members').length,0);
  }finally{await page.close();}
});

for(const options of [{width:320,height:720,touch:true},{width:320,height:720,touch:true,textScale:2},{width:390,height:844,touch:true,rtl:true},{width:844,height:390,touch:true,textScale:2},{width:1280,height:800,zoom:1.2}]){
  test(`creator toolbar remains compact and reachable at ${options.width} ${options.rtl?'RTL':'LTR'} text${options.textScale||1} zoom${options.zoom||1}`,async()=>{
    const page=await mount(options);try{
      const view=await page.evaluate(()=>({pageWidth:document.querySelector('.notes-page').clientWidth,mode:document.querySelector('#notes-grid').dataset.boardView,toolsHidden:document.querySelector('#notes-zoom-controls').hidden}));
      assert.equal(view.mode,view.pageWidth<640?'list':'canvas',JSON.stringify(view));
      assert.equal(view.toolsHidden,view.mode==='list');
      const bounds=await page.evaluate(()=>{
        const row=document.querySelector('#notes-filters'),toolbar=document.querySelector('.notes-board-toolbar'),chips=[...row.children],rect=toolbar.getBoundingClientRect();
        return {overflow:document.documentElement.scrollWidth>innerWidth+1,toolbarHeight:rect.height,rail:row.getBoundingClientRect().width,scrolls:row.scrollWidth>row.clientWidth,buttons:chips.map(node=>({width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height,label:node.getAttribute('aria-label')})),sameRow:row.parentElement===toolbar};
      });
      assert.equal(bounds.overflow,false);assert.equal(bounds.sameRow,true);assert.ok(bounds.rail>=44);assert.ok(bounds.scrolls);assert.ok(bounds.toolbarHeight<=100,JSON.stringify(bounds));
      assert.ok(bounds.buttons.every(button=>button.width<=48*(options.zoom||1)+1&&button.height>=44&&button.label),JSON.stringify(bounds));
      await page.focus('[data-creator="member:10"]');await page.keyboard.press('Enter');assert.deepEqual(await ids(page),[10]);
      assert.equal(await page.evaluate(()=>document.activeElement.dataset.creator),'member:10');
      const hit=await page.$eval('[data-creator="member:10"]',node=>{const r=node.getBoundingClientRect();return node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));});assert.equal(hit,true);
      if(process.env.QA_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.QA_SCREENSHOT_DIR}/toolbar-${options.width}-${options.rtl?'rtl':'ltr'}-text${options.textScale||1}-zoom${options.zoom||1}.png`});
      assert.equal(writes.length,0);
    }finally{await page.close();}
  });
}

test('List toggle names its destination, hides canvas tools and Snap changes only local preference',async()=>{
  const page=await mount();try{
    const selector='#notes-compact-view';
    const organizeLabel=await page.$eval('#notes-organize',node=>node.getAttribute('aria-label'));
    assert.equal(await page.$eval('#notes-organize-locked',node=>node.getAttribute('aria-label')),`${organizeLabel}: Include locked`);
    await page.click('#notes-organize-locked');
    assert.equal(writes.length,0,'Include locked only changes the next Organize scope');
    assert.equal(await page.$eval(selector,node=>node.getAttribute('aria-label')),'List view');
    await page.click(selector);
    assert.equal(await page.$eval(selector,node=>node.getAttribute('aria-label')),'Canvas view');
    assert.ok(await page.$(`${selector} [data-lucide="panels-top-left"]`));
    assert.equal(await page.$eval('#notes-zoom-controls',node=>node.hidden),true);
    await page.click(selector);assert.equal(await page.$eval(selector,node=>node.getAttribute('aria-label')),'List view');
    assert.equal(await page.$eval('#notes-snap-to-grid',node=>node.getAttribute('aria-pressed')),'false');
    const unselected=await page.$eval('#notes-snap-to-grid',node=>getComputedStyle(node).backgroundColor);
    await page.click('#notes-snap-to-grid');assert.equal(await page.$eval('#notes-snap-to-grid',node=>node.getAttribute('aria-pressed')),'true');
    assert.notEqual(await page.$eval('#notes-snap-to-grid',node=>getComputedStyle(node).backgroundColor),unselected);
    await page.click(selector);await page.click(selector);
    assert.equal(await page.$eval('#notes-snap-to-grid',node=>node.getAttribute('aria-pressed')),'true');assert.equal(writes.length,0);
  }finally{await page.close();}
});
