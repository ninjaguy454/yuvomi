import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
process.env.DB_PATH=':memory:';
const model=await import('../public/utils/named-appearance.js');
const {buildRouter}=await import('../server/routes/weather.js');
const now=Date.parse('2026-10-14T12:00:00Z'),iso=value=>new Date(value).toISOString();
const selected=()=>({...model.defaultNamedAppearance(),theme:'local-weather'});
const observation=(condition,is_day=true)=>({condition,is_day,observed_at:iso(now),fetched_at:iso(now),expires_at:iso(now+90*60000),sunrise_at:null,sunset_at:null});

test('Local Weather is Dynamic and all ten resolved identities preserve stable readable card slots',()=>{
  assert.doesNotThrow(()=>model.validateNamedAppearance(selected()));const identities=new Set();
  for(const condition of['sunny','cloudy','rain','storm','snow'])for(const is_day of[true,false]){
    const result=model.resolveNamedAppearance(selected(),new Date(now),observation(condition,is_day));assert.equal(result.reason,'weather');assert.equal(result.theme.kind,is_day?'light':'dark');identities.add(result.theme.id);
    for(const slot of model.CARD_SLOTS){const color=model.cardColor(result.theme,slot);assert.ok(model.contrastRatio(color.text,color.fill)>=4.5);assert.ok(model.contrastRatio(color.edge,color.fill)>=3);for(const role of['muted','danger','success','warning','info','focus'])assert.ok(model.contrastRatio(color[role],color.fill)>=4.5);}
  }
  assert.equal(identities.size,10);
});

test('solar instants drive day/night; polar daylight and stable stale/offline fallback need no guessed local hours',()=>{
  const data={...observation('sunny',true),sunrise_at:iso(now-6*3600000),sunset_at:iso(now+1000)};
  assert.equal(model.resolveNamedAppearance(selected(),new Date(now),data).theme.kind,'light');assert.equal(model.resolveNamedAppearance(selected(),new Date(now+2000),data).theme.kind,'dark');
  assert.equal(model.resolveNamedAppearance(selected(),new Date(now),observation('snow',false)).theme.kind,'dark');
  for(const stale of[null,{...observation('rain'),observed_at:iso(now-91*60000)},{...observation('storm'),fetched_at:iso(now+30*60000)},{...observation('sunny'),expires_at:iso(now-1)},{...observation('remote-css'),is_day:true}])assert.equal(model.resolveNamedAppearance(selected(),new Date(now),stale).theme.id,'neutral');
  assert.throws(()=>model.validateNamedAppearance({...selected(),outside:'local-weather'}));
});

test('classic prepaint and module model agree on all weather variants and missing-data fallback',()=>{
  const context={};vm.runInNewContext(readFileSync(new URL('../public/named-appearance-init.js',import.meta.url),'utf8'),context);
  for(const condition of['sunny','cloudy','rain','storm','snow'])for(const day of[true,false]){
    const data=observation(condition,day),classic=context.VidamiaAppearance.resolveNamedAppearance(selected(),new Date(now),data),module=model.resolveNamedAppearance(selected(),new Date(now),data);
    assert.deepEqual(JSON.parse(JSON.stringify(classic)),JSON.parse(JSON.stringify(module)));
  }
  assert.equal(context.VidamiaAppearance.resolveNamedAppearance(selected(),new Date(now)).theme.id,'neutral');
});

const environment=['OPENWEATHER_API_KEY','OPENWEATHER_CITY','WEATHER_LAT','WEATHER_LON','WEATHER_CITY','WEATHER_UNITS'];
async function fixture({fetchFn,userId=9,settings={},clock=()=>now}={}){
  for(const key of environment)delete process.env[key];
  const values={weather_provider:'open-meteo',weather_lat:'40',weather_lon:'-75',weather_city:'Household label',weather_units:'metric','weather_lat:user:9':'1','weather_lon:user:9':'2','weather_city:user:9':'PRIVATE PERSONAL LOCATION',...settings};
  const app=express();app.use((req,_res,next)=>{req.authUserId=userId;next();});app.use(buildRouter({cfgGet:key=>values[key]??null,fetchFn,nowFn:clock}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const origin='http://127.0.0.1:'+server.address().port;
  return{read:async path=>{const response=await fetch(origin+path);return{status:response.status,body:await response.json()};},close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
const om=(code=61)=>({ok:true,json:async()=>({utc_offset_seconds:10800,current:{time:'2026-10-14T15:00',temperature_2m:18,apparent_temperature:17,relative_humidity_2m:50,is_day:1,weather_code:code,wind_speed_10m:5},daily:{time:['2026-10-14'],weather_code:[code],temperature_2m_max:[20],temperature_2m_min:[12],sunrise:['2026-10-14T07:00'],sunset:['2026-10-14T19:00']}})});

test('theme projection reads household provider only, with normalized solar evidence and no private/location data',async()=>{
  const upstream=[],app=await fixture({fetchFn:async url=>{upstream.push(new URL(url));return om();}});
  try{
    const response=await app.read('/theme?city=PRIVATE&lat=1&lon=2&user_id=9');assert.equal(response.status,200);assert.deepEqual(Object.keys(response.body.data).sort(),['condition','expires_at','fetched_at','is_day','observed_at','sunrise_at','sunset_at']);assert.equal(response.body.data.condition,'rain');assert.equal(response.body.data.observed_at,iso(now));assert.equal(response.body.data.sunrise_at,'2026-10-14T04:00:00.000Z');assert.equal(response.body.data.sunset_at,'2026-10-14T16:00:00.000Z');assert.equal(upstream[0].searchParams.get('latitude'),'40');assert.equal(upstream[0].searchParams.get('longitude'),'-75');assert.ok(!JSON.stringify(response.body).includes('PRIVATE'));assert.ok(!JSON.stringify(response.body).includes('Household label'));assert.match(upstream[0].searchParams.get('daily'),/sunrise,sunset/);
    const personal=await app.read('/');assert.equal(personal.body.data.city,'PRIVATE PERSONAL LOCATION');assert.equal(upstream.length,2,'private provider cache and household theme cache are separate');
  }finally{await app.close();}
});

test('concurrent household widget/theme reads coalesce and preserve the original widget response shape',async()=>{
  let release,started,reads=0,time=now;const ready=new Promise(resolve=>started=resolve),held=new Promise(resolve=>release=resolve);
  const app=await fixture({userId:null,clock:()=>time,fetchFn:async()=>{reads++;started();await held;return om(0);}});
  try{
    const requests=[app.read('/'),...Array.from({length:6},()=>app.read('/theme'))];await ready;release();const responses=await Promise.all(requests);assert.equal(reads,1);assert.equal(responses[0].body.data.city,'Household label');assert.equal(responses[0].body.data.current.icon,'sun');assert.equal(responses[0].body.data.sunrise_at,undefined);for(const response of responses.slice(1))assert.equal(response.body.data.condition,'sunny');await app.read('/theme');assert.equal(reads,1);time+=30*60000+1;await app.read('/theme');assert.equal(reads,2);
  }finally{release?.();await app.close();}
});

test('provider failure is coalesced and briefly cached; absent provider gives a quiet null fallback',async()=>{
  let reads=0,time=now;const app=await fixture({userId:null,clock:()=>time,fetchFn:async()=>{reads++;throw Error('Synthetic provider unavailable');}});
  try{for(let index=0;index<3;index++)assert.deepEqual((await app.read('/theme')).body,{data:null});assert.equal(reads,1);time+=60001;await app.read('/theme');assert.equal(reads,2);}finally{await app.close();}
  const absent=await fixture({settings:{weather_provider:'disabled',weather_lat:null,weather_lon:null},fetchFn:()=>{throw Error('Must not fetch');}});try{assert.deepEqual((await absent.read('/theme')).body,{data:null});}finally{await absent.close();}
});

test('OpenWeatherMap theme projection strips query location and credentials, using Unix solar times',async()=>{
  const upstream=[],app=await fixture({settings:{weather_provider:'openweathermap'},fetchFn:async url=>{upstream.push(new URL(url));return{ok:true,json:async()=>String(url).includes('/forecast?')?{list:[]}:{name:'Household Town',dt:now/1000,timezone:0,sys:{sunrise:(now-6*3600000)/1000,sunset:(now+6*3600000)/1000},main:{temp:18,feels_like:18,humidity:50},weather:[{id:601,icon:'13d',description:'Snow'}],wind:{speed:1}}};}});
  process.env.OPENWEATHER_API_KEY='synthetic-provider-key';process.env.OPENWEATHER_CITY='Household Town';
  try{const response=await app.read('/theme?city=PRIVATE&lang=en');assert.equal(response.body.data.condition,'snow');assert.equal(response.body.data.sunrise_at,iso(now-6*3600000));assert.equal(response.body.data.sunset_at,iso(now+6*3600000));assert.ok(upstream.every(url=>url.searchParams.get('q')==='Household Town'));assert.ok(!JSON.stringify(response.body).includes('synthetic-provider-key'));assert.ok(!JSON.stringify(response.body).includes('Household Town'));}finally{await app.close();for(const key of environment)delete process.env[key];}
});
