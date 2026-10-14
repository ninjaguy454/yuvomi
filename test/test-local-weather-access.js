import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';
process.env.SESSION_SECRET='synthetic-weather-access';
for(const key of Object.keys(process.env))if(/^(WEATHER_|OPENWEATHER_)/.test(key))delete process.env[key];
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {replaceSubjectPermissions}=await import('../server/permissions.js');
const {createDevice,updateDevice,deviceHash}=await import('../server/services/devices.js');
const {deviceAppMiddleware,deviceAppRouteSupported}=await import('../server/services/device-app.js');
const {deviceWeather}=await import('../server/services/device-weather.js');
const {saveWallConfig,WALL_DEFAULTS}=await import('../server/services/wall.js');
const {default:weatherRouter}=await import('../server/routes/weather.js');
const {default:wallRouter}=await import('../server/routes/wall.js');
const realFetch=globalThis.fetch;
let db,server,origin,principal=null,upstream,sequence=0,hold=null;
const setting=(key,value)=>db.prepare('INSERT OR REPLACE INTO sync_config(key,value) VALUES(?,?)').run(key,value);
test.beforeEach(async()=>{
  db=new Database(':memory:');db.pragma('foreign_keys=ON');for(const migration of ALL_MIGRATIONS){typeof migration.up==='function'?migration.up(db):db.exec(migration.up);migration.afterUp?.(db);}_setTestDatabase(db);
  db.exec("INSERT INTO users(id,username,display_name,password_hash,role,family_role) VALUES(1,'SyntheticMember','Synthetic member','synthetic','member','parent'),(2,'SyntheticAdmin','Synthetic admin','synthetic','admin','parent')");
  setting('weather_lat',String(41+ ++sequence/100));setting('weather_lon','-74');setting('weather_city','Household label');setting('weather_lat:user:1','1');setting('weather_lon:user:1','2');setting('weather_city:user:1','PRIVATE LOCATION');
  principal=null;hold=null;upstream=[];
  globalThis.fetch=async(url,options)=>{
    if(String(url).startsWith('http://127.0.0.1:'))return realFetch(url,options);
    upstream.push(new URL(url));if(hold){hold.enter();await hold.promise;}
    const time=new Date().toISOString();return{ok:true,json:async()=>({utc_offset_seconds:0,current:{time,is_day:1,weather_code:0,temperature_2m:18},daily:{time:[time.slice(0,10)],weather_code:[0],temperature_2m_max:[20],temperature_2m_min:[12],sunrise:[time.slice(0,10)+'T06:00'],sunset:[time.slice(0,10)+'T18:00']}})};
  };
  const app=express();app.use(express.json());app.use((req,_res,next)=>{req.authUserId=1;req.authMethod='session';req.sessionID='synthetic-session';req.session={userId:1};req.devicePrincipal=principal;next();});app.use('/api/v1',deviceAppMiddleware);app.use('/api/v1/weather',weatherRouter);app.use('/api/v1/wall',wallRouter);
  app.use((_req,res)=>res.status(404).json({error:'No fallthrough data'}));server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));origin='http://127.0.0.1:'+server.address().port+'/api/v1';
});
test.afterEach(async()=>{globalThis.fetch=realFetch;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));_setTestDatabase(null);db.close();});
const read=async path=>{const response=await fetch(origin+path);return{status:response.status,body:await response.json()};};
function holdProvider(){let enter,release;const entered=new Promise(resolve=>enter=resolve),promise=new Promise(resolve=>release=resolve);hold={enter,promise};return{entered,release};}
function assertMinimal(response){assert.equal(response.status,200);assert.deepEqual(Object.keys(response.body.data).sort(),['condition','expires_at','fetched_at','is_day','observed_at','sunrise_at','sunset_at']);assert.ok(!JSON.stringify(response.body).includes('LOCATION'));assert.ok(!JSON.stringify(response.body).includes('Household label'));}

test('normal member needs existing Dashboard and Weather grants, even for the minimal theme read',async()=>{
  replaceSubjectPermissions(db,'user',1,{widgets:{weather:'none'}});assert.equal((await read('/weather/theme')).status,403);
  replaceSubjectPermissions(db,'user',1,{modules:{dashboard:'none'}});assert.equal((await read('/weather/theme')).status,403);
  replaceSubjectPermissions(db,'user',1,{});setting('disabled_modules','["weather"]');assert.equal((await read('/weather/theme')).status,403);
  setting('disabled_modules','[]');assertMinimal(await read('/weather/theme?city=PRIVATE&lat=1&lon=2'));assert.equal(upstream.length,1);assert.equal(upstream[0].searchParams.get('latitude'),String(41+sequence/100));
});

test('member and Wall permission revocation after provider wait cannot disclose a coarse observation',async()=>{
  for(const path of['/weather/theme','/wall/weather/theme']){
    replaceSubjectPermissions(db,'user',1,{});setting('weather_lat',String(50+ ++sequence/100));const held=holdProvider();const response=read(path);await held.entered;replaceSubjectPermissions(db,'user',1,{widgets:{weather:'none'}});held.release();const result=await response;assert.equal(result.status,403);assert.equal(result.body.data,undefined);hold=null;
  }
});

test('Wall hidden widget does not create a grant; authorized theme uses the same household cache as member/paired',async()=>{
  replaceSubjectPermissions(db,'user',1,{widgets:{weather:'none'}});assert.equal((await read('/wall/weather/theme')).status,403);assert.equal((await read('/wall/weather')).status,403);assert.equal(upstream.length,0);
  replaceSubjectPermissions(db,'user',1,{});assertMinimal(await read('/wall/weather/theme?city=PRIVATE&lang=en'));assertMinimal(await read('/weather/theme?city=PRIVATE&lang=en'));
  principal={kind:'device',...createDevice(db,{name:'Synthetic display'},2)};principal.permissions.widgets.weather='allow';principal.preferences.widgets.find(widget=>widget.id==='weather').visible=false;
  assert.deepEqual((await read('/weather')).body,{data:null});assertMinimal(await read('/weather/theme?city=PRIVATE&lang=en'));assert.equal(upstream.length,1);
});

test('paired theme projection remains read-only and requires existing grants independently of widget visibility',async()=>{
  principal={kind:'device',...createDevice(db,{name:'Synthetic display'},2)};const grants=structuredClone(principal.permissions);assert.equal(deviceAppRouteSupported('GET','/api/v1/weather/theme'),true);assert.equal(deviceAppRouteSupported('POST','/api/v1/weather/theme'),false);assert.equal((await read('/weather/theme')).status,403);assert.deepEqual(principal.permissions,grants);
  principal.permissions.widgets.weather='allow';principal.preferences.widgets.find(widget=>widget.id==='weather').visible=false;assertMinimal(await read('/weather/theme'));principal.permissions.modules.dashboard='none';assert.equal((await read('/weather/theme')).status,403);
});

test('paired theme held across device revision update is fenced by current device authentication',async()=>{
  principal={kind:'device',...createDevice(db,{name:'Synthetic display'},2)};principal.permissions.widgets.weather='allow';const token='synthetic-weather-token',context='synthetic-weather-context';db.prepare('INSERT INTO device_credentials(device_id,token_hash,context_key) VALUES(?,?,?)').run(principal.id,deviceHash(token),context);
  const held=holdProvider(),req={devicePrincipal:principal,headers:{cookie:`vidamia.device=${token}`,'x-auth-context':context},query:{lang:'en'},method:'GET',url:'/weather/theme',session:{},authUserId:null};let finish;const result=new Promise(resolve=>finish=resolve),res={statusCode:200,status(value){this.statusCode=value;return this;},json(body){finish({status:this.statusCode,body});}};
  deviceWeather(req,res,{themeOnly:true});await held.entered;updateDevice(db,principal.id,{revision:principal.revision,permissions:{widgets:{weather:'none'}}},2);held.release();const response=await result;assert.equal(response.status,409);assert.equal(response.body.reason,'device_context_changed');assert.equal(response.body.data,undefined);
});

test('trailing slash and case-equivalent theme reads preserve the minimal projection with a visible Wall widget',async()=>{
  saveWallConfig(db,{...structuredClone(WALL_DEFAULTS),widgets:WALL_DEFAULTS.widgets.map(widget=>({...widget,visible:widget.id==='weather'}))});
  for(const path of['/wall/weather/theme/','/wall/WeAtHeR/ThEmE','/weather/theme/','/weather/ThEmE'])assertMinimal(await read(path));
});

function assertScene(response){assert.equal(response.status,200);assert.deepEqual(Object.keys(response.body.data).sort(),['scene','theme']);assertMinimal({status:response.status,body:{data:response.body.data.theme}});assert.equal(response.body.data.scene?.version,1);assert.ok(!JSON.stringify(response.body).includes('LOCATION'));}
test('scene requires Dashboard/Weather grants for member, Wall and paired readers with hidden widgets',async()=>{
  replaceSubjectPermissions(db,'user',1,{widgets:{weather:'none'}});for(const path of ['/weather/scene','/wall/weather/scene'])assert.equal((await read(path)).status,403);assert.equal(upstream.length,0);
  replaceSubjectPermissions(db,'user',1,{});for(const path of ['/weather/scene?city=PRIVATE&lat=1','/wall/weather/scene'])assertScene(await read(path));assert.equal(upstream[0].searchParams.get('latitude'),String(41+sequence/100));
  principal={kind:'device',...createDevice(db,{name:'Synthetic scene display'},2)};assert.equal((await read('/weather/scene')).status,403);principal.permissions.widgets.weather='allow';principal.preferences.widgets.find(widget=>widget.id==='weather').visible=false;assertScene(await read('/weather/scene'));assert.equal(upstream.length,1);principal.permissions.modules.dashboard='none';assert.equal((await read('/weather/scene')).status,403);
  assert.equal(deviceAppRouteSupported('GET','/api/v1/weather/scene'),true);for(const [method,path]of [['POST','/weather/scene'],['GET','/weather/scene/raw'],['GET','/weather/scenes']])assert.equal(deviceAppRouteSupported(method,path),false);
});
test('member and Wall scene responses cannot cross permission revocation during provider await',async()=>{
  for(const path of ['/weather/scene','/wall/weather/scene']){replaceSubjectPermissions(db,'user',1,{});setting('weather_lat',String(70+ ++sequence/100));const held=holdProvider(),pending=read(path);await held.entered;replaceSubjectPermissions(db,'user',1,{widgets:{weather:'none'}});held.release();const result=await pending;assert.equal(result.status,403);assert.equal(result.body.data,undefined);hold=null;}
});
test('paired scene response cannot cross a device revision update during provider await',async()=>{
  principal={kind:'device',...createDevice(db,{name:'Synthetic scene display'},2)};principal.permissions.widgets.weather='allow';const token='synthetic-scene-token',context='synthetic-scene-context';db.prepare('INSERT INTO device_credentials(device_id,token_hash,context_key) VALUES(?,?,?)').run(principal.id,deviceHash(token),context);
  const held=holdProvider(),req={devicePrincipal:principal,headers:{cookie:`vidamia.device=${token}`,'x-auth-context':context},query:{},method:'GET',url:'/weather/scene',session:{},authUserId:null};let finish;const result=new Promise(resolve=>finish=resolve),res={statusCode:200,setHeader(){},status(value){this.statusCode=value;return this;},json(body){finish({status:this.statusCode,body});}};
  deviceWeather(req,res,{sceneOnly:true});await held.entered;updateDevice(db,principal.id,{revision:principal.revision,permissions:{widgets:{weather:'none'}}},2);held.release();const response=await result;assert.equal(response.status,409);assert.equal(response.body.data,undefined);
});
