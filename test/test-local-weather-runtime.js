import test from 'node:test';
import assert from 'node:assert/strict';
import {startLocalWeather} from '../public/utils/local-weather-runtime.js';
import {WEATHER_THEME_REFRESH_MS} from '../public/utils/weather-appearance.js';
import {acceptAuthentication} from '../public/utils/device-context.js';

const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
  let time=Date.parse('2026-10-14T12:00:00Z'),owner={key:'member:1:revision0',path:'/weather/theme'},visible=true,online=true,id=0,changed=0;
  const jobs=new Map(),calls=[],windowTarget=new EventTarget(),documentTarget=new EventTarget();let session;
  const reader=startLocalWeather({now:()=>time,getOwner:()=>owner,visible:()=>visible,online:()=>online,onChange:()=>changed++,
    windowTarget,documentTarget,watchSession:fn=>{session=fn;return()=>session=null;},
    schedule:(fn,delay)=>{jobs.set(++id,{fn,at:time+delay});return id;},cancel:key=>jobs.delete(key),
    read:(path,signal)=>new Promise((resolve,reject)=>calls.push({path,signal,resolve,reject}))});
  const data=(condition='sunny',is_day=true)=>({condition,is_day,observed_at:new Date(time).toISOString(),fetched_at:new Date(time).toISOString(),expires_at:new Date(time+90*60000).toISOString(),sunrise_at:null,sunset_at:null});
  return{reader,calls,jobs,data,windowTarget,documentTarget,get changed(){return changed;},
    owner:value=>owner=value,visibility:value=>visible=value,network:value=>online=value,session:()=>session?.(),
    advance(ms){time+=ms;for(const [key,job]of [...jobs])if(job.at<=time){jobs.delete(key);job.fn();}},
    event(name,target=windowTarget){target.dispatchEvent(new Event(name));}};
}

test('visible online weather makes one request per deadline, no durable storage and no duplicate pending request',async()=>{
  const f=fixture();try{
    assert.equal(f.calls.length,1);f.event('online');f.event('visibilitychange',f.documentTarget);assert.equal(f.calls.length,1);
    f.calls[0].resolve({data:f.data()});await settle();assert.equal(f.reader.getValue().condition,'sunny');
    f.advance(WEATHER_THEME_REFRESH_MS-1);assert.equal(f.calls.length,1);f.advance(1);assert.equal(f.calls.length,2);
    f.calls[1].resolve({data:f.data('snow',false)});await settle();assert.equal(f.reader.getValue().condition,'snow');
  }finally{f.reader.stop();}assert.equal(f.jobs.size,0);
});

test('hidden/offline readers pause, resume only when due and fall back once the last observation expires',async()=>{
  const f=fixture();try{
    f.calls[0].resolve({data:f.data('rain')});await settle();f.visibility(false);f.event('visibilitychange',f.documentTarget);
    f.advance(WEATHER_THEME_REFRESH_MS);assert.equal(f.calls.length,1);f.visibility(true);f.network(false);f.event('visibilitychange',f.documentTarget);assert.equal(f.calls.length,1);
    f.advance(WEATHER_THEME_REFRESH_MS*2);assert.equal(f.reader.getValue(),null);f.network(true);f.event('online');assert.equal(f.calls.length,2);
    f.calls[1].reject(Error('Synthetic offline'));await settle();assert.equal(f.reader.getValue(),null);f.event('online');assert.equal(f.calls.length,2);
  }finally{f.reader.stop();}
});

test('Wall ownership, ordinary session revision and paired context fence late responses even with unchanged selection',async()=>{
  const f=fixture();try{
    f.owner({key:'wall:member1:revision0',path:'/wall/weather/theme'});f.event('yuvomi:wall-mode-change');assert.equal(f.calls[0].signal.aborted,true);assert.equal(f.calls.length,2);
    f.calls[0].resolve({data:f.data('storm')});await settle();assert.equal(f.reader.getValue(),null);
    f.calls[1].resolve({data:f.data('snow')});await settle();assert.equal(f.reader.getValue().condition,'snow');
    f.owner({key:'wall:member2:revision1',path:'/wall/weather/theme'});f.session();assert.equal(f.reader.getValue(),null);assert.equal(f.calls.length,3);
    f.owner({key:'paired:device7:epoch2',path:'/weather/theme'});f.event('vidamia:auth-context');assert.equal(f.calls[2].signal.aborted,true);assert.equal(f.calls.length,4);
    f.calls[2].resolve({data:f.data('rain')});f.calls[3].resolve({data:f.data('cloudy')});await settle();assert.equal(f.reader.getValue().condition,'cloudy');
  }finally{f.reader.stop();}
});

test('unannounced owner change is detected after awaiting; shutdown erases state and removes all listeners',async()=>{
  const f=fixture();f.owner({key:'member:2:revision1',path:'/weather/theme'});f.calls[0].resolve({data:f.data('rain')});await settle();assert.equal(f.reader.getValue(),null);assert.equal(f.calls.length,2);
  f.event('auth:context-ending');assert.equal(f.calls[1].signal.aborted,true);f.calls[1].resolve({data:f.data('storm')});await settle();assert.equal(f.reader.getValue(),null);assert.equal(f.jobs.size,0);
  f.event('online');f.session();assert.equal(f.calls.length,2);
});

test('provider null stays neutral and failed/aborted reads use a bounded retry deadline',async()=>{
  const f=fixture();try{
    f.calls[0].resolve({data:null});await settle();assert.equal(f.reader.getValue(),null);f.event('online');assert.equal(f.calls.length,1);
    f.advance(WEATHER_THEME_REFRESH_MS);assert.equal(f.calls.length,2);f.advance(15000);assert.equal(f.calls[1].signal.aborted,true);f.calls[1].reject(Error('AbortError'));await settle();
    f.event('online');assert.equal(f.calls.length,2);
  }finally{f.reader.stop();}
});

test('temporary device heartbeats retain the Weather owner and its bounded refresh deadline',async()=>{
  const prior=Object.fromEntries(['window','localStorage','navigator','CustomEvent'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)])),events=new EventTarget();
  globalThis.window=events;globalThis.localStorage={getItem:()=>null,setItem(){}};Object.defineProperty(globalThis,'navigator',{configurable:true,value:{}});globalThis.CustomEvent=class extends Event{constructor(name,{detail}){super(name);this.detail=detail;}};
  const auth=idleExpiresAt=>({authContext:'synthetic-temporary-weather',device:{id:7,revision:3},user:{id:2},temporary:{idleExpiresAt,expiresAt:999999}});
  let reads=0,reader;const time=Date.now(),data={condition:'sunny',is_day:true,observed_at:new Date(time).toISOString(),fetched_at:new Date(time).toISOString(),expires_at:new Date(time+90*60000).toISOString(),sunrise_at:null,sunset_at:null};
  try{
    acceptAuthentication(auth(100));reader=startLocalWeather({windowTarget:events,documentTarget:new EventTarget(),visible:()=>true,online:()=>true,watchSession:()=>()=>{},read:async()=>{reads++;return{data};}});await settle();assert.equal(reader.getValue().condition,'sunny');
    acceptAuthentication(auth(200));acceptAuthentication(auth(300));await settle();assert.equal(reads,1);assert.equal(reader.getValue().condition,'sunny');
  }finally{reader?.stop();for(const [key,descriptor]of Object.entries(prior)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}}
});

test('permission denial clears a formerly valid observation and pagehide pauses until pageshow',async()=>{
  const f=fixture();try{
    f.calls[0].resolve({data:f.data('rain')});await settle();f.event('pagehide');f.advance(WEATHER_THEME_REFRESH_MS);assert.equal(f.calls.length,1);
    f.event('pageshow');assert.equal(f.calls.length,2);f.calls[1].reject(Object.assign(Error('Weather denied'),{status:403}));await settle();assert.equal(f.reader.getValue(),null);f.event('online');assert.equal(f.calls.length,2);
  }finally{f.reader.stop();}
});
