import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const moduleUrl = new URL('../public/utils/local-weather-scene.js', import.meta.url);
const modelUrl = new URL('../public/utils/local-weather-scene/model.js', import.meta.url);
const load = async url => {
  assert.ok(existsSync(url), 'approved decorative renderer module exists');
  return import(url.href);
};
const theme = {condition:'storm',is_day:true,sunrise_at:null,sunset_at:null};
const facts = patch => ({version:1,phenomena:['thunder'],precipitation:{kind:'unknown',intensity:null},wind:{speed_mps:null,gust_mps:null,from_degrees:null},cloud_cover:null,visibility_m:null,solar:{is_day:true,sunrise_at:null,sunset_at:null},...patch});

test('missing precipitation and wind remain unknown, with no invented rain, direction or gust', async () => {
  const { deriveSceneTargets } = await load(modelUrl);
  const target = deriveSceneTargets(theme, facts(), Date.parse('2026-10-14T12:00Z'));
  assert.equal(target.precipitationKind, 'unknown');
  assert.equal(target.rain, 0);
  assert.equal(target.lightning, true);
  assert.deepEqual(target.wind, {speed_mps:null,gust_mps:null,from_degrees:null});
  assert.equal(target.windX, 0);
  assert.equal(target.gust, 0);
});

test('reported meteorological wind direction is projected consistently without raising a lower gust', async () => {
  const { deriveSceneTargets } = await load(modelUrl);
  const west = deriveSceneTargets(theme, facts({wind:{speed_mps:12,gust_mps:8,from_degrees:270}}), 0, 3);
  const east = deriveSceneTargets(theme, facts({wind:{speed_mps:12,gust_mps:8,from_degrees:90}}), 0, 3);
  assert.equal(west.wind.gust_mps, 8);
  assert.ok(west.windX > 0 && east.windX < 0);
  assert.ok(Math.abs(west.windX + east.windX) < 1e-8);
  const noDirection = deriveSceneTargets(theme, facts({wind:{speed_mps:12,gust_mps:20,from_degrees:null}}), 0, 3);
  assert.equal(noDirection.windX, 0);
});

test('snow, freezing liquid and hail use supported facts without temperature guesses', async () => {
  const { deriveSceneTargets } = await load(modelUrl);
  const mixed = deriveSceneTargets(theme, facts({phenomena:['snow','rain','freezing-liquid'],precipitation:{kind:'mixed',intensity:'heavy'}}),0);
  assert.equal(mixed.rain, 1.5);
  assert.equal(mixed.snow, 1.5);
  assert.equal(mixed.freezing, true);
  assert.equal(deriveSceneTargets(theme,facts({phenomena:['hail','thunder']}),0).hail,1);
  assert.equal(deriveSceneTargets(theme,facts({phenomena:['clear'],temperature_c:-20}),0).freezing,false);
});

test('residue is bounded, persists through a valid change, dries and melts, then clears on null facts', async () => {
  const { createSceneDynamics } = await load(modelUrl);
  const d = createSceneDynamics();
  d.update(theme,facts({phenomena:['rain','snow'],precipitation:{kind:'mixed',intensity:'heavy'}}));
  for(let i=0;i<900;i++)d.advance(.08,i*.08,Date.parse('2026-10-14T12:00Z'));
  const accumulated=d.frame();
  assert.ok(accumulated.wet > .9 && accumulated.snowMass > .9);
  assert.ok(accumulated.wet <= 1 && accumulated.snowMass <= 1 && accumulated.ice <= 1);
  d.update({...theme,condition:'sunny'},facts({phenomena:['clear'],precipitation:{kind:'none',intensity:null}}));
  assert.ok(d.frame().snowMass > 0);
  for(let i=0;i<1800;i++)d.advance(.08,i*.08,Date.parse('2026-10-14T12:00Z'));
  assert.equal(d.frame().wet,0);
  assert.equal(d.frame().snowMass,0);
  d.update(theme,facts({phenomena:['snow'],precipitation:{kind:'snow',intensity:'moderate'}}));
  d.advance(.08,0,0,true);
  assert.ok(d.frame().snowMass > 0);
  d.update(theme,null);
  assert.equal(d.frame().wet,0);
  assert.equal(d.frame().snowMass,0);
  assert.equal(d.frame().ice,0);
  assert.equal(d.frame().rich,false);
  assert.equal(d.pending(),false);
});

test('solar interpolation uses only a valid pair and falls back to is_day', async () => {
  const { solarGrade }=await load(modelUrl);
  const rise=Date.parse('2026-10-14T06:00Z'),set=Date.parse('2026-10-14T18:00Z');
  assert.equal(solarGrade(rise,rise,set,true),.5);
  assert.equal(solarGrade(set,rise,set,false),.5);
  assert.equal(solarGrade(rise,null,null,false),0);
  assert.equal(solarGrade(set,set,rise,true),1);
});

test('snow residue accumulates at the production thirty frame cadence',async()=>{
  const {createSceneDynamics}=await load(modelUrl),d=createSceneDynamics();
  d.update(theme,facts({phenomena:['snow'],precipitation:{kind:'snow',intensity:'moderate'}}));
  for(let i=0;i<150;i++)d.advance(1/30,i/30,0);
  assert.ok(d.frame().snowMass>.1,'active snow is not discarded as rounding residue');
});

test('CSS subpixel rounding retains the approved wide cover camera',async()=>{
  const {cameraGeometry}=await load(modelUrl);
  assert.equal(cameraGeometry(3440,1638.09375).fit,'cover');
});

test('registered camera preserves full painting on mobile and ultrawide, using approved desktop position', async () => {
  const { cameraGeometry }=await load(modelUrl);
  const desktop=cameraGeometry(1920,1080),mobile=cameraGeometry(390,844),wide=cameraGeometry(3440,1080);
  assert.equal(desktop.fit,'cover');
  assert.equal(desktop.left,(desktop.width-1920)*.5);
  assert.equal(desktop.top,(desktop.height-1080)*.52);
  assert.equal(mobile.width,390);
  assert.ok(Math.abs(mobile.height-390*1042/1600)<.001);
  assert.equal(mobile.fit,'contain');
  assert.equal(wide.fit,'contain');
  assert.ok(wide.visibleSource.left<=0 && wide.visibleSource.right>=1);
  assert.ok(wide.visibleSource.top<=0 && wide.visibleSource.bottom>=1);
});

test('sky pulse picker qualifies mask pixels, avoids controls and varies location', async () => {
  const { chooseVisibleSkyPoint,cameraGeometry }=await load(modelUrl);
  const geometry=cameraGeometry(1280,900),pixels=new Uint8ClampedArray(96*63*4);
  for(let y=4;y<25;y++)for(let x=4;x<92;x++)pixels.set([255,255,255,255],(y*96+x)*4);
  const blocked=[{left:850,top:0,right:1280,bottom:900}],first=chooseVisibleSkyPoint(pixels,geometry,blocked,null,()=>.1);
  assert.ok(first?.maskVerified);
  assert.ok(first.visibleX < 835);
  const second=chooseVisibleSkyPoint(pixels,geometry,blocked,first,()=>.9);
  assert.ok(Math.abs(second.visibleX-first.visibleX)>100);
  assert.equal(chooseVisibleSkyPoint(new Uint8ClampedArray(pixels.length),geometry,[],null),null);
});

test('mount is harmless in non-browser and minimal named-runtime DOM hosts', async () => {
  const { mountLocalWeatherScene }=await load(moduleUrl);
  for(const doc of [undefined,{}, {documentElement:{},body:{}}]){
    const previous=globalThis.document;
    try{
      globalThis.document=doc;
      const mounted=mountLocalWeatherScene();
      assert.deepEqual(Object.keys(mounted).sort(),['dispose','getStats','update']);
      mounted.update({theme,scene:facts()});
      mounted.dispose();mounted.dispose();
      mounted.update({theme,scene:facts()});
      assert.equal(mounted.getStats().disposed,true);
      assert.equal(mounted.getStats().rafActive,false);
    }finally{globalThis.document=previous;}
  }
});

test('large card sets build frost only on visible active rims and use global particle budgets',async()=>{
  const {createCardMaterials}=await load(new URL('../public/utils/local-weather-scene/materials.js',import.meta.url));
  // Minimal host primitives supply layout; assertions target real renderer work.
  const node=()=>({className:'',style:{setProperty(){}},dataset:{},children:[],classList:{add(){},remove(){}},setAttribute(){},append(...children){this.children.push(...children);},remove(){},closest(){return null;}});
  const cards=Array.from({length:80},(_,i)=>Object.assign(node(),{isConnected:true,offsetWidth:180,offsetHeight:120,getBoundingClientRect:()=>({left:(i%10)*200,top:Math.floor(i/10)*180,right:(i%10)*200+180,bottom:Math.floor(i/10)*180+120})}));
  const doc={body:node(),createElement:node,querySelectorAll:()=>cards};
  const win={innerWidth:1280,innerHeight:900,getComputedStyle:()=>({position:'relative'}),requestAnimationFrame:()=>1,cancelAnimationFrame(){}};
  const materials=createCardMaterials({document:doc,window:win,onChange(){}});
  try{
    assert.equal(materials.getStats().frostBuilds,0,'clear startup does not generate unused frost SVG');
    const frame={rain:1,wet:1,snowMass:1,snow:1,ice:1,gust:.7,windX:1};
    materials.update(frame,2,false,false);const stats=materials.getStats();
    assert.ok(stats.activeMaterialFaces<=6);
    assert.ok(stats.activeWaterBeads<=36);
    assert.ok(stats.activeSnowPatches<=8);
    assert.ok(stats.activeSnowFragments<=16);
    assert.ok(stats.frostBuilds<=6);
    materials.update({...frame,rain:0,wet:0,snowMass:0,snow:0,ice:0},3,false,false);
    assert.equal(materials.getStats().activeMaterialFaces,0);
  }finally{materials.dispose();}
  assert.equal(materials.getStats().materialFaces,0);
});

test('selected Cole asset bytes match the approved evidence', () => {
  const expected={
    'clear-day':'c023fb352d81c23b5eb7018e1cfbbb02b3225cd8b2a471c57fa6c7e6ed95a537',
    'clear-night':'a03f371e610b5c0e02be85e814f8400701f0476d9e42e331bf82020ded34af9d',
    'snow-day':'db6bcef2c701ab36b0d0369a741fa95ff1c28abd0da9f5e11c4908113dc38956',
    'snow-night':'39eb8da65174066239ac7535497b5a4487ea57dbf513264ffff57cf42382f132',
    'sky-mask':'eee607eea1072f09324d95cea07653ad88216e45c0916dddaa88788544a43a27',
    'clouds':'9ddde731755c8b8f9117c739ef18098e37b8ad46de7ef669313222c3373d0300'
  };
  for(const [name,hash]of Object.entries(expected)){
    const file=new URL('../public/assets/weather/cole-'+name+'.webp',import.meta.url);
    assert.ok(existsSync(file),name+' asset exists');
    assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'),hash);
  }
});
