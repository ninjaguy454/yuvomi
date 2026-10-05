import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,existsSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3-multiple-ciphers';

const helper=fileURLToPath(new URL('./helpers/note-groups-recovery.mjs',import.meta.url));
const key='synthetic-notes-groups-recovery-key';
const digest=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'notes-group-recovery-')),file=join(root,'groups.db');
  const env={...process.env,DB_PATH:file,DB_ENCRYPTION_KEY:key,SESSION_SECRET:'synthetic-recovery-session',LOG_LEVEL:'error',VIDAMIA_NOTES_RECOVERY_SYNTHETIC:'1',VIDAMIA_NOTES_RECOVERY_ROOT:root,VIDAMIA_NOTES_RECOVERY_STATE:`${file}.notes-groups-recovery.json`,VIDAMIA_NOTE_GROUPS_MUTATIONS:'1'};
  return {root,file,state:`${file}.notes-groups-recovery.json`,env,close:()=>rmSync(root,{recursive:true,force:true})};
}
function run(f,mode,overrides={},ok=true){
  assert.equal(existsSync(helper),true,'reusable recovery subprocess helper exists');
  const r=spawnSync(process.execPath,[helper,mode],{env:{...f.env,...overrides},encoding:'utf8',timeout:60000});
  assert.equal(r.error,undefined,r.error?.message);assert.equal(r.status===0,ok,`${mode}: ${r.stderr||r.stdout}`);
  assert.equal(`${r.stdout}${r.stderr}`.includes(key),false,'SQLCipher key is never logged');
  for(const hidden of ['SYNTHETIC RECOVERY PRIVATE','SYNTHETIC RECOVERY SELECTED'])assert.equal(`${r.stdout}${r.stderr}`.includes(hidden),false,'summaries never contain private note text');
  const result=JSON.parse((r.status===0?r.stdout:r.stderr).trim());assert.equal(result.ok,ok);return result;
}
function open(f){const d=new Database(f.file);d.pragma("cipher='sqlcipher'");d.pragma(`key="x'${Buffer.from(key).toString('hex')}'"`);return d;}

test('encrypted on-disk fixture survives forward, disabled recovery and restored forward subprocesses',()=>{
  const f=fixture();try{
    const seed=run(f,'seed');assert.equal(seed.groups,3);assert.ok(seed.receipts>=5);assert.notEqual(readFileSync(f.file).subarray(0,16).toString(),'SQLite format 3\0');
    const bare=new Database(f.file,{readonly:true});try{assert.throws(()=>bare.prepare('SELECT count(*) FROM notes').get());}finally{bare.close();}
    const forward=run(f,'assert-forward');assert.equal(forward.membership_hash,seed.membership_hash);assert.equal(forward.receipt_hash,seed.receipt_hash);
    const fallback=run(f,'assert-fallback',{VIDAMIA_NOTE_GROUPS_MUTATIONS:'0'});assert.equal(fallback.blocked_commands,3);assert.equal(fallback.membership_hash,forward.membership_hash);assert.equal(fallback.receipt_hash,forward.receipt_hash);assert.equal(fallback.clock,forward.clock);
    const ordinary=run(f,'exercise-fallback',{VIDAMIA_NOTE_GROUPS_MUTATIONS:'0'});assert.equal(ordinary.groups,2);assert.equal(ordinary.receipt_hash,forward.receipt_hash);assert.equal(ordinary.hidden_survivor_preserved,true);
    const restored=run(f,'assert-restored');assert.equal(restored.groups,2);assert.equal(restored.replayed,true);assert.equal(restored.stale_client_rejected,true);assert.equal(restored.schema_hash,seed.schema_hash);
    const restart=run(f,'assert-forward');assert.equal(restart.membership_hash,restored.membership_hash);assert.equal(restart.receipt_hash,restored.receipt_hash);
  }finally{f.close();}
});

test('recovery mode asserts the image switch and seed never overwrites existing synthetic data',()=>{
  const f=fixture();try{
    run(f,'seed');const dbBefore=digest(f.file),stateBefore=digest(f.state);
    assert.equal(run(f,'seed',{},false).error,'seed_requires_empty_paths');
    assert.equal(run(f,'assert-fallback',{},false).error,'fallback_not_disabled');
    assert.equal(digest(f.file),dbBefore);assert.equal(digest(f.state),stateBefore);
  }finally{f.close();}
});

test('synthetic opt-in and bounded root are mandatory before any database import or write',()=>{
  const f=fixture();try{
    assert.equal(run(f,'seed',{VIDAMIA_NOTES_RECOVERY_SYNTHETIC:'0'},false).error,'synthetic_opt_in_required');assert.equal(existsSync(f.file),false);
    mkdirSync(join(f.root,'designated'));assert.equal(run(f,'seed',{VIDAMIA_NOTES_RECOVERY_ROOT:join(f.root,'designated')},false).error,'database_outside_synthetic_root');assert.equal(existsSync(f.file),false);
    assert.equal(run(f,'seed',{VIDAMIA_NOTES_RECOVERY_ROOT:'/'},false).error,'invalid_synthetic_root');assert.equal(existsSync(f.state),false);
    assert.equal(run(f,'seed',{VIDAMIA_NOTES_RECOVERY_STATE:join(tmpdir(),'outside-recovery-state.json')},false).error,'state_outside_synthetic_root');assert.equal(existsSync(f.file),false);
    assert.equal(run(f,'seed',{DB_ENCRYPTION_KEY:''},false).error,'encryption_key_required');assert.equal(existsSync(f.file),false);
  }finally{f.close();}
});

test('existing non-fixture databases and changed fixture identities fail closed without migrations',()=>{
  const f=fixture(),foreign=fixture();try{
    run(f,'seed');const d=open(foreign);d.exec("CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT); INSERT INTO users VALUES(123,'prior-user-data')");d.close();
    const prior=digest(foreign.file);assert.equal(run(foreign,'seed',{},false).error,'seed_requires_empty_paths');assert.equal(digest(foreign.file),prior);
    writeFileSync(foreign.state,readFileSync(f.state));assert.equal(run(foreign,'assert-forward',{},false).error,'fixture_identity_mismatch');assert.equal(digest(foreign.file),prior);
    const real=open(f);real.prepare("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(42,'unexpected-user','Unexpected','synthetic','member')").run();real.pragma('wal_checkpoint(TRUNCATE)');real.close();
    const changed=digest(f.file);assert.equal(run(f,'exercise-fallback',{VIDAMIA_NOTE_GROUPS_MUTATIONS:'0'},false).error,'fixture_identity_mismatch');assert.equal(digest(f.file),changed);
  }finally{f.close();foreign.close();}
});

test('SQL faults before membership completion and receipt commit roll back persisted state and sequences',()=>{
  const f=fixture();try{
    const before=run(f,'seed'),faults=run(f,'fault-rollback');assert.equal(faults.faults,2);assert.equal(faults.state_hash,before.state_hash);
    const reopened=run(f,'assert-forward');assert.equal(reopened.state_hash,before.state_hash);assert.equal(reopened.schema_hash,before.schema_hash);
  }finally{f.close();}
});
