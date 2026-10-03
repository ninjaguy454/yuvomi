import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='synthetic-acceptance-capabilities';
const {get}=await import('../server/db.js');
const {PERMISSION_CAPABILITIES,RESTRICTED_MEMBER_CAPABILITIES}=await import('../server/task-capabilities.js');
const {resolvePermissions,replaceSubjectPermissions}=await import('../server/permissions.js');
const {devicePreset,normalizeDevicePermissions}=await import('../server/services/devices.js');
const {taskCapabilities}=await import('../server/services/task-access.js');
const d=get();d.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role) VALUES(1,'learner','Learner','x','member','child'),(2,'owner','Owner','x','admin','parent')").run();
const member=d.prepare('SELECT * FROM users WHERE id=1').get();
test.afterEach(()=>{d.prepare('DELETE FROM access_capabilities').run();d.prepare('DELETE FROM access_permissions').run();});

test('accept-with-helpers is explicit and off for ordinary and restricted members',()=>{
  const definition=PERMISSION_CAPABILITIES.find(c=>c.key==='tasks.accept_with_helpers');
  assert.ok(definition);assert.equal(definition.default,'none');
  assert.equal(resolvePermissions(d,member).capabilities['tasks.accept_with_helpers'],'none');
  assert.equal(RESTRICTED_MEMBER_CAPABILITIES['tasks.accept_with_helpers'],'none');
});
test('enabling the bounded member grant does not grant general edit, reassignment or visibility',()=>{
  replaceSubjectPermissions(d,'user',1,{capabilities:{...RESTRICTED_MEMBER_CAPABILITIES,'tasks.accept_with_helpers':'allow'}});
  const p=resolvePermissions(d,member);assert.equal(p.capabilities['tasks.accept_with_helpers'],'allow');
  for(const key of ['tasks.edit_others','tasks.change_assignment','tasks.reassign','tasks.view_household','tasks.change_points'])assert.equal(p.capabilities[key],'none',key);
  const id=Number(d.prepare("INSERT INTO tasks(title,created_by,assigned_to,visibility) VALUES('Someone else',2,2,'all')").run().lastInsertRowid);
  const c=taskCapabilities(d,1,d.prepare('SELECT * FROM tasks WHERE id=?').get(id));
  assert.equal(c.view,false);assert.equal(c.reassign,false);assert.equal(c.edit,false);
});
test('device helper grant defaults off, normalizes explicitly and preserves all other grants and scope-independent Notes permissions',()=>{
  const preset=devicePreset();assert.equal(preset.capabilities['device_tasks.accept_with_helpers'],'none');
  const supplied=structuredClone(preset);supplied.capabilities['device_tasks.accept_with_helpers']='allow';
  const p=normalizeDevicePermissions(supplied);assert.equal(p.capabilities['device_tasks.accept_with_helpers'],'allow');
  for(const [key,value] of Object.entries(preset.capabilities))if(key!=='device_tasks.accept_with_helpers')assert.equal(p.capabilities[key],value,key);
  assert.deepEqual(p.modules,preset.modules);
});
test('missing legacy device helper key stays denied and malformed values are rejected',()=>{
  const legacy=devicePreset();delete legacy.capabilities['device_tasks.accept_with_helpers'];
  assert.equal(normalizeDevicePermissions(legacy).capabilities['device_tasks.accept_with_helpers'],'none');
  legacy.capabilities['device_tasks.accept_with_helpers']='write';assert.throws(()=>normalizeDevicePermissions(legacy));
});
