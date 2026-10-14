import test from 'node:test';
import assert from 'node:assert/strict';
import {startLocalWeather} from '../public/utils/local-weather-runtime.js';

const time=Date.parse('2026-10-14T12:00:00.000Z');
function observation(){return {condition:'rain',is_day:true,observed_at:new Date(time).toISOString(),fetched_at:new Date(time).toISOString(),expires_at:new Date(time+90*60000).toISOString(),sunrise_at:null,sunset_at:null};}
function facts(){return {version:1,provider:'open-meteo',observed_at:new Date(time).toISOString(),fetched_at:new Date(time).toISOString(),expires_at:new Date(time+90*60000).toISOString(),condition_code:66,phenomena:['rain','freezing-liquid'],precipitation:{kind:'rain',intensity:'light',liquid_mm:0.2,snow_cm:null,snow_water_mm:null,interval_seconds:900,classification:'reported'},wind:{speed_mps:2,gust_mps:4,from_degrees:270},cloud_cover:0.8,visibility_m:2000,solar:{is_day:true,sunrise_at:null,sunset_at:null}};}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(options={}) {
  let owner={key:'owner-A',path:'/weather/theme'},clock=time;
  const paths=[],changes=[],requests=[],timers=new Map();let next=0;
  const reader=startLocalWeather({sceneMode:true,getOwner:()=>owner,now:()=>clock,visible:()=>true,online:()=>true,windowTarget:null,documentTarget:null,watchSession:()=>()=>{},schedule:(fn,delay)=>{const id=++next;timers.set(id,{fn,delay});return id;},cancel:id=>timers.delete(id),onChange:()=>changes.push(true),read:(path,signal)=>{paths.push(path);return new Promise(resolve=>requests.push({resolve,signal}));},...options});
  return{reader,paths,changes,requests,timers,setOwner:value=>{owner=value;},setClock:value=>{clock=value;}};
}

test('scene mode reads one household envelope while retaining legacy getValue',async()=>{
  const f=fixture();f.requests[0].resolve({data:{theme:observation(),scene:facts()}});await settle();
  assert.equal(f.reader.getValue()?.condition,'rain');
  assert.deepEqual(f.paths,['/weather/scene']);
  assert.equal(f.reader.getScene()?.condition_code,66);
  f.reader.stop();assert.equal(f.timers.size,0);
});

test('valid legacy theme survives unavailable or invalid richer scene',async()=>{
  for(const scene of [null,{...facts(),private_city:'hidden'},{...facts(),fetched_at:'2026-10-14T11:59:00.000Z'}]){
    const f=fixture();f.requests[0].resolve({data:{theme:observation(),scene}});await settle();
    assert.equal(f.reader.getValue()?.condition,'rain');assert.equal(f.reader.getScene(),null);f.reader.stop();
  }
});

test('owner change aborts and clears facts and rejects old envelope',async()=>{
  const f=fixture();f.setOwner({key:'owner-B',path:'/wall/weather/theme'});
  assert.equal(f.reader.getValue(),null);assert.equal(f.reader.getScene(),null);
  assert.equal(f.requests[0].signal.aborted,true);
  f.requests[0].resolve({data:{theme:observation(),scene:facts()}});await settle();
  assert.equal(f.reader.getValue(),null);assert.equal(f.reader.getScene(),null);
  f.reader.refresh();assert.equal(f.paths.at(-1),'/wall/weather/scene');
  f.requests.at(-1).resolve({data:{theme:observation(),scene:facts()}});await settle();
  assert.equal(f.reader.getScene()?.condition_code,66);f.reader.stop();
});

test('freshness expiration and stop release richer facts',async()=>{
  const f=fixture();f.requests[0].resolve({data:{theme:observation(),scene:facts()}});await settle();
  assert.equal(f.reader.getScene()?.condition_code,66);f.setClock(time+90*60000);
  assert.equal(f.reader.getScene(),null);assert.equal(f.reader.getValue(),null);
  f.reader.stop();assert.equal(f.reader.getScene(),null);assert.equal(f.timers.size,0);
});

test('default reader continues to consume only the unchanged legacy shape',async()=>{
  const f=fixture({sceneMode:false});f.requests[0].resolve({data:observation()});await settle();
  assert.deepEqual(f.paths,['/weather/theme']);assert.equal(f.reader.getValue()?.condition,'rain');
  assert.equal(f.reader.getScene(),null);f.reader.stop();
});
