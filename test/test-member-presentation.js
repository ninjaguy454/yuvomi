import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';
process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS}=await import('../server/db.js');
const {householdMemberPresentation}=await import('../server/services/member-presentation.js');
const {beginPairing,approvePairing,claimPairing,readDeviceContext,DEVICE_COOKIE}=await import('../server/services/devices.js');
function fixture(name='Alex') {
 const d=new Database(':memory:');
 for(const m of ALL_MIGRATIONS){typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);}
 d.prepare("INSERT INTO users(id,username,display_name,first_name,last_name,password_hash) VALUES(1,'alex',?,'Alex','Smith','SECRET')").run(name);
 d.exec("INSERT INTO users(id,username,display_name,password_hash) VALUES(2,'alex2','Alex','SECRET')");
 d.exec("INSERT INTO birthdays(name,birth_date,family_user_id,created_by) VALUES('Alex','2014-10-05',1,1)");
 return d;
}
test('presentation projection computes age server-side and never ships birthday or profile data',()=>{
 const d=fixture();try{
  const before=householdMemberPresentation(d,{today:'2026-10-04'});
  assert.equal(before[0].age,11);assert.equal(before[1].age,null);
  assert.equal(householdMemberPresentation(d,{today:'2026-10-05'})[0].age,12);
  assert.deepEqual(Object.keys(before[0]).sort(),['age','display_name','first_name','id','last_name','username']);
  assert.ok(!JSON.stringify(before).includes('2014-10-05'));assert.ok(!JSON.stringify(before).includes('SECRET'));
 }finally{d.close();}
});
test('the caller database and allowed member IDs bound the projection',()=>{
 const first=fixture('First household'),second=fixture('Other household');try{
  assert.deepEqual(householdMemberPresentation(first,{memberIds:[2]}).map(m=>m.id),[2]);
  assert.deepEqual(householdMemberPresentation(first,{memberIds:[]}),[]);
  assert.equal(householdMemberPresentation(first)[0].display_name,'First household');
  assert.equal(householdMemberPresentation(second)[0].display_name,'Other household');
 }finally{first.close();second.close();}
});
test('guest and worker accounts stay outside household labels even when requested by ID',()=>{
 const d=fixture();try{
  d.exec("INSERT INTO split_expense_guest_users(user_id,created_by) VALUES(2,1)");
  assert.deepEqual(householdMemberPresentation(d,{memberIds:[2]}),[]);
  d.exec("DELETE FROM split_expense_guest_users WHERE user_id=2; INSERT INTO housekeeping_workers(user_id) VALUES(2)");
  assert.deepEqual(householdMemberPresentation(d,{memberIds:[2]}),[]);
 }finally{d.close();}
});
test('a valid pairing credential from another household database does not authenticate here',()=>{
 const first=fixture('First household'),other=fixture('Other household');try{
  const pairing=beginPairing(other);
  approvePairing(other,pairing.code,{name:'Other household display'},1);
  const credential=claimPairing(other,pairing.secret);
  const request={headers:{cookie:`${DEVICE_COOKIE}=${credential.token}`}};
  assert.ok(readDeviceContext(other,request));
  assert.throws(()=>readDeviceContext(first,request),error=>error.status===401||error.status===403);
 }finally{first.close();other.close();}
});
