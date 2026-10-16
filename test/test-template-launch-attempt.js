import test from 'node:test';
import assert from 'node:assert/strict';
import {launchAttemptStore} from '../public/utils/template-launch-attempt.js';
const memory=()=>{const rows=new Map();return {getItem:k=>rows.get(k)??null,setItem:(k,v)=>rows.set(k,v),removeItem:k=>rows.delete(k)};};
test('an uncertain launch survives reopening under the same authenticated person and keeps its exact request key',()=>{
  const storage=memory(),a=launchAttemptStore(storage,'person-context'),body={activity_template_id:2,recipient_user_ids:[2,3],mode:'individual',request_key:'original'};
  a.save(body);assert.deepEqual(launchAttemptStore(storage,'person-context').load(),body);assert.equal(launchAttemptStore(storage,'other-context').load(),null);
  a.clear('original');assert.equal(a.load(),null);
});
test('storage failures prevent an unremembered launch and malformed stored input is ignored',()=>{
  const broken={getItem(){throw Error('denied');},setItem(){throw Error('denied');},removeItem(){throw Error('denied');}};
  const store=launchAttemptStore(broken,'person');assert.equal(store.load(),null);assert.throws(()=>store.save({request_key:'x'}),/remember/);assert.doesNotThrow(()=>store.clear('x'));
  const storage=memory(),a=launchAttemptStore(storage,'person');a.save({request_key:'x',activity_template_id:1,recipient_user_ids:[2]});assert.ok(a.load());
});
test('a late response for an older modal cannot erase a newer uncertain creation attempt',()=>{
  const storage=memory(),older=launchAttemptStore(storage,'same-person'),newer=launchAttemptStore(storage,'same-person');
  older.save({request_key:'A',activity_template_id:1,recipient_user_ids:[2]});
  newer.clear('A');newer.save({request_key:'B',activity_template_id:1,recipient_user_ids:[3]});
  older.clear('A');assert.equal(newer.load().request_key,'B');
});
