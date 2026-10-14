import test from 'node:test';
import assert from 'node:assert/strict';
import {makeWeatherObservation,wmoThemeCondition} from '../public/utils/weather-appearance.js';
const facts=await import('../public/utils/weather-scene-facts.js').catch(()=>({}));
const now=new Date('2026-10-14T12:00:00.000Z');
const theme=makeWeatherObservation({condition:'storm',is_day:true,observed_at:now.toISOString(),sunrise_at:'2026-10-14T06:00:00.000Z',sunset_at:'2026-10-14T18:00:00.000Z'},now);
const scene=()=>({version:1,provider:'open-meteo',observed_at:theme.observed_at,fetched_at:theme.fetched_at,expires_at:theme.expires_at,condition_code:95,phenomena:['thunder'],precipitation:{kind:'unknown',intensity:null,liquid_mm:null,snow_cm:null,snow_water_mm:null,interval_seconds:900,classification:'reported'},wind:{speed_mps:10,gust_mps:5,from_degrees:360},cloud_cover:null,visibility_m:null,solar:{is_day:true,sunrise_at:theme.sunrise_at,sunset_at:theme.sunset_at}});
const normalize=(value,companion=theme,time=now)=>{assert.equal(typeof facts.normalizeWeatherScene,'function','scene validator exists');return facts.normalizeWeatherScene(value,companion,time);};
test('scene normalization retains unknown precipitation and a gust below mean wind, normalizing north',()=>{
  const result=normalize(scene());assert.equal(result.wind.from_degrees,0);assert.equal(result.wind.gust_mps,5);assert.equal(result.precipitation.kind,'unknown');assert.equal(result.precipitation.liquid_mm,null);assert.notEqual(result,scene());
});
test('every scene object rejects unknown keys and missing fields',()=>{
  for(const path of [null,'wind','precipitation','solar']){const value=scene();(path?value[path]:value).location='PRIVATE';assert.equal(normalize(value),null);}
  for(const key of Object.keys(scene())){const value=scene();delete value[key];assert.equal(normalize(value),null,key);}
});
test('scene timestamps and solar must belong to the companion fresh theme',()=>{
  for(const key of ['observed_at','fetched_at','expires_at']){const value=scene();value[key]='2026-10-14T12:01:00.000Z';assert.equal(normalize(value),null,key);}
  const value=scene();value.solar.is_day=false;assert.equal(normalize(value),null);assert.equal(normalize(scene(),theme,new Date('2026-10-14T13:30:00.000Z')),null);
});
test('unsupported versions/codes/phenomena, duplicates, nonfinite and out-of-range numeric values are rejected',()=>{
  for(const mutation of [v=>v.version=2,v=>v.provider='other',v=>v.condition_code=98,v=>v.phenomena=['frost'],v=>v.phenomena=['rain','rain'],v=>v.wind.speed_mps=101,v=>v.wind.gust_mps=121,v=>v.wind.from_degrees=-1,v=>v.cloud_cover=1.01,v=>v.visibility_m=100001,v=>v.precipitation.liquid_mm=-1,v=>v.precipitation.snow_cm=Infinity,v=>v.precipitation.interval_seconds=0,v=>v.precipitation.classification='guessed']){const value=scene();mutation(value);assert.equal(normalize(value),null);}
});
test('nullable optional numeric facts are accepted without inventing zeroes and output is detached',()=>{
  const value=scene();value.wind={speed_mps:null,gust_mps:null,from_degrees:null};value.precipitation.interval_seconds=null;const result=normalize(value);assert.deepEqual(result.wind,value.wind);result.phenomena.push('rain');assert.deepEqual(value.phenomena,['thunder']);
});
test('envelopes preserve valid coarse themes when richer facts are invalid, and reject outer fields',()=>{
  assert.equal(typeof facts.normalizeWeatherSceneEnvelope,'function');const envelope=facts.normalizeWeatherSceneEnvelope({theme,scene:scene()},now);assert.deepEqual(envelope.theme,theme);assert.ok(envelope.scene);
  const invalid=scene();invalid.wind.raw='PRIVATE';assert.deepEqual(facts.normalizeWeatherSceneEnvelope({theme,scene:invalid},now),{theme,scene:null});assert.deepEqual(facts.normalizeWeatherSceneEnvelope({theme,scene:null},now),{theme,scene:null});assert.equal(facts.normalizeWeatherSceneEnvelope({theme,scene:null,user:1},now),null);assert.equal(facts.normalizeWeatherSceneEnvelope({theme:null,scene:scene()},now),null);
});
test('overlarge/cyclic payloads are rejected without throwing',()=>{const value=scene();value.phenomena=['x'.repeat(5000)];assert.equal(normalize(value),null);value.phenomena=[value];assert.equal(normalize(value),null);});
test('current official WMO code97 is a supported coarse storm and richer reported thunder',()=>{assert.equal(wmoThemeCondition(97),'storm');const value=scene();value.condition_code=97;assert.ok(normalize(value));});
