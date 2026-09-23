import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='rotation-direction-isolated';process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS}=await import('../server/db.js');
const R=await import('../server/services/rotation.js');
const S=await import('../server/services/rotation-shared.js');
const T=await import('../server/services/task-rotation.js');
const reverse='last_to_first',forward='first_to_last';
const now=new Date('2026-09-22T12:00:00-04:00');
function migrate(d,maximum=Infinity,{ledger=false}={}) {
  for(const m of ALL_MIGRATIONS.filter(m=>m.version<=maximum)) {
    if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');
    d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);
      if(ledger)d.prepare('INSERT INTO schema_migrations(version,description) VALUES(?,?)').run(m.version,m.description);})();
    if(m.foreignKeysOff)d.pragma('foreign_keys=ON');
  }
}
function fixture() {
  const d=new Database(':memory:');d.pragma('foreign_keys=ON');migrate(d);
  d.exec("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(1,'parent','Parent','x','admin'),(2,'grace','Grace','x','member'),(3,'eleanor','Eleanor','x','member'),(4,'frankie','Frankie','x','member'); INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','America/New_York')");
  const group=R.saveRotationGroup(d,{name:'Kids',member_ids:[2,3,4]},{actorId:1});
  const track=(key,extra={})=>R.configureRotationTrack(d,{consumer_type:'test',consumer_id:key,purpose_key:'order',group_id:group.id,strategy:'rotating_order',direction:reverse,...extra},{actorId:1});
  return {d,group,track};
}
const withFixture=fn=>()=>{const f=fixture();try{fn(f);assert.deepEqual(f.d.pragma('foreign_key_check'),[]);}finally{f.d.close();}};
const finish=(d,o,options={})=>R.finalizeRotation(d,o.id,{actorId:1,expectedRevision:o.revision,...options});
const sharedConfig=extra=>({strategy:'rotating_order',direction:reverse,starting_member_id:2,effective_date:'2026-09-22',weekdays:[0,1,2,3,4,5,6],active_time:'20:00',finalize_time:'23:00',finalize_day_offset:0,advance_on_skip:false,eligibility:{},...extra});
const shared=(d,group,extra={})=>S.saveRotationGroupUsage(d,{name:group.name,member_ids:[2,3,4],usage_mode:'shared',shared_config:sharedConfig(extra)},{id:group.id,actorId:1,expectedRevision:group.revision,now});

test('canonical selection preserves the stored ring while each reverse turn moves the last eligible person first',()=>{
  for(const [direction,expected] of [[undefined,[[2,3,4],[3,4,2],[4,2,3],[2,3,4]]],[reverse,[[2,3,4],[4,2,3],[3,4,2],[2,3,4]]]]) {
    let next=2;
    for(const order of expected){const result=R.orderedRotationSelection({memberIds:[2,3,4],nextMemberId:next,strategy:'rotating_order',direction});assert.deepEqual(result.member_ids,order);next=result.next_member_id;}
  }
  assert.deepEqual(R.orderedRotationSelection({memberIds:[2,3,4,5],eligibleIds:[2,4],strategy:'rotating_order',direction:reverse}),{member_ids:[2,4],next_member_id:4});
  assert.deepEqual(R.orderedRotationSelection({memberIds:[2],strategy:'rotating_order',direction:reverse}),{member_ids:[2],next_member_id:2});
  for(const strategy of ['round_robin','fixed_order'])assert.deepEqual(R.orderedRotationSelection({memberIds:[2,3,4],strategy,direction:reverse}),R.orderedRotationSelection({memberIds:[2,3,4],strategy}));
});

test('reverse four-turn preview and finalization agree, snapshot the direction, and retries advance once',withFixture(({d,track})=>{
  const t=track('four'),expected=[[2,3,4],[4,2,3],[3,4,2],[2,3,4]],before=d.prepare('SELECT total_changes() n').get().n;
  assert.deepEqual(R.previewRotationSequence(d,t.id,{count:4}).map(o=>o.member_ids),expected);
  assert.equal(d.prepare('SELECT total_changes() n').get().n,before);
  for(let n=0;n<4;n++) {
    const o=R.resolveRotation(d,t.id,`turn:${n}`);assert.deepEqual(o.member_ids,expected[n]);assert.equal(o.config.direction,reverse);
    finish(d,o);finish(d,o);
  }
  assert.equal(R.getRotationTrack(d,t.id).advance_count,4);
}));

test('direction is validated and retained by canonical Task/Workflow bindings; absent legacy defaults compare equal',withFixture(({d,group,track})=>{
  const binding={purpose_key:'order',label:'Order',group_id:group.id,strategy:'rotating_order'};
  assert.equal(T.normalizeRotationBindings(d,[{...binding,direction:reverse}])[0].direction,reverse);
  assert.equal(T.rotationBindingsEqual([binding],[{...binding,direction:forward}]),true);
  assert.equal(T.rotationBindingsEqual([binding],[{...binding,direction:reverse}]),false);
  for(const direction of ['backward',1,{},[]]) {
    assert.throws(()=>track('invalid',{direction}),error=>error.status===400);
    assert.throws(()=>S.previewRotationGroupUsage(d,group.id,{usage_mode:'shared',shared_config:sharedConfig({direction})},{actorId:1,now}),error=>error.status===400);
  }
  const t=track('change',{direction:undefined}),occurrence=R.resolveRotation(d,t.id,'legacy'),saved=JSON.stringify(R.getRotationOccurrence(d,occurrence.id));
  const current=R.getRotationTrack(d,t.id),updated=R.configureRotationTrack(d,{...current,direction:reverse,expected_revision:current.revision},{actorId:1});
  assert.equal(updated.config_revision,current.config_revision+1);assert.equal(updated.next_membership_id,current.next_membership_id);
  assert.equal(JSON.stringify(R.getRotationOccurrence(d,occurrence.id)),saved);
  finish(d,occurrence);assert.deepEqual(R.previewRotation(d,t.id).member_ids,[3,4,2],'pending occurrence uses its saved forward direction');
}));

test('reverse skips and overrides obey their policies and keep original evidence',withFixture(({d,track})=>{
  for(const advance_on_skip of [false,true]) {
    const t=track(`skip:${advance_on_skip}`,{advance_on_skip}),o=R.resolveRotation(d,t.id,'one');
    finish(d,o,{outcome:'skipped'});assert.deepEqual(R.previewRotation(d,t.id).member_ids,advance_on_skip?[4,2,3]:[2,3,4]);
  }
  for(const override_affects_next of [false,true]) {
    const t=track(`override:${override_affects_next}`,{override_affects_next}),o=R.resolveRotation(d,t.id,'one');
    const overridden=R.overrideRotation(d,o.id,{member_ids:[2,4,3],actorId:1,expected_revision:o.revision});
    assert.deepEqual(overridden.original_order.map(m=>m.id),[2,3,4]);finish(d,overridden);
    assert.deepEqual(R.previewRotation(d,t.id).member_ids,override_affects_next?[3,4,2]:[4,2,3]);
  }
  d.exec("INSERT INTO skills(id,name,created_by) VALUES(901,'Rotation eligibility',1); INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source) VALUES(2,901,'normal','manual'),(3,901,'normal','manual'),(4,901,'normal','manual')");
  const t=track('one eligible',{eligibility:{skill_ids:[901]}}),o=R.resolveRotation(d,t.id,'one');
  d.exec("UPDATE user_skill_proficiency SET proficiency='excluded' WHERE skill_id=901 AND user_id IN (3,4)");
  const one=R.overrideRotation(d,o.id,{member_ids:[2],actorId:1,expected_revision:o.revision});
  finish(d,one);
  assert.equal(R.getRotationTrack(d,t.id).next_membership_id,o.order[0].membership_id);
}));

test('adding the explicit default to a legacy Task binding preserves the occurrence and does not create an exception',withFixture(({d,group})=>{
  const current=T.normalizeRotationBindings(d,[{purpose_key:'order',group_id:group.id,strategy:'rotating_order'}]);
  const legacy=current.map(({direction,...binding})=>binding);
  const taskId=Number(d.prepare("INSERT INTO tasks(title,created_by,rotation_bindings_json) VALUES('Existing routine',1,?)").run(JSON.stringify(legacy)).lastInsertRowid);
  T.bindTaskRotations(d,taskId,{actorId:1});
  d.exec("UPDATE rotation_occurrences SET config_json=json_remove(config_json,'$.direction')");
  const occurrence=d.prepare('SELECT * FROM rotation_occurrences').get(),track=d.prepare('SELECT * FROM rotation_tracks').get();
  T.assertRotationBindingsChange(d,2,legacy,current);
  T.bindTaskRotations(d,taskId,{config:current,previousConfig:legacy,actorId:1,scope:'occurrence'});
  assert.deepEqual(d.prepare('SELECT * FROM rotation_occurrences').all(),[occurrence]);
  assert.deepEqual(d.prepare('SELECT * FROM rotation_tracks').all(),[track]);
  assert.equal(T.bindTaskRotations(d,taskId,{config:current,actorId:1}).preserved.length,0);
}));

test('reverse eligibility skipping and membership removal keep the surviving reverse successor',withFixture(({d,group,track})=>{
  const t=track('eligibility');
  for(const [n,expected] of [[1,[2,3]],[2,[3,2]],[3,[2,3]]]) {
    const o=R.resolveRotation(d,t.id,`turn:${n}`,{eligibleUserIds:[2,3]});assert.deepEqual(o.member_ids,expected);finish(d,o);
  }
  const removal=track('removal');finish(d,R.resolveRotation(d,removal.id,'one'));
  R.saveRotationGroup(d,{name:group.name,member_ids:[2,3]},{id:group.id,actorId:1,expectedRevision:group.revision});
  assert.deepEqual(R.previewRotation(d,removal.id).member_ids,[3,2]);
}));

test('shared future previews, scheduled resolution and override finalization use one reverse rule',withFixture(({d,group})=>{
  shared(d,group);const expected=[[2,3,4],[4,2,3],[3,4,2],[2,3,4]];
  const before=d.prepare('SELECT total_changes() n').get().n;
  for(let n=0;n<4;n++)assert.deepEqual(S.previewSharedRotation(d,group.id,{dateKey:`2026-09-${22+n}`}).member_ids,expected[n]);
  assert.equal(d.prepare('SELECT total_changes() n').get().n,before);
  for(let n=0;n<4;n++) {
    const date=`2026-09-${22+n}`,o=S.resolveSharedRotation(d,group.id,{dateKey:date,now:new Date(`${date}T21:00:00-04:00`)});
    assert.deepEqual(o.member_ids,expected[n]);assert.equal(o.config.direction,reverse);
    assert.equal(S.reconcileSharedRotationPeriods(d,{now:new Date(`${date}T23:01:00-04:00`)}).failed,0);
  }
  const date='2026-09-26',o=S.resolveSharedRotation(d,group.id,{dateKey:date,now:new Date(`${date}T21:00:00-04:00`)});
  R.overrideRotation(d,o.id,{member_ids:[2,4,3],actorId:1,expected_revision:o.revision});
  const forecast=S.previewSharedRotation(d,group.id,{dateKey:'2026-09-27'}).member_ids;
  assert.deepEqual(forecast,[3,4,2]);
  S.reconcileSharedRotationPeriods(d,{now:new Date(`${date}T23:01:00-04:00`)});
  assert.deepEqual(S.previewSharedRotation(d,group.id,{dateKey:'2026-09-27'}).member_ids,forecast);
}));

test('shared direction-only updates require confirmed future boundaries and preserve old versions and periods',withFixture(({d,group})=>{
  const saved=shared(d,group,{direction:forward}),active=S.resolveSharedRotation(d,group.id,{dateKey:'2026-09-22',now:new Date('2026-09-22T21:00:00-04:00')});
  const historical=d.prepare('SELECT * FROM rotation_occurrences WHERE id=?').get(active.id);
  const input={name:group.name,member_ids:[2,3,4],usage_mode:'shared',shared_config:sharedConfig({effective_date:'2026-09-23'}),expected_revision:saved.revision};
  assert.throws(()=>S.saveRotationGroupUsage(d,input,{id:group.id,actorId:1,now}),e=>e.code==='rotation_confirmation_required');
  const proposal=S.previewRotationGroupUsage(d,group.id,input,{actorId:1,now});
  S.saveRotationGroupUsage(d,{...input,confirmation_token:proposal.confirmation_token},{id:group.id,actorId:1,now});
  assert.equal(S.sharedGroupConfiguration(d,group.id,'2026-09-22').direction,forward);
  assert.equal(S.sharedGroupConfiguration(d,group.id,'2026-09-23').direction,reverse);
  assert.deepEqual(d.prepare('SELECT * FROM rotation_occurrences WHERE id=?').get(active.id),historical);
  assert.deepEqual(S.previewSharedRotation(d,group.id,{dateKey:'2026-09-24'}).member_ids,[4,2,3]);
}));

test('10042 to 10043 encrypted upgrade defaults Tracks without rewriting history and restarts without replay',()=>{
  const directory=mkdtempSync(join(tmpdir(),'rotation-direction-')),file=join(directory,'database.db'),key=randomBytes(32).toString('hex');let d;
  const open=()=>{const db=new Database(file);db.pragma("cipher='sqlcipher'");db.pragma(`key="x'${Buffer.from(key).toString('hex')}'"`);db.pragma('foreign_keys=ON');return db;};
  try {
    d=open();d.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,description TEXT NOT NULL,applied_at TEXT NOT NULL DEFAULT 'historical')");migrate(d,10042,{ledger:true});
    d.exec(`INSERT INTO users(id,username,display_name,password_hash,role) VALUES(1,'parent','Parent','x','admin');
      INSERT INTO rotation_groups(id,name,created_by) VALUES(1,'Existing order',1);
      INSERT INTO rotation_group_members(id,group_id,user_id,sort_order) VALUES(1,1,1,0);
      INSERT INTO rotation_tracks(id,consumer_type,consumer_id,purpose_key,group_id,strategy,advance_policy,next_membership_id,group_revision,advance_count)
        VALUES(1,'test','historical','order',1,'rotating_order','on_finalized',1,1,7);
      INSERT INTO rotation_occurrences(id,track_id,occurrence_key,group_id,group_revision,track_config_revision,strategy,config_json,members_json,eligible_json,skipped_json,original_order_json,order_json,status,advanced)
        VALUES(1,1,'history',1,1,1,'rotating_order','{"strategy":"rotating_order"}','[]','[]','[]','[]','[]','completed',1);
      INSERT INTO rotation_group_schedules(id,group_id,track_id) VALUES(1,1,1);
      INSERT INTO rotation_group_schedule_versions(id,schedule_id,usage_mode,effective_date,timezone,config_json,members_json)
        VALUES(1,1,'shared','2026-09-22','America/New_York','{"strategy":"rotating_order","starting_member_id":1,"weekdays":[0,1,2,3,4,5,6],"active_time":"20:00","finalize_time":"23:00","finalize_day_offset":0,"advance_on_skip":false,"override_affects_next":true,"eligibility_behavior":"skip_unavailable","eligibility":{}}','[]');`);
    const trackBefore=d.prepare('SELECT * FROM rotation_tracks').get(),history=d.prepare('SELECT * FROM rotation_occurrences').all(),versions=d.prepare('SELECT * FROM rotation_group_schedule_versions').all(),ledger=d.prepare('SELECT * FROM schema_migrations ORDER BY version').all();d.close();
    assert.notEqual(readFileSync(file).subarray(0,16).toString(),'SQLite format 3\u0000');
    const boot=()=>{const result=spawnSync(process.execPath,['--input-type=module','-e',"const db=await import('./server/db.js');db.init();console.log('SCHEMA',db.currentVersion());db.get().close();"],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:60000,env:{...process.env,DB_PATH:file,DB_ENCRYPTION_KEY:key,LOG_LEVEL:'info',NODE_ENV:'test'}});assert.equal(result.status,0,result.stdout+result.stderr);return [...(result.stdout+result.stderr).matchAll(/Migration (\d+) applied:/g)].map(m=>Number(m[1]));};
    assert.deepEqual(boot(),[10043]);d=open();
    assert.deepEqual(d.prepare('SELECT * FROM rotation_tracks').get(),{...trackBefore,direction:forward});
    assert.deepEqual(d.prepare('SELECT * FROM rotation_occurrences').all(),history);assert.deepEqual(d.prepare('SELECT * FROM rotation_group_schedule_versions').all(),versions);
    assert.deepEqual(d.prepare('SELECT * FROM schema_migrations WHERE version<=10042 ORDER BY version').all(),ledger);
    assert.throws(()=>d.prepare('UPDATE rotation_tracks SET direction=?').run('invalid'),/CHECK/);
    d.prepare('UPDATE rotation_tracks SET direction=?').run(reverse);d.close();assert.deepEqual(boot(),[]);d=open();
    assert.equal(d.prepare('SELECT direction FROM rotation_tracks').get().direction,reverse);
    assert.deepEqual(d.prepare('SELECT * FROM rotation_occurrences').all(),history);assert.deepEqual(d.prepare('SELECT * FROM rotation_group_schedule_versions').all(),versions);
    assert.equal(d.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(d.pragma('foreign_key_check'),[]);
  } finally {if(d?.open)d.close();rmSync(directory,{recursive:true,force:true});}
});
