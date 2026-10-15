import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {existsSync,readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join,resolve,extname} from 'node:path';
import puppeteer from 'puppeteer';

const publicRoot=fileURLToPath(new URL('../public/',import.meta.url));
const html=`<!doctype html><html data-theme="light"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles/tokens.css"><link rel="stylesheet" href="/styles/reset.css"><link rel="stylesheet" href="/styles/layout.css"><link rel="stylesheet" href="/styles/tasks.css"><link rel="stylesheet" href="/styles/notes.css"><link rel="stylesheet" href="/styles/calendar.css"><link rel="stylesheet" href="/styles/local-weather-scene.css"><style>.app-content{flex:none;padding:40px;width:min(420px,100%);margin-left:auto}.activity-card,.note-card,.agenda-event{margin-bottom:24px;min-height:120px}.agenda-event{position:relative;background:#ebd8b5;color:#24221d}.test-control{min-height:44px}</style></head><body><div class="app-shell"><main class="app-content"><article class="activity-card" data-card-color="slot-01-v1" style="background:#c6dfd5;color:#14362c"><div class="activity-card__surface"><div class="activity-card__summary"><strong class="activity-card__title">Synthetic household task</strong><button class="test-control">Complete task</button></div></div></article><article class="note-card" style="--note-color:#e2c56e"><h2>Synthetic note</h2><button class="test-control">Edit note</button></article><article class="list-row agenda-event"><strong>Synthetic event</strong><button class="test-control">Open event</button></article></main></div></body></html>`;
const facts=()=>({version:1,provider:'open-meteo',condition_code:99,phenomena:['thunder','rain','snow','hail'],precipitation:{kind:'mixed',intensity:'heavy'},wind:{speed_mps:12,gust_mps:20,from_degrees:270},cloud_cover:1,visibility_m:null,solar:{is_day:true,sunrise_at:null,sunset_at:null}});

async function fixture(){
  assert.ok(existsSync(join(publicRoot,'utils/local-weather-scene.js')),'renderer exists before browser launch');
  const errors=[],server=createServer((req,res)=>{
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end(html);return;}
    const path=resolve(publicRoot,'.'+pathname);
    if(!path.startsWith(publicRoot)||!existsSync(path)){res.statusCode=404;res.end();return;}
    res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.webp':'image/webp','.json':'application/json'})[extname(path)]||'text/plain');res.end(readFileSync(path));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try{browser=await puppeteer.launch({headless:true,timeout:12000,args:['--mute-audio'],executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||(process.platform==='win32'?'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe':undefined)});}
  catch(error){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));throw error;}
  console.log('RENDERER_BROWSER_PID='+browser.process()?.pid);
  const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
  page.setDefaultTimeout(10000);
  const origin='http://127.0.0.1:'+server.address().port;
  return {page,errors,origin,async close(){const pid=browser.process()?.pid;await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));console.log('RENDERER_BROWSER_CLOSED_PID='+pid);}};
}
const mount=async(page,origin)=>{
  await page.goto(origin);
  return page.evaluate(async scene=>{
    const mod=await import('/utils/local-weather-scene.js');
    window.testFlashes=[];window.testScene=mod.mountLocalWeatherScene({onFlash:event=>window.testFlashes.push(event)});
    window.testScene.update({theme:{condition:'storm',is_day:true,sunrise_at:null,sunset_at:null},scene});
  },facts());
};
const cards=page=>page.$$eval('.activity-card,.note-card,.agenda-event',nodes=>nodes.map(node=>{const r=node.getBoundingClientRect(),s=getComputedStyle(node);return {x:r.x,y:r.y,width:r.width,height:r.height,transform:s.transform,background:s.backgroundColor,color:s.color,text:node.innerText};}));
const capture=async(page,name)=>{if(process.env.LOCAL_WEATHER_SCENE_REVIEW_DIR){mkdirSync(process.env.LOCAL_WEATHER_SCENE_REVIEW_DIR,{recursive:true});await page.screenshot({path:join(process.env.LOCAL_WEATHER_SCENE_REVIEW_DIR,'integration-renderer-'+name+'.png')});}};

async function compareSkyPixels(page){
  const visible=await page.screenshot({encoding:'base64'});
  await page.$$eval('.local-weather-night-wash,.local-weather-stars',nodes=>nodes.forEach(node=>node.style.visibility='hidden'));
  let plain;
  try{plain=await page.screenshot({encoding:'base64'});}
  finally{await page.$$eval('.local-weather-night-wash,.local-weather-stars',nodes=>nodes.forEach(node=>node.style.removeProperty('visibility')));}
  return page.evaluate(async({visible,plain})=>{
    async function decode(source,width=null,height=null){const image=new Image();image.src=source;await image.decode();const canvas=document.createElement('canvas');canvas.width=width||image.naturalWidth;canvas.height=height||image.naturalHeight;const context=canvas.getContext('2d');context.drawImage(image,0,0,canvas.width,canvas.height);return{width:canvas.width,height:canvas.height,pixels:context.getImageData(0,0,canvas.width,canvas.height).data};}
    const a=await decode('data:image/png;base64,'+visible),b=await decode('data:image/png;base64,'+plain),mask=await decode('/assets/weather/cole-sky-mask.webp',96,63),g=window.testScene.getStats().artCamera;
    const blocked=[...document.querySelectorAll('.activity-card,.note-card,.agenda-event,.local-weather-credit,button')].map(node=>node.getBoundingClientRect());
    const scale=a.width/innerWidth,at=(image,x,y)=>{const i=(Math.round(y*scale)*image.width+Math.round(x*scale))*4;return Array.from(image.pixels.slice(i,i+3));};
    const luminance=rgb=>rgb.map(value=>value/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4).reduce((sum,value,i)=>sum+value*[.2126,.7152,.0722][i],0);
    const sky=[];
    for(let y=3;y<29;y+=3)for(let x=3;x<94;x+=5){const i=(y*96+x)*4;if(mask.pixels[i]<235||mask.pixels[i+3]<230)continue;
      const sx=(x+.5)/96*g.width-g.left,sy=(y+.5)/63*g.height-g.top;if(sx<8||sx>innerWidth-8||sy<8||sy>innerHeight-8||blocked.some(r=>sx>=r.left&&sx<=r.right&&sy>=r.top&&sy<=r.bottom))continue;
      sky.push({before:luminance(at(b,sx,sy)),after:luminance(at(a,sx,sy))});}
    const median=values=>values.sort((x,y)=>x-y)[Math.floor(values.length/2)]||0;
    const before=median(sky.map(row=>row.before)),after=median(sky.map(row=>row.after));
    const terrain=[[.25,.78],[.48,.65],[.70,.90]].map(([x,y])=>{const sx=x*g.width-g.left,sy=y*g.height-g.top;const c=at(a,sx,sy),d=at(b,sx,sy);return Math.max(...c.map((value,i)=>Math.abs(value-d[i])));});
    return{skySamples:sky.length,skyMedianBefore:before,skyMedianAfter:after,skyLuminanceRatio:after/before,terrainMaxChannelChange:Math.max(...terrain)};
  },{visible,plain});
}

test('clear-night sky has a masked dark treatment and static stars beneath weather clouds',async()=>{
  const f=await fixture(),{page}=f;
  try{
    await page.setViewport({width:1280,height:900});await page.goto(f.origin);const before=await cards(page);
    await page.evaluate(async()=>{
      const {mountLocalWeatherScene}=await import('/utils/local-weather-scene.js');window.testScene=mountLocalWeatherScene();
      window.clearNightFacts={version:1,provider:'open-meteo',condition_code:0,phenomena:['clear'],precipitation:{kind:'none',intensity:null},wind:{speed_mps:null,gust_mps:null,from_degrees:null},cloud_cover:0,visibility_m:null,solar:{is_day:false,sunrise_at:null,sunset_at:null}};
      window.testScene.update({theme:{condition:'sunny',is_day:false,sunrise_at:null,sunset_at:null},scene:window.clearNightFacts});
    });
    await page.waitForFunction(()=>window.testScene.getStats().skyPickerReady);
    await page.waitForFunction(()=>[...document.querySelectorAll('.local-weather-art')].every(image=>image.complete&&image.naturalWidth));
    await capture(page,'night-clear');
    assert.ok(await page.$('.local-weather-night-wash'),'registered sky darkening exists');
    assert.ok(await page.$('.local-weather-stars'),'registered star layer exists');
    let stats=await page.evaluate(()=>window.testScene.getStats());
    assert.equal(stats.skyStars,72);assert.ok(stats.nightSkyDarkness>.5&&stats.starOpacity>.8);
    assert.equal(stats.rafActive,false,'clear stars add no animation loop');
    const nightPixels=await compareSkyPixels(page);
    assert.ok(nightPixels.skySamples>=8&&nightPixels.skyLuminanceRatio<.5,'actual masked sky is substantially darker');
    assert.ok(nightPixels.terrainMaxChannelChange<=1,'night sky layer leaves landscape pixels unchanged');
    assert.equal(await page.$$eval('.local-weather-stars circle',nodes=>nodes.length),72);
    assert.equal(await page.$eval('.local-weather-stars',node=>getComputedStyle(node).pointerEvents),'none');
    assert.ok(await page.evaluate(()=>{const world=document.querySelector('.local-weather-sky-world');return world.querySelector('.local-weather-night-wash')&&world.querySelector('.local-weather-stars').nextElementSibling.classList.contains('local-weather-cloud-strip');}));
    assert.deepEqual(await cards(page),before);
    const unsupported=await page.evaluate(()=>{
      const entries=[...document.styleSheets].filter(value=>value.href?.endsWith('/styles/local-weather-scene.css')).map(sheet=>{
        const index=[...sheet.cssRules].findIndex(rule=>rule.type===CSSRule.SUPPORTS_RULE&&rule.cssText.includes('.local-weather-night-wash'));
        return {sheet,index,original:index<0?null:sheet.cssRules[index].cssText};
      });
      if(!entries.length||entries.some(value=>value.index<0))return null;
      for(const {sheet,index}of entries){sheet.deleteRule(index);sheet.insertRule('@supports (mask-mode:not-a-real-mode){.local-weather-night-wash,.local-weather-stars{display:block}}',index);}
      try{return ['.local-weather-night-wash','.local-weather-stars'].map(selector=>getComputedStyle(document.querySelector(selector)).display);}
      finally{for(const {sheet,index,original}of entries){sheet.deleteRule(index);sheet.insertRule(original,index);}}
    });
    assert.deepEqual(unsupported,['none','none'],'unavailable luminance mask hides new full-world layers');
    for(const phenomena of [['smoke'],['haze'],[],['clear','smoke']]){
      await page.evaluate(phenomena=>window.testScene.update({theme:{condition:'cloudy',is_day:false},scene:{...window.clearNightFacts,phenomena,precipitation:{kind:phenomena.includes('clear')?'none':'unknown',intensity:null}}}),phenomena);
      assert.equal((await page.evaluate(()=>window.testScene.getStats())).starOpacity,0,'rich unknown and obscured skies have no stars');
    }
    await page.evaluate(()=>window.testScene.update({theme:{condition:'sunny',is_day:true},scene:{...window.clearNightFacts,solar:{is_day:true,sunrise_at:null,sunset_at:null}}}));
    await page.waitForFunction(()=>window.testScene.getStats().starOpacity===0&&window.testScene.getStats().nightSkyDarkness===0);
    await page.waitForFunction(()=>!window.testScene.getStats().rafActive);
    const dayPixels=await compareSkyPixels(page);assert.ok(Math.abs(dayPixels.skyLuminanceRatio-1)<.005&&dayPixels.terrainMaxChannelChange<=1,'day composition stays unchanged');
    if(process.env.LOCAL_WEATHER_SCENE_REVIEW_DIR)writeFileSync(join(process.env.LOCAL_WEATHER_SCENE_REVIEW_DIR,'night-sky-pixel-verification.json'),JSON.stringify({night:nightPixels,day:dayPixels},null,2)+'\n');
    await capture(page,'clear-day');
    await page.evaluate(()=>window.testScene.update({theme:{condition:'cloudy',is_day:false},scene:{...window.clearNightFacts,condition_code:3,phenomena:['overcast'],cloud_cover:1}}));
    await page.waitForFunction(()=>window.testScene.getStats().scene.clouds===1);
    assert.equal((await page.evaluate(()=>window.testScene.getStats())).starOpacity,0);await capture(page,'night-cloud');
    await page.evaluate(scene=>window.testScene.update({theme:{condition:'storm',is_day:false},scene:{...scene,solar:{is_day:false,sunrise_at:null,sunset_at:null}}}),facts());
    await page.waitForFunction(()=>window.testScene.getStats().scene.lightning);
    assert.equal((await page.evaluate(()=>window.testScene.getStats())).starOpacity,0);await capture(page,'night-storm');
    await page.evaluate(()=>window.testScene.dispose());assert.deepEqual(f.errors,[]);
    assert.equal(await page.$('.local-weather-stars,.local-weather-night-wash'),null);
  }finally{await f.close();}
});

test('clouds and precipitation follow the same reported west and east wind',async()=>{
  const f=await fixture(),{page}=f;
  try{
    await page.setViewport({width:1920,height:1080});await mount(page,f.origin);
    const sample=()=>page.evaluate(()=>({x:new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.local-weather-cloud-strip')).transform).m41,travel:window.testScene.getStats().scene.windTravel}));
    await page.waitForFunction(()=>window.testScene.getStats().scene.windX>.2);const west=await sample();await new Promise(resolve=>setTimeout(resolve,500));const afterWest=await sample();
    assert.ok(afterWest.travel>west.travel&&afterWest.x>west.x,'west wind moves both precipitation travel and tiled clouds right');
    await page.evaluate(scene=>window.testScene.update({theme:{condition:'storm',is_day:true},scene:{...scene,wind:{speed_mps:12,gust_mps:20,from_degrees:90}}}),facts());
    await page.waitForFunction(()=>window.testScene.getStats().scene.windX<-.2);const east=await sample();await new Promise(resolve=>setTimeout(resolve,500));const afterEast=await sample();
    assert.ok(afterEast.travel<east.travel&&afterEast.x<east.x,'east wind moves both precipitation travel and tiled clouds left');
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

test('ending ownership inside a flash callback stops remaining frame work without errors',async()=>{
  const f=await fixture(),{page}=f;
  try{
    await page.setViewport({width:1920,height:1080});await page.goto(f.origin);
    await page.evaluate(async scene=>{const {mountLocalWeatherScene}=await import('/utils/local-weather-scene.js');window.testScene=mountLocalWeatherScene({onFlash:()=>window.testScene.dispose()});window.testScene.update({theme:{condition:'storm',is_day:true,sunrise_at:null,sunset_at:null},scene});},facts());
    await page.waitForFunction(()=>window.testScene.getStats().disposed,{timeout:8000});
    assert.deepEqual(f.errors,[],'an ending owner cannot leave frame work dereferencing cleared facts');
    assert.equal(await page.$('.local-weather-scene,.local-weather-card-rim'),null);
    assert.equal((await page.evaluate(()=>window.testScene.getStats())).rafActive,false);
  }finally{await f.close();}
});

test('real card CSS keeps fills, content, bounds and controls while registered weather runs and clears',async()=>{
  const f=await fixture(),{page}=f;
  try{
    await page.setViewport({width:1920,height:1080});await page.goto(f.origin);const before=await cards(page);
    await mount(page,f.origin);await page.waitForFunction(()=>window.testScene.getStats().skyPickerReady&&window.testScene.getStats().materialFaces===3).catch(async error=>{throw Error(error.message+' '+JSON.stringify({errors:f.errors,stats:await page.evaluate(()=>window.testScene?.getStats())}));});
    await page.waitForFunction(()=>window.testScene.getStats().scene.snowMass>.03);
    assert.deepEqual(await cards(page),before);
    assert.equal(await page.$eval('.local-weather-credit',n=>n.textContent),'Crawford Notch — Thomas Cole, 1839 · Weather adaptation');
    assert.ok((await page.$eval('.local-weather-credit',n=>n.href)).startsWith('https://www.nga.gov/artworks/50727'));
    const imageGeometry=await page.$$eval('.local-weather-art',nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};}));
    assert.ok(imageGeometry.every(g=>JSON.stringify(g)===JSON.stringify(imageGeometry[0])));
    assert.equal(await page.$eval('.local-weather-card-rim',n=>getComputedStyle(n).pointerEvents),'none');
    await page.$eval('.test-control',n=>{n.dataset.clicked='0';n.addEventListener('click',()=>n.dataset.clicked='1');});await page.click('.test-control');
    assert.equal(await page.$eval('.test-control',n=>n.dataset.clicked),'1');
    await capture(page,'desktop');
    for(const [width,height]of [[3440,1080],[2048,667],[390,844]]){
      await page.setViewport({width,height});await page.waitForFunction(width=>window.testScene.getStats().artCamera?.boxWidth===width,{},width);
      const g=await page.evaluate(()=>window.testScene.getStats().artCamera);
      assert.equal(g.fit,'cover');
      if(width<=700)assert.ok(g.width>=g.boxWidth&&g.height>=g.boxHeight,'portrait painting covers the whole viewport');
      else assert.ok([[.5,.215],[.46,.65],[.30,.765],[.58,.835]].every(([x,y])=>x*g.width-g.left>=0&&x*g.width-g.left<=g.boxWidth&&y*g.height-g.top>=0&&y*g.height-g.top<=g.boxHeight));
      if(width>700){
        const pan=await page.evaluate(()=>{const host=document.querySelector('.app-content'),height=window.testScene.getStats().artCamera.boxHeight-innerHeight;host.scrollTop=height;return{wanted:height,actual:host.scrollTop};});
        assert.ok(pan.actual>=pan.wanted-1,'approved wide artwork can be revealed by ordinary app scrolling');
        await page.waitForFunction(()=>window.testScene.getStats().artCamera.visibleTop>0);
        await page.evaluate(()=>{document.querySelector('.app-content').scrollTop=0;});
      }
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await capture(page,width+'x'+height);
    }
    await page.setViewport({width:1920,height:1080});await page.waitForFunction(()=>window.testScene.getStats().artCamera?.boxWidth===1920);
    await page.waitForFunction(()=>window.testFlashes.length>0,{timeout:8000});
    const flash=await page.evaluate(()=>({event:window.testFlashes[0],stats:window.testScene.getStats()}));
    assert.ok(flash.event.id&&flash.event.delayMs>=2000&&flash.event.delayMs<=4000);
    assert.ok(flash.stats.flashes[0].maskVerified);
    await page.evaluate(()=>window.testScene.update({theme:{condition:'sunny',is_day:true},scene:null}));
    const fallback=await page.evaluate(()=>window.testScene.getStats());assert.equal(fallback.scene.wet,0);assert.equal(fallback.scene.snowMass,0);assert.equal(fallback.rafActive,false);assert.equal(fallback.flashActive,false);
    await page.evaluate(()=>{window.testScene.dispose();window.testScene.dispose();window.testScene.update({theme:{condition:'storm'},scene:{version:1}});});
    const disposed=await page.evaluate(()=>window.testScene.getStats());assert.equal(disposed.disposed,true);assert.equal(disposed.listenerCount,0);assert.equal(disposed.materialFaces,0);assert.equal(disposed.observerCount,0);assert.equal(disposed.rafActive,false);
    assert.equal(await page.$('.local-weather-scene,.local-weather-credit,.local-weather-card-rim'),null);assert.deepEqual(await cards(page),before);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

test('media and foreground lifecycle freeze all decorative motion and dispose image/listener work',async()=>{
  const f=await fixture(),{page}=f;
  try{
    await page.setViewport({width:1280,height:900});await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);await mount(page,f.origin);
    let stats=await page.evaluate(()=>window.testScene.getStats());assert.equal(stats.rafActive,false);assert.equal(stats.particles,0);assert.equal(stats.flashActive,false);
    await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'no-preference'}]);await page.waitForFunction(()=>window.testScene.getStats().rafActive);
    await page.evaluate(()=>window.dispatchEvent(new Event('blur')));stats=await page.evaluate(()=>window.testScene.getStats());assert.equal(stats.rafActive,false);assert.equal(stats.flashActive,false);
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.waitForFunction(()=>window.testScene.getStats().rafActive);
    const media=await page.createCDPSession();await media.send('Emulation.setEmulatedMedia',{features:[{name:'forced-colors',value:'active'}]});await page.waitForFunction(()=>!window.testScene.getStats().rafActive);
    assert.equal(await page.$eval('.local-weather-scene',n=>getComputedStyle(n).display),'none');
    await media.send('Emulation.setEmulatedMedia',{features:[{name:'forced-colors',value:'none'}]});await page.waitForFunction(()=>window.testScene.getStats().rafActive);
    await media.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-transparency',value:'reduce'}]});await page.waitForFunction(()=>!window.testScene.getStats().rafActive);
    assert.equal(await page.$eval('.local-weather-card-rim',n=>getComputedStyle(n).display),'none');
    await media.send('Emulation.setEmulatedMedia',{features:[]});await page.waitForFunction(()=>window.testScene.getStats().rafActive);await media.detach();
    await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));stats=await page.evaluate(()=>window.testScene.getStats());assert.equal(stats.rafActive,false);
    await page.evaluate(()=>window.testScene.dispose());assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
