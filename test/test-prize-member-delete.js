import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='synthetic-prize-deletion';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {createRedemption,postLedger}=await import('../server/services/rewards.js');
const {createParentPrizeRedemption,decideParentPrizeRedemption,undoPrizeRedemption}=await import('../server/services/reward-fulfillment.js');
const {changeTaskStatus}=await import('../server/services/task-lifecycle.js');
const {router}=await import('../server/auth.js');
const handler=router.stack.find(l=>l.route?.path==='/users/:id'&&l.route.methods.delete).route.stack.at(-1).handle;
let serial=0;
function fixture(){const d=new Database(':memory:');d.pragma('foreign_keys=ON');
  for(const m of ALL_MIGRATIONS){typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);}_setTestDatabase(d);
  // Session storage is initialized by Auth's runtime, outside schema migrations.
  d.exec('CREATE TABLE IF NOT EXISTS sessions(sid TEXT PRIMARY KEY,sess TEXT NOT NULL,expired_at INTEGER NOT NULL)');
  const member=(family,role='member')=>Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES(?,?,'x',?,?)").run('prize-delete-'+(++serial),'Synthetic member',role,family).lastInsertRowid);
  const dad=member('dad','admin'),mom=member('mom'),child=member('child');
  d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(?,1)').run(child);postLedger(d,{userId:child,delta:30,type:'bonus'});
  const catalog=Number(d.prepare("INSERT INTO reward_catalog(name,cost) VALUES('Synthetic deletion prize',10)").run().lastInsertRowid);
  return {d,dad,mom,child,catalog};
}
function remove(f,id=f.child){let status=200,body;handler({params:{id:String(id)},authUserId:f.dad},{status(s){status=s;return this;},json(value){body=value;return this;}});return {status,body};}
for(const variant of ['none','legacy-pending','pending','delivered','undone-pending','undone-delivered','legacy-undone']){
  test(`member deletion preserves its existing cascade and immutable prize Task/audit history: ${variant}`,()=>{
    const f=fixture(),{d}=f;try{
      let row,task,completion,audit;
      if(variant!=='none')row=(variant.startsWith('legacy')?createRedemption:createParentPrizeRedemption)(d,{actorId:f.child,userId:f.child,catalogId:f.catalog,requestKey:randomUUID()}).row;
      if(row)task=d.prepare('SELECT t.* FROM reward_fulfillment_task_links l JOIN tasks t ON t.id=l.task_id WHERE l.redemption_id=?').get(row.id);
      if(variant.endsWith('delivered')){decideParentPrizeRedemption(d,{actorId:f.mom,redemptionId:row.id,action:'fulfill'});completion=d.prepare('SELECT * FROM task_completions WHERE task_id=?').all(task.id);}
      const undoKey=randomUUID(),expectedStatus=variant.endsWith('delivered')?'fulfilled':'pending';
      if(variant.includes('undone')){undoPrizeRedemption(d,{actorId:f.dad,redemptionId:row.id,requestKey:undoKey,expectedStatus,confirmDelivered:expectedStatus==='fulfilled'});audit=d.prepare('SELECT * FROM reward_redemption_undos WHERE redemption_id=?').get(row.id);}
      const result=remove(f);assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.ok,true);
      assert.equal(d.prepare('SELECT COUNT(*) n FROM users WHERE id=?').get(f.child).n,0);
      assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_redemptions WHERE user_id=?').get(f.child).n,0);
      assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_ledger WHERE user_id=?').get(f.child).n,0);
      if(task){const after=d.prepare('SELECT * FROM tasks WHERE id=?').get(task.id);assert.ok(after);
        if(completion){assert.equal(after.status,'done');assert.deepEqual(d.prepare('SELECT * FROM task_completions WHERE task_id=?').all(task.id),completion);}
        else assert.ok(after.archived_at,'deleted recipient cannot leave unfinished delivery active');
        assert.throws(()=>changeTaskStatus(d,task.id,'open',{actorId:f.mom,body:{expected_revision:after.revision}}));
      }
      if(audit){assert.deepEqual(d.prepare('SELECT * FROM reward_redemption_undos WHERE redemption_id=?').get(row.id),audit);
        assert.throws(()=>undoPrizeRedemption(d,{actorId:f.dad,redemptionId:row.id,requestKey:undoKey,expectedStatus,confirmDelivered:expectedStatus==='fulfilled'}),error=>error.status===410);
      }
      assert.deepEqual(d.pragma('foreign_key_check'),[]);
    }finally{_setTestDatabase(null);d.close();}
  });
}
test('another deletion failure rolls back pending prize cleanup with the member',()=>{
  const f=fixture(),{d}=f;try{
    const row=createParentPrizeRedemption(d,{actorId:f.child,userId:f.child,catalogId:f.catalog,requestKey:randomUUID()}).row;
    const task=d.prepare('SELECT t.* FROM reward_fulfillment_task_links l JOIN tasks t ON t.id=l.task_id WHERE l.redemption_id=?').get(row.id);
    d.exec(`CREATE TEMP TRIGGER reject_synthetic_delete BEFORE DELETE ON users WHEN OLD.id=${f.child} BEGIN SELECT RAISE(ABORT,'synthetic delete failure'); END`);
    assert.equal(remove(f).status,500);assert.deepEqual(d.prepare('SELECT * FROM tasks WHERE id=?').get(task.id),task);
    assert.equal(d.prepare('SELECT status FROM reward_redemptions WHERE id=?').get(row.id).status,'pending');
    assert.equal(d.prepare("SELECT COUNT(*) n FROM reward_ledger WHERE redemption_id=? AND type='reversal'").get(row.id).n,0);
  }finally{_setTestDatabase(null);d.close();}
});
test('historical tombstone references validate their source on insertion and remain immutable',()=>{
  const f=fixture(),{d}=f;try{
    const task=Number(d.prepare("INSERT INTO tasks(title) VALUES('Synthetic unrelated task')").run().lastInsertRowid);
    assert.throws(()=>d.prepare('INSERT INTO reward_fulfillment_task_links(redemption_id,task_id) VALUES(999999,?)').run(task),/requires a redemption/);
    assert.throws(()=>d.prepare("INSERT INTO reward_redemption_undos(redemption_id,prior_status,actor_user_id,actor_name,reason,refund_ledger_id) VALUES(999999,'pending',?,'Synthetic parent','Accident',999999)").run(f.dad),/requires its refund/);
    const row=createParentPrizeRedemption(d,{actorId:f.child,userId:f.child,catalogId:f.catalog,requestKey:randomUUID()}).row;
    undoPrizeRedemption(d,{actorId:f.dad,redemptionId:row.id,requestKey:randomUUID(),expectedStatus:'pending'});
    assert.equal(remove(f).status,200);
    assert.throws(()=>d.prepare('DELETE FROM reward_redemption_undos WHERE redemption_id=?').run(row.id),/immutable/);
    assert.throws(()=>d.prepare("UPDATE reward_redemption_undos SET reason='changed' WHERE redemption_id=?").run(row.id),/immutable/);
  }finally{_setTestDatabase(null);d.close();}
});
