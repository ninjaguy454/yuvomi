import test from 'node:test';
import assert from 'node:assert/strict';
import {rotationQueryProbe} from './helpers/rotation-query-probe.js';
test('Rotation resolution, preview and history reuse bounded operation-local facts',()=>{
 const result=rotationQueryProbe(),[resolve,history,inspect,three]=result.measurements;
 assert.equal(resolve.groupReads,1);assert.equal(resolve.membershipReads,1);assert.equal(resolve.householdScans,1);
 assert.ok(resolve.selects<=8,JSON.stringify(resolve));
 assert.equal(history.selects,2,'history uses one bounded batch, not one query per occurrence');
 assert.equal(inspect.groupReads,1);assert.equal(inspect.membershipReads,1);assert.equal(inspect.householdScans,1,'successive pure previews reuse eligibility once');
 assert.equal(three.groupReads,3);assert.equal(three.membershipReads,3);
 const [small,large]=result.measurements.slice(-2);
 assert.equal(large.selects,small.selects,'shared ancestry lookup cost must not scale with sibling count');
 assert.equal(large.parentTaskReads,0);
});
