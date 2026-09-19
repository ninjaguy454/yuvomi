import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
process.env.DB_PATH=':memory:';process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS}=await import('../server/db.js');
const R=await import('../server/services/rotation.js');
const S=await import('../server/services/rotation-shared.js');
function fixture(path=':memory:'){
  const d=new Database(path);d.pragma('foreign_keys=ON');
  for(const m of ALL_MIGRATIONS){if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d)})();if(m.foreignKeysOff)d.pragma('foreign_keys=ON');}
  d.exec("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(1,'admin','Parent','x','admin'),(2,'grace','Grace','x','member'),(3,'eleanor','Eleanor','x','member'),(4,'frankie','Frankie','x','member'); INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','America/New_York')");
  return d;
}
const at=value=>new Date(value);
const config=(date='2026-09-19')=>({strategy:'rotating_order',starting_member_id:2,effective_date:date,weekdays:[0,1,2,3,4,5,6],active_time:'20:00',finalize_time:'23:00',finalize_day_offset:0,advance_on_skip:false,eligibility:{}});
const make=(d,overrides={},now=at('2026-09-19T23:00:00Z'))=>S.saveRotationGroupUsage(d,{name:'Shared kids',member_ids:[2,3,4],usage_mode:'shared',shared_config:{...config(),...overrides}},{actorId:1,now});
const check=d=>{assert.equal(d.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(d.pragma('foreign_key_check'),[]);};
function race(path,jobs){const gate=new SharedArrayBuffer(4),lock=new Int32Array(gate);let ready=0;
  return Promise.all(jobs.map(job=>new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./workers/rotation-shared-worker.js',import.meta.url),{workerData:{path,gate,job}});
    worker.on('message',value=>{if(value.ready){if(++ready===jobs.length){Atomics.store(lock,0,1);Atomics.notify(lock,0)}}else resolve(value)});
    worker.on('error',reject);worker.on('exit',code=>{if(code)reject(new Error(`worker exited ${code}`))});
  })));}

test('shared four-night periods resolve once, preview reads never advance, and ordinary consumers cannot finalize',()=>{
  const d=fixture();try{
    const group=make(d),before=d.prepare('SELECT total_changes() n').get().n;
    assert.deepEqual(S.previewSharedRotation(d,group.id,{dateKey:'2026-09-19'}).member_ids,[2,3,4]);
    assert.equal(d.prepare('SELECT total_changes() n').get().n,before);
    for(let n=0;n<4;n++){
      const date=`2026-09-${19+n}`,now=at(`${date}T21:00:00-04:00`);
      const occurrence=S.resolveSharedRotation(d,group.id,{dateKey:date,now});assert.ok(occurrence.id);
      assert.deepEqual(occurrence.member_ids,[2,3,4].slice(n%3).concat([2,3,4].slice(0,n%3)));
      assert.equal(S.resolveSharedRotation(d,group.id,{dateKey:date,now}).id,occurrence.id);
      assert.throws(()=>R.finalizeRotation(d,occurrence.id,{actorId:1,expectedRevision:occurrence.revision}),error=>error.code==='rotation_shared_owned');
      const result=S.reconcileSharedRotationPeriods(d,{now:at(`${date}T23:01:00-04:00`)});assert.equal(result.failed,0);assert.equal(result.finalized,1);
      assert.equal(S.reconcileSharedRotationPeriods(d,{now:at(`${date}T23:02:00-04:00`)}).finalized,0);
    }
    assert.equal(d.prepare('SELECT count(*) n FROM rotation_occurrences').get().n,4);
    assert.equal(d.prepare('SELECT advance_count FROM rotation_tracks').get().advance_count,4);
    assert.equal(d.prepare("SELECT count(*) n FROM rotation_events WHERE event_type='finalized'").get().n,4);check(d);
  }finally{d.close();}
});
test('late Task creation cannot jump unprocessed dates; bounded chronological reconciliation recovers after restart',()=>{
  const d=fixture();try{
    const group=make(d),now=at('2026-09-22T21:00:00-04:00');
    const planned=S.resolveSharedRotation(d,group.id,{dateKey:'2026-09-22',now});assert.equal(planned.id,0);
    assert.deepEqual(planned.member_ids,[2,3,4]);assert.equal(d.prepare('SELECT count(*) n FROM rotation_occurrences').get().n,0);
    const first=S.reconcileSharedRotationPeriods(d,{now,limit:2});assert.deepEqual(first,{activated:2,finalized:2,failed:0,limited:true});
    const second=S.reconcileSharedRotationPeriods(d,{now,limit:2});assert.equal(second.activated,2);assert.equal(second.finalized,1);
    const actual=S.resolveSharedRotation(d,group.id,{dateKey:'2026-09-22',now});assert.ok(actual.id);assert.deepEqual(actual.member_ids,[2,3,4]);
    assert.equal(S.reconcileSharedRotationPeriods(d,{now}).activated,0);check(d);
  }finally{d.close();}
});
test('skip retains position, override changes projected successor, and historical snapshots remain unchanged',()=>{
  const d=fixture();try{
    const group=make(d),night=S.resolveSharedRotation(d,group.id,{dateKey:'2026-09-19',now:at('2026-09-19T21:00:00-04:00')});
    const changed=R.overrideRotation(d,night.id,{member_ids:[4,2,3],expected_revision:night.revision,actorId:1});
    assert.deepEqual(changed.original_order.map(member=>member.id),[2,3,4]);
    assert.deepEqual(S.previewSharedRotation(d,group.id,{dateKey:'2026-09-20'}).member_ids,[2,3,4]);
    const skipped=R.skipRotation(d,night.id,{actorId:1,expectedRevision:changed.revision,sharedSchedule:true});
    assert.equal(skipped.advanced,0);const saved=JSON.stringify(R.getRotationOccurrence(d,night.id));
    S.reconcileSharedRotationPeriods(d,{now:at('2026-09-20T21:00:00-04:00')});
    assert.deepEqual(S.resolveSharedRotation(d,group.id,{dateKey:'2026-09-20',now:at('2026-09-20T21:00:00-04:00')}).member_ids,[2,3,4]);
    assert.equal(JSON.stringify(R.getRotationOccurrence(d,night.id)),saved);check(d);
  }finally{d.close();}
});
test('effective config requires fresh confirmation and preserves an active period and its Track cursor until the boundary',()=>{
  const d=fixture();try{
    const group=make(d),now=at('2026-09-19T21:00:00-04:00');
    const current=S.resolveSharedRotation(d,group.id,{dateKey:'2026-09-19',now}),saved=JSON.stringify(current),track=R.getRotationTrack(d,current.track_id);
    const input={name:group.name,member_ids:[4,3,2],usage_mode:'shared',shared_config:{...config('2026-09-20'),starting_member_id:3},expected_revision:group.revision};
    assert.throws(()=>S.saveRotationGroupUsage(d,input,{id:group.id,actorId:1,expectedRevision:group.revision,now}),error=>error.code==='rotation_confirmation_required');
    const preview=S.previewRotationGroupUsage(d,group.id,input,{actorId:1,now});
    const updated=S.saveRotationGroupUsage(d,{...input,confirmation_token:preview.confirmation_token},{id:group.id,actorId:1,expectedRevision:group.revision,now});
    assert.equal(updated.usage_mode,'shared');assert.equal(S.sharedGroupConfiguration(d,group.id,'2026-09-19').starting_member_id,2);
    assert.equal(S.sharedGroupConfiguration(d,group.id,'2026-09-20').starting_member_id,3);
    assert.equal(R.getRotationTrack(d,current.track_id).next_membership_id,track.next_membership_id);
    assert.equal(JSON.stringify({...R.getRotationOccurrence(d,current.id),period_date:'2026-09-19'}),saved);
    assert.throws(()=>S.saveRotationGroupUsage(d,{...input,shared_config:{...input.shared_config,starting_member_id:2},confirmation_token:preview.confirmation_token},{id:group.id,actorId:1,expectedRevision:updated.revision,now}),/changed elsewhere|Preview and confirm/);
    const result=S.reconcileSharedRotationPeriods(d,{now:at('2026-09-20T21:00:00-04:00')});assert.equal(result.failed,0);
    assert.deepEqual(S.resolveSharedRotation(d,group.id,{dateKey:'2026-09-20',now:at('2026-09-20T21:00:00-04:00')}).member_ids,[3,2,4]);check(d);
  }finally{d.close();}
});
test('household-local scheduled boundaries use gap-forward and overlap-earlier DST handling',()=>{
  for(const [date,active,finish,expectedStart,expectedEnd] of [
    ['2026-03-08','01:30','02:30','2026-03-08T06:30:00.000Z','2026-03-08T07:30:00.000Z'],
    ['2026-11-01','01:00','01:30','2026-11-01T05:00:00.000Z','2026-11-01T05:30:00.000Z']]){
    const d=fixture();try{
      const group=make(d,{effective_date:date,active_time:active,finalize_time:finish},at(`${date}T00:00:00-05:00`));
      const preview=S.previewSharedRotation(d,group.id,{dateKey:date});assert.equal(preview.starts_at,expectedStart);assert.equal(preview.ends_at,expectedEnd);check(d);
    }finally{d.close();}
  }
});
test('confirmed reverse conversion requires every independent starting member and applies the seed only once',()=>{
  const d=fixture();let unregister;try{
    const group=make(d),now=at('2026-09-19T21:00:00-04:00');
    const occurrence=S.resolveSharedRotation(d,group.id,{dateKey:'2026-09-19',now});
    unregister=S.registerSharedRotationUsageCollector((_d,id)=>id===group.id?[{consumer_type:'test',consumer_id:'new_child',purpose_key:'order',label:'Bedtime',revision:1}]:[]);
    const input={name:group.name,member_ids:[2,3,4],usage_mode:'independent',effective_date:'2026-09-20',expected_revision:group.revision};
    const preview=S.previewRotationGroupUsage(d,group.id,input,{actorId:1,now});
    assert.throws(()=>S.saveRotationGroupUsage(d,{...input,confirmation_token:preview.confirmation_token},{id:group.id,actorId:1,expectedRevision:group.revision,now}),/explicit next member/);
    const proposal={...input,independent_starts:[{consumer_type:'test',consumer_id:'new_child',purpose_key:'order',next_member_id:3}]};
    const confirm=S.previewRotationGroupUsage(d,group.id,proposal,{actorId:1,now});
    const saved=S.saveRotationGroupUsage(d,{...proposal,confirmation_token:confirm.confirmation_token},{id:group.id,actorId:1,expectedRevision:group.revision,now});
    assert.ok(saved.revision>group.revision);assert.equal(S.sharedGroupConfiguration(d,group.id,'2026-09-20'),null);
    assert.equal(S.reconcileSharedRotationPeriods(d,{now:at('2026-09-20T21:00:00-04:00')}).failed,0);
    const independent=R.configureRotationTrack(d,{consumer_type:'test',consumer_id:'new_child',purpose_key:'order',group_id:group.id,strategy:'round_robin'},{actorId:1,dateKey:'2026-09-20'});
    const first=R.resolveRotation(d,independent.id,'one',{context:{dateKey:'2026-09-20'}});assert.deepEqual(first.member_ids,[3]);
    R.finalizeRotation(d,first.id,{actorId:1,expectedRevision:first.revision});
    R.configureRotationTrack(d,{consumer_type:'test',consumer_id:'new_child',purpose_key:'order',group_id:group.id,strategy:'round_robin'},{actorId:1,dateKey:'2026-09-21'});
    assert.deepEqual(R.resolveRotation(d,independent.id,'two',{context:{dateKey:'2026-09-21'}}).member_ids,[4]);
    assert.equal(R.getRotationOccurrence(d,occurrence.id).advanced,1);check(d);
  }finally{unregister?.();d.close();}
});
test('overnight Group current remains last evening and pending membership changes cannot advance its old ring early',()=>{
  const d=fixture();try{
    const group=make(d,{finalize_time:'02:00',finalize_day_offset:1}),now=at('2026-09-19T21:00:00-04:00');
    const occurrence=S.resolveSharedRotation(d,group.id,{dateKey:'2026-09-19',now});
    assert.equal(S.rotationGroupUsage(d,group.id,{now:at('2026-09-20T01:00:00-04:00')}).shared.current.id,occurrence.id);
    const input={name:group.name,member_ids:[2,4],usage_mode:'shared',shared_config:{...config('2026-09-21'),starting_member_id:4}};
    const preview=S.previewRotationGroupUsage(d,group.id,input,{actorId:1,now});
    S.saveRotationGroupUsage(d,{...input,confirmation_token:preview.confirmation_token},{id:group.id,actorId:1,expectedRevision:group.revision,now});
    assert.equal(S.reconcileSharedRotationPeriods(d,{now:at('2026-09-20T03:00:00-04:00')}).failed,0);
    const track=R.getRotationTrack(d,occurrence.track_id);
    assert.equal(d.prepare('SELECT user_id FROM rotation_group_members WHERE id=?').get(track.next_membership_id).user_id,3);
    assert.deepEqual(S.previewSharedRotation(d,group.id,{dateKey:'2026-09-20'}).member_ids,[3,4,2]);check(d);
  }finally{d.close();}
});
test('shared Group rejects consumer-owned algorithms and finalized periods cannot be skipped or overridden',()=>{
  const d=fixture();try{
    const group=make(d);
    assert.throws(()=>R.configureRotationTrack(d,{consumer_type:'task',consumer_id:'123',purpose_key:'other',group_id:group.id,strategy:'round_robin'},{actorId:1,dateKey:'2026-09-19'}),error=>error.code==='rotation_shared_owned');
    const occurrence=S.resolveSharedRotation(d,group.id,{dateKey:'2026-09-19',now:at('2026-09-19T21:00:00-04:00')});
    S.reconcileSharedRotationPeriods(d,{now:at('2026-09-19T23:01:00-04:00')});
    const historical=R.getRotationOccurrence(d,occurrence.id);
    assert.throws(()=>R.skipRotation(d,occurrence.id,{actorId:1,expectedRevision:historical.revision,sharedSchedule:true}),/different final outcome/);
    assert.throws(()=>R.overrideRotation(d,occurrence.id,{actorId:1,expected_revision:historical.revision,member_ids:[3,4,2]}),/Historical/);check(d);
  }finally{d.close();}
});
test('independent worker transactions converge on one shared period and one scheduled advancement',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'shared-rotation-race-')),path=join(directory,'test.db'),d=fixture(path);
  try{
    d.pragma('journal_mode=WAL');const group=make(d),options={dateKey:'2026-09-19',now:'2026-09-19T21:00:00-04:00'};
    const resolved=await race(path,Array.from({length:4},(_,i)=>({type:i===3?'reconcile':'resolve',groupId:group.id,options})));
    assert.ok(resolved.every(value=>value.ok),JSON.stringify(resolved));assert.equal(d.prepare('SELECT count(*) n FROM rotation_group_periods').get().n,1);
    assert.equal(d.prepare('SELECT count(*) n FROM rotation_occurrences').get().n,1);
    const finals=await race(path,Array.from({length:4},()=>({type:'reconcile',groupId:group.id,options:{now:'2026-09-19T23:01:00-04:00'}})));
    assert.ok(finals.every(value=>value.ok&&value.value.failed===0),JSON.stringify(finals));
    assert.equal(d.prepare('SELECT advance_count FROM rotation_tracks').get().advance_count,1);
    assert.equal(d.prepare("SELECT count(*) n FROM rotation_events WHERE event_type='finalized'").get().n,1);check(d);
  }finally{d.close();rmSync(directory,{recursive:true,force:true});}
});
test('skip, override and correction race scheduled finalization with one outcome and safe stale rejection',async()=>{
  for(const operation of ['skip','override','correct']){
    const directory=mkdtempSync(join(tmpdir(),'shared-edit-race-')),path=join(directory,'test.db'),d=fixture(path);
    try{
      d.pragma('journal_mode=WAL');const group=make(d),occurrence=S.resolveSharedRotation(d,group.id,{dateKey:'2026-09-19',now:at('2026-09-19T21:00:00-04:00')}),track=R.getRotationTrack(d,occurrence.track_id);
      const results=await race(path,[{type:operation,groupId:group.id,occurrenceId:occurrence.id,trackId:track.id,revision:operation==='correct'?track.revision:occurrence.revision,options:{}},
        {type:'reconcile',groupId:group.id,options:{now:'2026-09-19T23:01:00-04:00'}}]);
      assert.ok(results.every(result=>result.ok||result.status===409),JSON.stringify(results));assert.equal(results[1].value.failed,0);
      const final=R.getRotationOccurrence(d,occurrence.id),updated=R.getRotationTrack(d,track.id);
      assert.ok(['finalized','skipped'].includes(final.status));assert.ok(updated.advance_count<=1);
      assert.equal(d.prepare("SELECT count(*) n FROM rotation_events WHERE occurrence_id=? AND event_type IN('finalized','skipped')").get(occurrence.id).n,1);
      assert.deepEqual(final.original_order.map(member=>member.id),[2,3,4]);
      if(operation==='correct'&&results[0].ok)assert.equal(d.prepare('SELECT user_id FROM rotation_group_members WHERE id=?').get(updated.next_membership_id).user_id,4);
      if(operation==='override'&&results[0].ok)assert.deepEqual(final.member_ids,[4,2,3]);
      if(final.status==='skipped')assert.equal(updated.advance_count,0);check(d);
    }finally{d.close();rmSync(directory,{recursive:true,force:true});}
  }
});
test('actual Task completion races scheduled finalization without Task-owned advancement or duplicate points/history',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'shared-task-race-')),path=join(directory,'test.db'),d=fixture(path);
  try{
    d.pragma('journal_mode=WAL');const group=make(d),occurrence=S.resolveSharedRotation(d,group.id,{dateKey:'2026-09-19',now:at('2026-09-19T21:00:00-04:00')});
    d.exec("INSERT INTO reward_participants(user_id,enabled) VALUES(2,1); INSERT INTO tasks(id,title,created_by,assigned_to,points) VALUES(1,'Bedtime',1,2,2); INSERT INTO task_assignments(task_id,user_id) VALUES(1,2)");
    d.prepare('INSERT INTO task_rotation_occurrences(task_id,purpose_key,track_id,occurrence_id,owner_task_id) VALUES(1,?,?,?,1)').run('order',occurrence.track_id,occurrence.id);
    const revision=d.prepare('SELECT revision FROM tasks WHERE id=1').get().revision;
    const results=await race(path,[{type:'task',taskId:1,revision,options:{}},{type:'reconcile',groupId:group.id,options:{now:'2026-09-19T23:01:00-04:00'}}]);
    assert.ok(results.every(result=>result.ok),JSON.stringify(results));assert.equal(results[1].value.failed,0);
    assert.equal(d.prepare('SELECT status FROM tasks WHERE id=1').get().status,'done');
    assert.equal(R.getRotationTrack(d,occurrence.track_id).advance_count,1);
    assert.equal(d.prepare("SELECT count(*) n FROM rotation_events WHERE occurrence_id=? AND event_type='finalized'").get(occurrence.id).n,1);
    assert.equal(d.prepare("SELECT count(*) n FROM task_activity_events WHERE action_task_id=1 AND event_type='completed'").get().n,1);
    const award=d.prepare("SELECT count(*) n,sum(delta) points FROM reward_ledger WHERE task_id=1 AND type='earn'").get();assert.equal(award.n,1);assert.equal(award.points,2);check(d);
  }finally{d.close();rmSync(directory,{recursive:true,force:true});}
});
test('schedule validation rejects overlapping daily windows and confirmation covers pending consumer revision changes',()=>{
  const d=fixture();let unregister;try{
    assert.throws(()=>make(d,{effective_date:'2026-02-30'}),/valid effective date/);
    assert.throws(()=>make(d,{active_time:'18:00',finalize_time:'19:00',finalize_day_offset:1}),/cannot exceed one calendar day/);
    const group=make(d);let revision=1;
    unregister=S.registerSharedRotationUsageCollector(()=>[{consumer_type:'task_series',consumer_id:'123',purpose_key:'order',revision,period_date:'2026-09-21'}]);
    const input={name:group.name,member_ids:[2,3,4],usage_mode:'shared',shared_config:{...config('2026-09-20'),starting_member_id:3}};
    const preview=S.previewRotationGroupUsage(d,group.id,input,{actorId:1,now:at('2026-09-19T19:00:00-04:00')});revision++;
    assert.throws(()=>S.saveRotationGroupUsage(d,{...input,confirmation_token:preview.confirmation_token},{id:group.id,actorId:1,expectedRevision:group.revision,now:at('2026-09-19T19:00:00-04:00')}),error=>error.code==='rotation_confirmation_required');
    assert.equal(d.prepare('SELECT count(*) n FROM rotation_group_schedule_versions').get().n,1);check(d);
  }finally{unregister?.();d.close();}
});
test('a configured schedule retains its approved timezone after the household timezone changes',()=>{
  const d=fixture();try{
    const group=make(d,{active_time:'00:15',finalize_time:'01:00'},at('2026-09-19T00:00:00-04:00'));
    d.prepare("UPDATE sync_config SET value='Pacific/Honolulu' WHERE key='household_timezone'").run();
    const result=S.reconcileSharedRotationPeriods(d,{now:at('2026-09-19T01:01:00-04:00')});
    assert.deepEqual(result,{activated:1,finalized:1,failed:0,limited:false});
    const occurrence=S.resolveSharedRotation(d,group.id,{dateKey:'2026-09-19',now:at('2026-09-19T01:02:00-04:00')});
    assert.equal(occurrence.status,'finalized');assert.equal(occurrence.advanced,1);
    assert.equal(d.prepare('SELECT count(*) n FROM rotation_group_periods').get().n,1);check(d);
  }finally{d.close();}
});
test('distant previews and consumer catch-up are bounded and never invent an uncomputed order',()=>{
  const d=fixture();try{
    const group=make(d),before=d.prepare('SELECT total_changes() n').get().n;
    let reads=0;const prepare=d.prepare.bind(d);d.prepare=(sql)=>{if(/^\s*SELECT\b/i.test(sql))reads++;return prepare(sql)};
    const preview=S.previewSharedRotation(d,group.id,{dateKey:'2036-09-19'});
    assert.equal(preview.id,0);assert.equal(preview.forecast_pending,true);assert.deepEqual(preview.member_ids,[]);
    assert.match(preview.explanation,/366-day forecast horizon/);assert.ok(reads<40,`${reads} reads`);
    reads=0;
    const resolution=S.resolveSharedRotation(d,group.id,{dateKey:'2036-09-19',now:at('2036-09-19T21:00:00-04:00')});
    assert.equal(resolution.id,0);assert.deepEqual(resolution.member_ids,[]);assert.ok(reads<50,`${reads} reads`);
    assert.equal(d.prepare('SELECT total_changes() n').get().n,before);check(d);
  }finally{d.close();}
});
test('a new schedule cannot overlap the prior overnight period at its effective boundary',()=>{
  const d=fixture();try{
    const now=at('2026-09-19T12:00:00-04:00'),group=make(d,{active_time:'18:00',finalize_time:'02:00',finalize_day_offset:1},now);
    const input={name:group.name,member_ids:[2,3,4],usage_mode:'shared',shared_config:{...config('2026-09-20'),active_time:'00:00',finalize_time:'01:00'}};
    assert.throws(()=>S.previewRotationGroupUsage(d,group.id,input,{actorId:1,now}),error=>error.code==='rotation_boundary_overlap');
    assert.throws(()=>S.saveRotationGroupUsage(d,input,{id:group.id,actorId:1,expectedRevision:group.revision,now}),error=>error.code==='rotation_boundary_overlap');
    assert.equal(d.prepare('SELECT count(*) n FROM rotation_group_schedule_versions').get().n,1);
    assert.equal(d.prepare('SELECT count(*) n FROM rotation_group_periods').get().n,0);check(d);
  }finally{d.close();}
});
test('an explicit next-member correction remains authoritative in future previews before scheduled finalization',()=>{
  const d=fixture();try{
    const group=make(d),occurrence=S.resolveSharedRotation(d,group.id,{dateKey:'2026-09-19',now:at('2026-09-19T21:00:00-04:00')});
    const track=R.getRotationTrack(d,occurrence.track_id);
    R.correctRotationTrack(d,track.id,{actorId:1,expected_revision:track.revision,next_member_id:4});
    assert.deepEqual(S.previewSharedRotation(d,group.id,{dateKey:'2026-09-20'}).member_ids,[4,2,3]);
    S.reconcileSharedRotationPeriods(d,{now:at('2026-09-20T21:00:00-04:00')});
    assert.deepEqual(S.resolveSharedRotation(d,group.id,{dateKey:'2026-09-20',now:at('2026-09-20T21:00:00-04:00')}).member_ids,[4,2,3]);
    assert.equal(R.getRotationOccurrence(d,occurrence.id).advanced,0);check(d);
  }finally{d.close();}
});
