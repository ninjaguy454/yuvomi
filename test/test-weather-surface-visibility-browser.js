import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {existsSync,readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,extname,join,sep} from 'node:path';
import puppeteer from 'puppeteer';

// Real theme, board/card CSS and weather compositor; no application/household DB.
const root=process.env.WEATHER_VISIBILITY_PUBLIC_ROOT?resolve(process.env.WEATHER_VISIBILITY_PUBLIC_ROOT)+sep:fileURLToPath(new URL('../public/',import.meta.url)),output=process.env.WEATHER_VISIBILITY_EVIDENCE;
const card=(slot,name)=>`<article class="activity-card" data-card-color="${slot}"><div class="activity-card__surface"><div class="activity-card__summary"><button class="activity-card__open" onclick="this.dataset.taps=String(Number(this.dataset.taps||0)+1)"><strong class="activity-card__title">${name}</strong></button><p class="activity-card__meta">Home · Personal chore · Medium</p><button class="btn btn--secondary sample-control">Show subtasks</button><p>2 of 8 complete · 25%</p></div></div></article>`;
const html=`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles/named-appearance.css"><link rel="stylesheet" href="/styles/tokens.css"><link rel="stylesheet" href="/styles/reset.css"><link rel="stylesheet" href="/styles/layout.css"><link rel="stylesheet" href="/styles/tasks.css"><style>.app-content{margin:0!important;padding:12px!important;width:100%;height:100dvh}.tasks-page{height:100%}.activity-card__surface{min-height:220px}.activity-card__meta{margin:18px 0}.task-status-bucket__toggle{width:100%}.task-board__bucket-title h2{font-size:18px}</style></head><body><div class="app-shell"><main class="app-content"><div class="tasks-page"><div class="tasks-body"><div id="task-list"><div class="kanban-board task-board task-board--household"><section class="kanban-col task-board__bucket"><header class="kanban-col__header task-board__bucket-header"><div class="task-board__bucket-title"><h2>Synthetic member</h2><span class="kanban-col__count">2</span></div><button class="btn btn--ghost btn--icon task-board__bucket-sort" aria-label="Sort">↕</button></header><div class="task-board__bucket-scroll page-scrollport"><section class="task-status-bucket"><h3 class="task-status-bucket__heading"><button class="task-status-bucket__toggle" aria-expanded="true"><svg class="activity-card__chevron activity-card__chevron--open" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg><span>Active</span></button></h3>${card('slot-02-v1','Synthetic bedtime activity')}${card('neutral-v1','Synthetic laundry activity')}</section></div></section></div></div></div></div></main></div></body></html>`;
let server,browser,origin;
const compactHtml=html.replace('</head>','<link rel="stylesheet" href="/styles/calendar.css"></head>').replace(/<div class="tasks-page">[\s\S]*<\/main>/,'<section style="width:320px;margin:24px"><div class="month-day"><div class="month-day__event"><span class="compact-label">Synthetic month event</span></div></div><div class="allday-event"><span class="compact-label">Synthetic all-day event</span></div><div class="cal-task-chip"><span class="compact-label">Synthetic calendar task</span></div></section></main>');
const reports=[];
test.before(async()=>{
  if(output)mkdirSync(output,{recursive:true});
  server=createServer((req,res)=>{const url=new URL(req.url,'http://localhost'),pathname=url.pathname;if(pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(url.searchParams.has('compact')?compactHtml:html);return;}const file=resolve(root,'.'+pathname);if(!file.startsWith(root.endsWith(sep)?root:root+sep)||!existsSync(file)){res.writeHead(404).end();return;}res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.webp':'image/webp'})[extname(file)]||'text/plain');res.end(readFileSync(file));});
  await new Promise(done=>server.listen(0,'127.0.0.1',done));origin='http://127.0.0.1:'+server.address().port;
  browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH,args:['--mute-audio']});console.log('WEATHER_VISIBILITY_BROWSER_PID='+browser.process()?.pid);
});
test.after(async()=>{await browser?.close();server?.closeAllConnections();if(server)await new Promise(done=>server.close(done));if(output)writeFileSync(join(output,'rendering-results.json'),JSON.stringify(reports,null,2)+'\n');console.log('WEATHER_VISIBILITY_BROWSER_CLOSED');});
async function setup(page,condition,day,width,height,compact=false){
  await page.setViewport({width,height,deviceScaleFactor:1,isMobile:width<700,hasTouch:true});await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);await page.goto(origin+(compact?'/?compact=1':''));
  await page.evaluate(async({condition,day,width})=>{
    const mod=await import('/utils/named-appearance.js'),now=new Date(),theme={condition,is_day:day,observed_at:now.toISOString(),fetched_at:now.toISOString(),expires_at:new Date(+now+3600000).toISOString(),sunrise_at:null,sunset_at:null};
    const resolved=mod.resolveNamedAppearance({...mod.defaultNamedAppearance(),theme:'local-weather'},now,theme),root=document.documentElement;root.dataset.theme=resolved.theme.kind;root.dataset.namedTheme=resolved.theme.id;root.dataset.namedMaterial=resolved.theme.motif;if(width>=700)root.dataset.wallMode='';
    for(const [key,value]of Object.entries(mod.namedThemeVariables(resolved.theme)))root.style.setProperty(key,value);
    const phenomenon=condition==='rain'?['rain']:condition==='snow'?['snow']:['clear'];
    const scene={version:1,provider:'open-meteo',condition_code:condition==='rain'?63:condition==='snow'?73:0,phenomena:phenomenon,precipitation:{kind:condition==='rain'?'rain':condition==='snow'?'snow':'none',intensity:condition==='sunny'?null:'moderate'},wind:{speed_mps:3,gust_mps:5,from_degrees:270},cloud_cover:condition==='sunny'?0:.85,visibility_m:10000,solar:{is_day:day,sunrise_at:null,sunset_at:null}};
    window.scene=(await import('/utils/local-weather-scene.js')).mountLocalWeatherScene();window.scene.update({theme,scene});
  },{condition,day,width});
  await page.waitForFunction(()=>[...document.querySelectorAll('.local-weather-art')].every(node=>node.complete&&node.naturalWidth));await page.evaluate(()=>document.fonts.ready);
}
async function pixels(page){
  const shown=await page.screenshot({encoding:'base64'});await page.$$eval('.local-weather-card-rim',nodes=>nodes.forEach(node=>node.style.visibility='hidden'));const hidden=await page.screenshot({encoding:'base64'});await page.$$eval('.local-weather-card-rim',nodes=>nodes.forEach(node=>node.style.removeProperty('visibility')));
  return page.evaluate(async({shown,hidden})=>{
    const decode=async source=>{const image=new Image();image.src='data:image/png;base64,'+source;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const c=canvas.getContext('2d');c.drawImage(image,0,0);return{width:canvas.width,pixels:c.getImageData(0,0,canvas.width,canvas.height).data};};const a=await decode(shown),b=await decode(hidden);
    return [...document.querySelectorAll('.activity-card')].map(node=>{const r=node.getBoundingClientRect();let edge=0,innerEdge=0,center=0;for(let y=Math.max(0,Math.ceil(r.top));y<Math.min(innerHeight,Math.floor(r.bottom));y++)for(let x=Math.max(0,Math.ceil(r.left));x<Math.min(innerWidth,Math.floor(r.right));x++){const i=(y*a.width+x)*4,d=Math.max(...[0,1,2].map(k=>Math.abs(a.pixels[i+k]-b.pixels[i+k])));if(d<12)continue;const inset=Math.min(x-r.left,r.right-x,y-r.top,r.bottom-y);if(inset<14)edge++;if(inset>=4&&inset<12)innerEdge++;if(inset>=16)center++;}return{edge,innerEdge,center};});
  },{shown,hidden});
}
async function state(page){return page.evaluate(()=>{
  const rgba=value=>{const c=document.createElement('canvas').getContext('2d');c.clearRect(0,0,1,1);c.fillStyle=value;c.fillRect(0,0,1,1);return [...c.getImageData(0,0,1,1).data];};
  const luminance=rgb=>rgb.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
  const control=document.querySelector('.task-status-bucket__toggle>.activity-card__chevron'),css=getComputedStyle(control),ink=luminance(rgba(css.color)),backing=rgba(css.backgroundColor),surface=luminance(backing);
  return{chevron:{alpha:backing[3]/255,contrast:(Math.max(ink,surface)+.05)/(Math.min(ink,surface)+.05)},bucketAlpha:rgba(getComputedStyle(document.querySelector('.task-board__bucket')).backgroundColor)[3]/255,cards:[...document.querySelectorAll('.activity-card')].map(n=>({transform:getComputedStyle(n).transform,alpha:rgba(getComputedStyle(n).backgroundColor)[3]/255})),stats:window.scene.getStats(),rimPointers:[...document.querySelectorAll('.local-weather-card-rim,.local-weather-card-rim *')].map(n=>getComputedStyle(n).pointerEvents),overflow:document.documentElement.scrollWidth>innerWidth+1};
});}
for(const [width,height]of [[390,844],[1280,800]])for(const [condition,day]of [['rain',true],['snow',true],['sunny',true],['sunny',false]])test(`weather surfaces remain perceptible and usable at ${width}px ${condition} ${day?'day':'night'}`,async()=>{
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  try{await setup(page,condition,day,width,height);const name=`${width}-${condition}-${day?'day':'night'}`,rendered=await pixels(page),s=await state(page);reports.push({name,...s,rendered,errors});if(output)await page.screenshot({path:join(output,name+'.png')});
    await page.tap('.activity-card__open');assert.equal(await page.$eval('.activity-card__open',n=>n.dataset.taps),'1','decorative weather cannot intercept touch');assert.ok(s.cards.every(n=>n.transform==='none'),'cards never sway');assert.equal(s.overflow,false);assert.deepEqual(errors,[]);assert.ok(s.rimPointers.every(value=>value==='none'));
    if(condition!=='sunny')assert.ok(rendered.every(row=>row.innerEdge>=24),`${condition} should paint visible detail on tinted and pale cards beyond the old clipped four-pixel edge: ${JSON.stringify(rendered)}`);
    else assert.ok(rendered.every(row=>row.edge===0&&row.center===0),'dry clear states have no wet or frosted card effects');
    assert.ok(rendered.every(row=>row.center===0),'weather decoration leaves the text area untouched');
    assert.equal(s.chevron.alpha,1,'collapse-state icon needs its own opaque photographic backing');assert.ok(s.chevron.contrast>=3,'collapse-state icon meets nontext control contrast');
    assert.ok(s.bucketAlpha<=.65,'weather Kanban column must reveal its landscape');assert.ok(s.cards.every(row=>row.alpha>=.89&&row.alpha<=.91),'card tint remains translucent and bounded for contrast');
  }finally{await page.close();}
});

test('wet edge motion stops for reduced motion and accessibility modes restore opaque surfaces',async()=>{
  const page=await browser.newPage();
  try{
    await setup(page,'rain',true,390,844);const beads=()=>page.$$eval('.local-weather-water-bead',nodes=>nodes.map(node=>node.style.transform));
    const frozen=await beads();await new Promise(done=>setTimeout(done,240));assert.deepEqual(await beads(),frozen);assert.equal((await state(page)).stats.rafActive,false,'reduced motion retains still visible droplets');
    await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'no-preference'}]);await page.waitForFunction(()=>window.scene.getStats().rafActive);const moving=await beads();await new Promise(done=>setTimeout(done,350));assert.notDeepEqual(await beads(),moving,'normal wet edges visibly drip');assert.ok((await state(page)).cards.every(row=>row.transform==='none'));
    const cdp=await page.createCDPSession();
    for(const feature of [{name:'prefers-reduced-transparency',value:'reduce'},{name:'forced-colors',value:'active'}]){
      await cdp.send('Emulation.setEmulatedMedia',{features:[feature]});await page.waitForFunction(()=>!window.scene.getStats().rafActive);await waitForOpaqueCards(page);const current=await state(page);assert.equal(current.bucketAlpha,1);assert.ok(current.cards.every(row=>row.alpha===1));assert.equal(await page.$eval('.local-weather-card-rim',node=>getComputedStyle(node).display),'none');
    }
    await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await cdp.detach();await page.evaluate(()=>window.scene.dispose());await waitForOpaqueCards(page);const plain=await stateAfterDispose(page);assert.equal(plain.bucketAlpha,1);assert.ok(plain.cards.every(alpha=>alpha===1));assert.equal(await page.$('.local-weather-card-rim'),null,'leaving weather removes all material decoration');
  }finally{await page.close();}
});
async function stateAfterDispose(page){return page.evaluate(()=>{const alpha=node=>{const c=document.createElement('canvas').getContext('2d');c.fillStyle=getComputedStyle(node).backgroundColor;c.fillRect(0,0,1,1);return c.getImageData(0,0,1,1).data[3]/255;};return{bucketAlpha:alpha(document.querySelector('.task-board__bucket')),cards:[...document.querySelectorAll('.activity-card')].map(alpha)};});}

async function waitForOpaqueCards(page){await page.waitForFunction(()=>[...document.querySelectorAll('.activity-card')].every(node=>{const c=document.createElement('canvas').getContext('2d');c.fillStyle=getComputedStyle(node).backgroundColor;c.fillRect(0,0,1,1);return c.getImageData(0,0,1,1).data[3]===255;}));}

test('compact calendar frost stays outside real month, all-day and task label glyphs',async()=>{
  const page=await browser.newPage();
  try{
    await setup(page,'snow',true,1280,800,true);const shown=await page.screenshot({encoding:'base64'});if(output)await page.screenshot({path:join(output,'1280-compact-calendar-snow.png')});
    await page.$$eval('.local-weather-card-rim',nodes=>nodes.forEach(node=>node.style.visibility='hidden'));const hidden=await page.screenshot({encoding:'base64'});
    const labels=await page.evaluate(async({shown,hidden})=>{
      const decode=async source=>{const image=new Image();image.src='data:image/png;base64,'+source;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const c=canvas.getContext('2d');c.drawImage(image,0,0);return{width:canvas.width,data:c.getImageData(0,0,canvas.width,canvas.height).data};};const a=await decode(shown),b=await decode(hidden);
      return [...document.querySelectorAll('.compact-label')].map(node=>{const range=document.createRange();range.selectNodeContents(node);const r=range.getBoundingClientRect(),host=node.parentElement.getBoundingClientRect(),color=document.createElement('canvas').getContext('2d');color.fillStyle=getComputedStyle(node).color;color.fillRect(0,0,1,1);const ink=[...color.getImageData(0,0,1,1).data].slice(0,3);let glyphs=0,changed=0,edgeChanges=0;for(let y=Math.ceil(r.top);y<Math.floor(r.bottom);y++)for(let x=Math.ceil(r.left);x<Math.floor(r.right);x++){const i=(y*a.width+x)*4;if(Math.max(...ink.map((v,k)=>Math.abs(b.data[i+k]-v)))>30)continue;glyphs++;if(Math.max(...[0,1,2].map(k=>Math.abs(a.data[i+k]-b.data[i+k])))>=12)changed++;}for(let y=Math.ceil(host.top);y<Math.floor(host.bottom);y++)for(let x=Math.ceil(host.left);x<Math.floor(host.right);x++){const i=(y*a.width+x)*4;if(Math.max(...[0,1,2].map(k=>Math.abs(a.data[i+k]-b.data[i+k])))>=12)edgeChanges++;}return{label:node.textContent,height:host.height,glyphs,changed,edgeChanges};});
    },{shown,hidden});reports.push({name:'compact-calendar-snow',labels});assert.equal(labels.length,3);assert.ok(labels.every(row=>row.height<40&&row.glyphs>20),'exercise actual dense calendar labels rather than tall fixture cards');assert.ok(labels.every(row=>row.edgeChanges>=10),'compact frost remains visible at its outer edge');assert.ok(labels.every(row=>row.changed===0),'frost cannot paint over compact label glyphs: '+JSON.stringify(labels));
  }finally{await page.close();}
});
