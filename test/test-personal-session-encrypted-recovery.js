import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {ensurePersonalSessionSchema,startPersonalSession,enrollBrowser,revokeAllPersonal,
  validPersonalSession,remembered,REMEMBER_COOKIE} from '../server/services/personal-sessions.js';

test('encrypted recovery retains revocations and explicitly invalidates trust in an older restored snapshot',()=>{
  const scratch=mkdtempSync(join(tmpdir(),'vidamia-personal-recovery-'));
  assert.ok(resolve(scratch).startsWith(resolve(tmpdir())+sep));
  const key='Synthetic-encrypted-personal-recovery-key-only';
  const open=(file,readonly=false)=>{const d=new Database(file,{readonly,fileMustExist:readonly});
    d.pragma("cipher='sqlcipher'");d.pragma(`key="x'${Buffer.from(key).toString('hex')}'"`);d.pragma('foreign_keys=ON');return d;};
  let d;
  try{
    d=open(join(scratch,'source.db'));
    d.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,password_hash TEXT);
      CREATE TABLE user_totp(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,secret TEXT,confirmed_at TEXT);
      CREATE TABLE sessions(sid TEXT PRIMARY KEY,sess TEXT NOT NULL,expired_at INTEGER NOT NULL);
      INSERT INTO users VALUES(1,'synthetic-hash');`);
    ensurePersonalSessionSchema(d,Date.now());
    const rollout=d.prepare('SELECT started_at FROM personal_session_policy').get().started_at;
    const session={userId:1,cookie:{maxAge:604800000},touch(){return this;}};
    startPersonalSession(d,session,{factorAt:Date.now()});
    let token;
    enrollBrowser(d,{session,headers:{}},{cookie(name,value){assert.equal(name,REMEMBER_COOKIE);token=value;}});
    const req={headers:{cookie:`${REMEMBER_COOKIE}=${token}`}};
    const saved=JSON.parse(JSON.stringify(session));
    d.prepare('INSERT INTO sessions VALUES(?,?,?)').run('synthetic-sid',JSON.stringify(session),Date.now()+604800000);
    const oldBackup=join(scratch,'before-revocation.db'),currentBackup=join(scratch,'after-revocation.db');
    d.prepare('VACUUM INTO ?').run(oldBackup);
    assert.notEqual(readFileSync(oldBackup).subarray(0,16).toString(),'SQLite format 3\0');
    revokeAllPersonal(d,1);
    d.prepare('VACUUM INTO ?').run(currentBackup);d.close();d=null;
    for(const [file,needsInvalidation] of [[currentBackup,false],[oldBackup,true]]){
      d=open(file);
      if(needsInvalidation){
        assert.ok(remembered(d,req,1),'an older snapshot can contain formerly valid trust');
        // Required recovery step before accepting personal requests from an
        // older snapshot; retaining this enforcement prevents revived trust.
        revokeAllPersonal(d,1);
      }
      ensurePersonalSessionSchema(d,Date.now()+10000);
      assert.equal(d.prepare('SELECT started_at FROM personal_session_policy').get().started_at,rollout);
      assert.equal(remembered(d,req,1),null);
      assert.equal(validPersonalSession(d,saved),false);
      assert.equal(d.prepare('SELECT COUNT(*) n FROM sessions').get().n,0);
      assert.equal(d.prepare('SELECT COUNT(*) n FROM personal_session_revocations WHERE sid=?').get('synthetic-sid').n,1);
      assert.equal(d.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(d.pragma('foreign_key_check'),[]);
      d.close();d=null;
    }
  }finally{d?.close();assert.ok(resolve(scratch).startsWith(resolve(tmpdir())+sep));rmSync(scratch,{recursive:true,force:true});}
});
