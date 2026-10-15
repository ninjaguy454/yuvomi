import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {defaultNamedAppearance,resolveNamedAppearance} from '../public/utils/named-appearance.js';
import {deriveSceneTargets} from '../public/utils/local-weather-scene/model.js';
process.env.DB_PATH=':memory:';
const {buildRouter}=await import('../server/routes/weather.js');
const time=Date.parse('2026-10-14T12:00:00.000Z');
const om=()=>({latitude:12,longitude:34,utc_offset_seconds:0,current_units:{wind_speed_10m:'km/h',wind_gusts_10m:'km/h',wind_direction_10m:'°',cloud_cover:'%',visibility:'m',rain:'mm',showers:'mm',snowfall:'cm'},current:{time:'2026-10-14T12:00',interval:900,is_day:1,weather_code:95,temperature_2m:18,wind_speed_10m:36,wind_gusts_10m:18,wind_direction_10m:360,cloud_cover:75,visibility:12000,rain:2,showers:0.5,snowfall:0},daily:{time:['2026-10-14'],weather_code:[95],temperature_2m_min:[12],temperature_2m_max:[20],sunrise:['2026-10-14T06:00'],sunset:['2026-10-14T18:00']}});
async function withRouter(run,{payload=om(),provider='open-meteo',units='metric',fetcher=null,nowFn=()=>time}={}){
  for(const key of Object.keys(process.env))if(/^(WEATHER_|OPENWEATHER_)/.test(key))delete process.env[key];
  if(provider==='openweathermap'){process.env.OPENWEATHER_API_KEY='synthetic-private-key';process.env.OPENWEATHER_CITY='PRIVATE-HOUSEHOLD';}
  const seen=[],cfg={weather_provider:provider,weather_lat:'40',weather_lon:'-74',weather_city:'PRIVATE-HOUSEHOLD',weather_units:units,'weather_lat:user:1':'1','weather_lon:user:1':'2'};
  const router=buildRouter({cfgGet:key=>cfg[key]??null,nowFn,fetchFn:async(url)=>{seen.push(new URL(url));if(fetcher)return fetcher(url);return{ok:true,json:async()=>structuredClone(payload)};}});
  const app=express();app.use((req,_res,next)=>{req.authUserId=1;next();});app.use(router);const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const read=async path=>{const res=await fetch('http://127.0.0.1:'+server.address().port+path);assert.equal(res.status,200,'household scene route is supported');return{status:res.status,cache:res.headers.get('cache-control'),body:await res.json()};};
  try{await run({read,seen});}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));for(const key of Object.keys(process.env))if(/^(WEATHER_|OPENWEATHER_)/.test(key))delete process.env[key];}
}
test('scene and theme share one household fetch/cache, ignore private/client location, and retain seven-key theme',async()=>withRouter(async({read,seen})=>{
  const first=await read('/scene?city=PRIVATE-CALLER&lat=1&lon=2');assert.equal(first.status,200);assert.equal(first.cache,'private, no-store');assert.ok(first.body.data?.scene,'scene route returns richer envelope');
  const {theme,scene}=first.body.data;assert.deepEqual(Object.keys(theme).sort(),['condition','expires_at','fetched_at','is_day','observed_at','sunrise_at','sunset_at']);assert.equal(scene.wind.speed_mps,10);assert.equal(scene.wind.gust_mps,5);assert.equal(scene.wind.from_degrees,0);assert.equal(scene.cloud_cover,.75);assert.equal(scene.precipitation.liquid_mm,2.5);assert.equal(scene.precipitation.interval_seconds,900);
  assert.deepEqual((await read('/theme')).body,{data:theme});assert.equal(seen.length,1);assert.equal(seen[0].searchParams.get('latitude'),'40');assert.ok(!JSON.stringify(first.body).includes('PRIVATE'));assert.ok(seen[0].searchParams.get('current').includes('wind_gusts_10m'));
}));
test('missing units or amounts remain null; missing rain cannot report a dry thunderstorm',async()=>{const payload=om();delete payload.current_units;delete payload.current.showers;await withRouter(async({read})=>{const scene=(await read('/scene')).body.data?.scene;assert.ok(scene);assert.deepEqual(scene.wind,{speed_mps:null,gust_mps:null,from_degrees:null});assert.equal(scene.precipitation.kind,'unknown');assert.equal(scene.precipitation.liquid_mm,null);assert.equal(scene.precipitation.snow_cm,null);assert.equal(scene.cloud_cover,null);assert.equal(scene.visibility_m,null);}, {payload});});
test('reported freezing/snow grains/rime/hail and supported97 have precise code treatment',async()=>{
  for(const [code,phenomena,kind] of [[56,['drizzle','freezing-liquid'],'drizzle'],[67,['rain','freezing-liquid'],'rain'],[77,['snow-grains'],'snow-grains'],[48,['fog','rime'],'unknown'],[96,['thunder','hail'],'unknown'],[97,['thunder'],'unknown']]){const payload=om();payload.current.weather_code=code;payload.current.rain=payload.current.showers=payload.current.snowfall=0;await withRouter(async({read})=>{const result=(await read('/scene')).body.data;assert.ok(result?.scene);assert.deepEqual(result.scene.phenomena,phenomena);assert.equal(result.scene.precipitation.kind,kind);assert.equal(result.scene.precipitation.classification,'reported');}, {payload});}
});
test('positive liquid and snowfall infer mixture without manufacturing a snow-water conversion',async()=>{const payload=om();payload.current.snowfall=1;await withRouter(async({read})=>{const scene=(await read('/scene')).body.data?.scene;assert.equal(scene.precipitation.kind,'mixed');assert.equal(scene.precipitation.classification,'inferred');assert.equal(scene.precipitation.snow_cm,1);assert.equal(scene.precipitation.snow_water_mm,null);},{payload});});
test('unsupported richer code retains valid legacy icon fallback and unknown optional weather',async()=>{
  const payload={dt:time/1000,name:'PRIVATE',main:{temp:18,feels_like:18,humidity:50},weather:[{id:299,icon:'11d',description:'PRIVATE'}],wind:{speed:3},sys:{sunrise:time/1000-21600,sunset:time/1000+21600}};
  await withRouter(async({read})=>{const result=(await read('/scene')).body.data;assert.equal(result?.theme.condition,'storm');assert.equal(result.scene,null);},{provider:'openweathermap',fetcher:async url=>({ok:true,json:async()=>String(url).includes('/forecast?')?{list:[]}:payload})});
});
test('OWM primary mixture, imperial wind, extra phenomena and snow water preserve their supported units',async()=>{
  const payload={dt:time/1000,name:'PRIVATE',main:{temp:18,feels_like:18,humidity:50},weather:[{id:615,icon:'13d'},{id:741},{id:211},{id:800},{id:999}],wind:{speed:10,gust:5,deg:360},clouds:{all:50},visibility:8000,rain:{'1h':1},snow:{'1h':2},sys:{sunrise:time/1000-21600,sunset:time/1000+21600}};
  await withRouter(async({read,seen})=>{const scene=(await read('/scene?city=PRIVATE-CALLER')).body.data?.scene;assert.ok(scene);assert.equal(scene.wind.speed_mps,4.4704);assert.equal(scene.wind.gust_mps,2.2352);assert.equal(scene.precipitation.kind,'mixed');assert.equal(scene.precipitation.classification,'reported');assert.equal(scene.precipitation.snow_cm,null);assert.equal(scene.precipitation.snow_water_mm,2);assert.equal(scene.precipitation.interval_seconds,3600);assert.ok(scene.phenomena.includes('fog'));assert.equal(scene.phenomena.length,4);assert.ok(seen.every(url=>url.searchParams.get('q')==='PRIVATE-HOUSEHOLD'));},{provider:'openweathermap',units:'imperial',fetcher:async url=>({ok:true,json:async()=>String(url).includes('/forecast?')?{list:[]}:payload})});
});
test('a missing liquid component, invalid field or unrecognized unit becomes unknown independently',async()=>{
  const payload=om();delete payload.current.showers;payload.current_units.wind_speed_10m='unrecognized';payload.current.wind_gusts_10m=9999;payload.current.wind_direction_10m=-1;payload.current.cloud_cover=101;payload.current.visibility=100001;
  await withRouter(async({read})=>{const scene=(await read('/scene')).body.data.scene;assert.deepEqual(scene.wind,{speed_mps:null,gust_mps:null,from_degrees:null});assert.equal(scene.cloud_cover,null);assert.equal(scene.visibility_m,null);assert.equal(scene.precipitation.liquid_mm,null);assert.equal(scene.precipitation.kind,'unknown');assert.equal(scene.precipitation.snow_cm,0);},{payload});
});
test('concurrent theme and scene share one pending fetch and expired scene cannot reuse the cache',async()=>{
  let entered,release,now=time;const started=new Promise(resolve=>entered=resolve),held=new Promise(resolve=>release=resolve);
  await withRouter(async({read,seen})=>{const sceneRead=read('/scene');await started;const themeRead=read('/theme');release();const [scene,theme]=await Promise.all([sceneRead,themeRead]);assert.equal(seen.length,1);assert.deepEqual(scene.body.data.theme,theme.body.data);now+=90*60000;assert.deepEqual((await read('/scene')).body,{data:null});},{nowFn:()=>now,fetcher:async()=>{entered();await held;return{ok:true,json:async()=>om()};}});
});
test('scene uses the existing negative cache on provider failure',async()=>{await withRouter(async({read,seen})=>{assert.deepEqual((await read('/scene')).body,{data:null});assert.deepEqual((await read('/scene')).body,{data:null});assert.deepEqual((await read('/theme')).body,{data:null});assert.equal(seen.length,1);},{fetcher:async()=>({ok:false,status:503})});});

test('household nighttime solar facts cross negative and fractional positive timezone offsets unchanged',async()=>{
  for (const row of [
    {offset:-14400,local:'2026-10-14T21:08',utc:'2026-10-15T01:08:00.000Z',day:'2026-10-14',rise:'2026-10-14T11:10:00.000Z',set:'2026-10-14T22:20:00.000Z'},
    {offset:19800,local:'2026-10-15T01:38',utc:'2026-10-14T20:08:00.000Z',day:'2026-10-15',rise:'2026-10-15T01:40:00.000Z',set:'2026-10-15T12:50:00.000Z'}
  ]) {
    const payload=om(),clock=Date.parse(row.utc);payload.utc_offset_seconds=row.offset;
    payload.current.time=row.local;payload.current.is_day=0;payload.current.weather_code=0;
    payload.daily.time=[row.day];payload.daily.sunrise=[row.day+'T07:10'];payload.daily.sunset=[row.day+'T18:20'];
    await withRouter(async({read})=>{
      const {theme,scene}=(await read('/scene')).body.data;
      assert.equal(theme.observed_at,row.utc);assert.equal(theme.sunrise_at,row.rise);assert.equal(theme.sunset_at,row.set);
      assert.equal(theme.is_day,false);assert.deepEqual(scene.solar,{is_day:false,sunrise_at:row.rise,sunset_at:row.set});
      for(const timeZone of ['Etc/UTC','America/New_York','Asia/Tokyo'])assert.equal(resolveNamedAppearance({...defaultNamedAppearance(),theme:'local-weather',timeZone},new Date(clock),theme).phase,'night');
      assert.equal(deriveSceneTargets(theme,scene,clock).daylight,0);
    },{payload,nowFn:()=>clock});
  }
});

test('absent solar pair retains the provider reported nighttime fallback',async()=>{
  const missing=om();missing.current.weather_code=0;missing.current.is_day=0;missing.daily.sunrise=[];missing.daily.sunset=[];
  await withRouter(async({read})=>{const {theme,scene}=(await read('/scene')).body.data;assert.equal(theme.sunrise_at,null);assert.equal(theme.sunset_at,null);assert.equal(deriveSceneTargets(theme,scene,time).daylight,0);},{payload:missing});
});

test('OpenWeatherMap night icon and Unix solar times produce the same household nighttime scene',async()=>{
  const clock=Date.parse('2026-10-15T01:08:00.000Z'),rise=Date.parse('2026-10-14T11:10:00.000Z'),set=Date.parse('2026-10-14T22:20:00.000Z');
  const payload={dt:clock/1000,timezone:-14400,name:'Synthetic',main:{temp:14,feels_like:14,humidity:50},weather:[{id:800,icon:'01n'}],wind:{speed:0},sys:{sunrise:rise/1000,sunset:set/1000}};
  await withRouter(async({read})=>{
    const {theme,scene}=(await read('/scene')).body.data;
    assert.equal(theme.is_day,false);assert.equal(theme.observed_at,new Date(clock).toISOString());
    assert.equal(theme.sunrise_at,new Date(rise).toISOString());assert.equal(theme.sunset_at,new Date(set).toISOString());
    assert.deepEqual(scene.solar,{is_day:false,sunrise_at:theme.sunrise_at,sunset_at:theme.sunset_at});
    assert.equal(deriveSceneTargets(theme,scene,clock).daylight,0);
  },{provider:'openweathermap',nowFn:()=>clock,fetcher:async url=>({ok:true,json:async()=>String(url).includes('/forecast?')?{list:[]}:payload})});
});
