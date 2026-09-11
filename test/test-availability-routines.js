process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'availability-routines-test';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';
import crypto from 'node:crypto';
import { get, MIGRATIONS, FORK_MIGRATIONS } from '../server/db.js';
import routineRouter from '../server/routes/schedule.js';
import planningRouter from '../server/routes/planning.js';
import { scheduleData } from '../server/services/schedule.js';
import { moduleForPath, tokenAllows, requiredAccess } from '../server/scopes.js';
import { moduleAccessVerdict, MODULE_ACCESS_ALLOW } from '../server/permissions.js';
import { requireAuth } from '../server/auth.js';

const d = get();
const member = Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role) VALUES ('routine-member','Routine Member','test','member')").run().lastInsertRowid);
const other = Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role) VALUES ('routine-other','Other Member','test','member')").run().lastInsertRowid);
const place = Number(d.prepare("INSERT INTO places(name,type) VALUES ('Work','work')").run().lastInsertRowid);
let actor = member;
const app = express(); app.use(express.json());
app.use((req,_res,next) => { req.authUserId = actor; req.authRole = 'member'; req.session = { userId: actor, role: 'member' }; next(); });
app.use('/legacy', routineRouter); app.use('/planning', planningRouter);
const server = app.listen(0);
await new Promise(resolve => server.once('listening', resolve));
test.after(() => server.close());
const base = `http://127.0.0.1:${server.address().port}`;
async function call(method, path, body) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
}
const initialEvents = d.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n;
let typeId; let patternId;

test('additive migration retains legacy IDs, rows, null days, overrides and inactive flags', () => {
  const old = new Database(':memory:');
  old.exec('CREATE TABLE users(id INTEGER PRIMARY KEY); CREATE TABLE places(id INTEGER PRIMARY KEY); INSERT INTO users VALUES(12);');
  old.exec(MIGRATIONS.find(m => m.version === 165).up);
  old.exec("INSERT INTO schedule_shift_types(id,name,start_time,end_time,color) VALUES(41,'Legacy night','22:00','06:00','#123456'); INSERT INTO schedule_patterns(id,user_id,name,anchor_date,cycle_length,is_active) VALUES(52,12,'Legacy','2026-09-01',8,0); INSERT INTO schedule_pattern_days(id,pattern_id,position,shift_type_id) VALUES(61,52,0,41),(62,52,7,NULL); INSERT INTO schedule_overrides(id,user_id,date_key,shift_type_id,note) VALUES(71,12,'2026-09-03',NULL,'Leave');");
  const tables = ['schedule_shift_types','schedule_patterns','schedule_pattern_days','schedule_overrides'];
  const before = tables.map(table => old.prepare(`SELECT * FROM ${table}`).all());
  old.exec(FORK_MIGRATIONS.find(m => m.version === 10031).up);
  tables.forEach((table,i) => old.prepare(`SELECT * FROM ${table}`).all().forEach((row,j) => {
    for (const [key,value] of Object.entries(before[i][j])) assert.equal(row[key],value,`${table}.${key}`);
  }));
  assert.equal(old.prepare('SELECT availability_state FROM schedule_shift_types').get().availability_state,'busy');
  assert.equal(old.prepare('SELECT place_id FROM schedule_shift_types').get().place_id,null);
  assert.equal(old.pragma('foreign_key_check').length,0); old.close();
});

test('canonical routine API preserves legacy access and stores explicit effects', async () => {
  const result = await call('POST','/planning/routines/shift-types',{name:'Early',start_time:'08:00',end_time:'16:00',color:'#123456',availability_state:'busy',place_id:place});
  assert.equal(result.status,201); typeId=result.body.data.id;
  assert.equal(result.body.data.place_id,place);
  const legacy=await call('GET','/legacy/shift-types'); assert.equal(legacy.body.data.find(x=>x.id===typeId).availability_state,'busy');
  actor=other; assert.equal((await call('PUT',`/planning/routines/shift-types/${typeId}`,{availability_state:'available'})).status,403); actor=member;
  assert.equal((await call('PUT',`/planning/routines/shift-types/${typeId}`,{availability_state:'free'})).status,400);
  assert.equal(moduleForPath('/planning/routines/patterns'),'schedule');
  assert.equal(tokenAllows(['schedule:read'],moduleForPath('/planning/routines/patterns'),'write'),false);
});

test('atomic pattern/day save distinguishes unconfigured, work and explicit day off', async () => {
  const body={name:'Eight days',anchor_date:'2026-09-01',cycle_length:8,user_id:member,days:[{position:0,shift_type_id:typeId},{position:7,shift_type_id:null}]};
  const result=await call('POST','/planning/routines/patterns',body); assert.equal(result.status,201);patternId=result.body.data.id;
  const rows=scheduleData(d,{from:'2026-09-01',to:'2026-09-08',userId:member}).entries;
  assert.equal(rows[0].shift_type.id,typeId); assert.equal(rows[0].is_configured,true);
  assert.equal(rows[1].is_configured,false);assert.equal(rows[1].is_free,false);
  assert.equal(rows[7].is_configured,true);assert.equal(rows[7].is_free,true);
  const count=d.prepare('SELECT COUNT(*) AS n FROM schedule_patterns').get().n;
  const invalid=await call('POST','/planning/routines/patterns',{...body,days:[{position:0,shift_type_id:999999}]});
  assert.equal(invalid.status,400);assert.equal(d.prepare('SELECT COUNT(*) AS n FROM schedule_patterns').get().n,count);
  assert.equal((await call('PUT',`/planning/routines/patterns/${patternId}/days`,{days:[{position:1}]})).status,400);
  const dayCount=d.prepare('SELECT COUNT(*) AS n FROM schedule_pattern_days WHERE pattern_id=?').get(patternId).n;
  assert.equal((await call('PUT',`/planning/routines/patterns/${patternId}/days/1`,{})).status,400);
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM schedule_pattern_days WHERE pattern_id=?').get(patternId).n,dayCount);
  assert.equal((await call('PUT','/planning/routines/overrides/2026-09-02',{user_id:member,note:'Missing shift is not a day off'})).status,400);
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM schedule_overrides WHERE user_id=? AND date_key=?').get(member,'2026-09-02').n,0);
});

test('shortening preserves stale Free rows inertly and protects assigned shifts',async()=>{
  const savedFree=d.prepare('SELECT * FROM schedule_pattern_days WHERE pattern_id=? AND position=7').get(patternId);
  assert.equal((await call('PUT',`/planning/routines/patterns/${patternId}`,{cycle_length:4})).status,200);
  assert.ok(d.prepare('SELECT 1 FROM schedule_pattern_days WHERE pattern_id=? AND position=7 AND shift_type_id IS NULL').get(patternId));
  assert.equal((await call('PUT',`/planning/routines/patterns/${patternId}/days/3`,{shift_type_id:typeId})).status,200);
  assert.equal((await call('PUT',`/planning/routines/patterns/${patternId}`,{cycle_length:2})).status,400);
  assert.equal((await call('PUT',`/planning/routines/patterns/${patternId}`,{cycle_length:2,days:[{position:0,shift_type_id:typeId},{position:1,shift_type_id:null}]})).status,200);
  assert.equal(d.prepare('SELECT cycle_length FROM schedule_patterns WHERE id=?').get(patternId).cycle_length,2);
  assert.deepEqual(d.prepare('SELECT * FROM schedule_pattern_days WHERE pattern_id=? AND position=7').get(patternId),savedFree,'atomic shrink retains the original inert day-off record and ID');
  assert.equal((await call('PUT',`/planning/routines/patterns/${patternId}/days`,{days:[{position:0,shift_type_id:typeId}]})).status,200);
  assert.deepEqual(d.prepare('SELECT * FROM schedule_pattern_days WHERE pattern_id=? AND position=7').get(patternId),savedFree,'subsequent active-day edits retain inert day-off rows');
});

test('roster off override changes only projection, not Calendar events or other availability records',async()=>{
  const override=await call('PUT','/planning/routines/overrides/2026-09-01',{user_id:member,shift_type_id:null,note:'Day off work'});assert.equal(override.status,200);
  const row=(await call('GET',`/planning/routines/entries?from=2026-09-01&to=2026-09-01&user_id=${member}`)).body.data.entries[0];
  assert.equal(row.is_free,true);assert.equal(row.source,'override');
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM availability_periods').get().n,0);
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n,initialEvents);
  assert.equal((await call('DELETE',`/planning/routines/overrides/2026-09-01?user_id=${member}`)).status,204);
  assert.equal(scheduleData(d,{from:'2026-09-01',to:'2026-09-01',userId:member}).entries[0].shift_type.id,typeId);
});

test('explained Availability endpoint is the same resolver as legacy Presence',async()=>{
  const query=`/${member}?start_at=2026-09-01T09:00:00&end_at=2026-09-01T10:00:00&policy=available_before_due`;
  const a=await call('GET','/planning/availability'+query);const b=await call('GET','/planning/presence'+query);
  assert.equal(a.status,200);assert.equal(a.body.data.eligible,false);assert.deepEqual(a.body.data.windows,b.body.data.windows);
  assert.ok(a.body.data.reason);assert.equal(d.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n,initialEvents);
});

test('real session and token middleware retain Schedule read boundaries on mixed Availability results', async () => {
  const secured = express();
  secured.use((req, _res, next) => { req.session = req.headers['x-test-session'] === '1' ? { userId:member, role:'member' } : {}; next(); });
  secured.use('/api/v1', requireAuth, (req,res,next) => {
    const module = moduleForPath(req.path); const access = requiredAccess(req.method);
    if (req.authMethod === 'api_token' && !tokenAllows(req.authScopes,module,access)) return res.status(403).json({error:'Token scope does not permit this operation.'});
    if (moduleAccessVerdict(req.sessionModuleAccess,module,access) !== MODULE_ACCESS_ALLOW) return res.status(403).json({error:'Module access denied.'});
    next();
  });
  secured.use('/api/v1/planning',planningRouter); secured.use('/api/v1/schedule',routineRouter);
  const securedServer = secured.listen(0,'127.0.0.1');
  await new Promise(resolve=>securedServer.once('listening',resolve));
  const address=`http://127.0.0.1:${securedServer.address().port}`;
  const request=async(path,token=null)=>{
    const response=await fetch(address+path,{headers:token?{authorization:`Bearer ${token}`}:{'x-test-session':'1'}});
    return {status:response.status,body:await response.json()};
  };
  const mint=(name,scopes)=>{
    d.prepare('INSERT INTO api_tokens(name,token_hash,token_prefix,created_by,subject_user_id,scopes) VALUES (?,?,?,?,?,?)')
      .run(name,crypto.createHash('sha256').update(name).digest('hex'),'yuvomi_test',member,member,scopes===null?null:JSON.stringify(scopes));
    return name;
  };
  const calendarToken=mint('yuvomi_calendar_only_routine_test',['calendar:read']);
  const bothToken=mint('yuvomi_calendar_schedule_routine_test',['calendar:read','schedule:read']);
  const legacyToken=mint('yuvomi_unscoped_routine_test',null);
  const wildcardToken=mint('yuvomi_invalid_wildcard_routine_test',['calendar:read','schedule:*']);
  const query=`?start_at=2026-09-01T09:00:00&end_at=2026-09-01T10:00:00&policy=available_before_due`;
  const availability=`/api/v1/planning/availability/${member}${query}`;
  const noRoutine=`/api/v1/planning/availability/${other}${query}`;
  const permission=(module,access)=>d.prepare("INSERT OR REPLACE INTO access_permissions(subject_type,subject_id,resource_type,resource_key,access) VALUES ('user',?,'module',?,?)").run(String(member),module,access);
  try {
    permission('schedule','none');
    const denied=await request(availability);
    assert.equal(denied.status,403); assert.match(denied.body.error,/Rotating routine access/); assert.equal(denied.body.data,undefined);
    assert.equal((await request(`/api/v1/planning/presence/${member}${query}`)).status,403,'legacy Presence cannot bypass the same boundary');
    assert.equal((await request('/api/v1/planning/routines/patterns')).status,403);
    assert.equal((await request(noRoutine)).status,200,'no-roster household members retain Availability');
    assert.equal((await request(availability,bothToken)).status,403,'token scopes cannot overrule the member denial');
    permission('schedule','read');
    assert.equal((await request(availability)).status,200);
    assert.equal((await request(availability,calendarToken)).status,403,'Calendar-only token cannot read roster provenance');
    assert.equal((await request(noRoutine,calendarToken)).status,200);
    assert.equal((await request(availability,bothToken)).status,200);
    assert.equal((await request(availability,legacyToken)).status,200,'unscoped legacy tokens retain access within member permissions');
    assert.equal((await request(availability,wildcardToken)).status,403,'unsupported wildcard scope never grants Schedule read');
    permission('calendar','none');
    assert.equal((await request(availability)).status,403,'the outer Calendar boundary also remains enforced');
  } finally {
    d.prepare("DELETE FROM access_permissions WHERE subject_type='user' AND subject_id=? AND resource_type='module' AND resource_key IN ('calendar','schedule')").run(String(member));
    await new Promise(resolve=>securedServer.close(resolve));
  }
});
