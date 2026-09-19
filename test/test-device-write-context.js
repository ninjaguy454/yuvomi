import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import {performance} from 'node:perf_hooks';
import {installDeviceWriteLease,withDeviceWriteLease,withoutDeviceWriteLease} from '../server/services/device-write-context.js';

function fixture(options){const d=installDeviceWriteLease(new Database(':memory:',options));d.exec('CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT)');return d;}
test('native prepared statement bind/raw/pluck chains remain compatible; normal requests run zero authorization SQL',context=>{
 const queries=[],d=fixture({verbose:sql=>queries.push(sql)});try{
  let checks=0;const guard=()=>checks++;
  const write=d.prepare('INSERT INTO items(value) VALUES (?)');
  queries.length=0;
  const start=performance.now();for(let n=0;n<1000;n++)write.run('normal');const duration=performance.now()-start;
  assert.equal(queries.length,1000);assert.ok(queries.every(sql=>sql.startsWith('INSERT INTO items(value)')),'normal writes issue no authorization SELECTs');
  context.diagnostic(`1000 ordinary wrapped writes: ${duration.toFixed(2)} ms; 1000 INSERTs, zero additional SQL`);
  assert.equal(checks,0);assert.equal(d.prepare('SELECT count(*) FROM items').pluck().get(),1000);
  withDeviceWriteLease(guard,()=>{
   assert.equal(d.prepare("INSERT INTO items(value) VALUES ('pluck') RETURNING value").pluck().get(),'pluck');
   assert.deepEqual(d.prepare('INSERT INTO items(value) VALUES (?) RETURNING value').bind('raw').raw().all(),[['raw']]);
   assert.equal([...d.prepare("INSERT INTO items(value) VALUES ('iterate') RETURNING value").iterate()][0].value,'iterate');
  });
  assert.ok(checks>=3);assert.ok(duration<1000,`1000 ordinary writes took ${duration.toFixed(1)} ms`);
 }finally{d.close();}
});
test('write lease is checked after awaits for run, returning get/all/iterate, exec and pragma; an enclosing transaction rolls back earlier writes',async()=>{
 const d=fixture();try{
  let valid=true;const guard=()=>{if(!valid)throw Object.assign(new Error('stale device context'),{status:409});};
  const writes=[()=>d.prepare('INSERT INTO items(value) VALUES (?)').run('stale'),
   ()=>d.prepare("INSERT INTO items(value) VALUES ('stale') RETURNING id").get(),
   ()=>d.prepare("INSERT INTO items(value) VALUES ('stale') RETURNING id").all(),
   ()=>[...d.prepare("INSERT INTO items(value) VALUES ('stale') RETURNING id").iterate()],
   ()=>d.exec("INSERT INTO items(value) VALUES ('stale')"),()=>d.pragma('user_version=99')];
  for(const write of writes)await withDeviceWriteLease(guard,async()=>{valid=true;await Promise.resolve();valid=false;assert.throws(write,/stale device context/);});
  assert.equal(d.prepare('SELECT count(*) n FROM items').get().n,0);assert.equal(d.pragma('user_version',{simple:true}),0);
  valid=true;assert.throws(()=>withDeviceWriteLease(guard,()=>d.transaction(()=>{d.prepare("INSERT INTO items(value) VALUES ('before rejection')").run();valid=false;d.prepare("INSERT INTO items(value) VALUES ('after rejection')").run();})()),/stale device context/);
  assert.equal(d.prepare('SELECT count(*) n FROM items').get().n,0);
 }finally{d.close();}
});
test('simultaneous request leases stay independent and explicit session bookkeeping does not erase the surrounding lease',async()=>{
 const d=fixture();try{
  let release,entered;const wait=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>entered=resolve);let valid=true;
  const stale=withDeviceWriteLease(()=>{if(!valid)throw new Error('stale request');},async()=>{entered();await wait;assert.throws(()=>d.prepare("INSERT INTO items(value) VALUES ('forbidden')").run(),/stale request/);});
  await ready;valid=false;
  withDeviceWriteLease(()=>{},()=>d.prepare("INSERT INTO items(value) VALUES ('other request')").run());
  await withDeviceWriteLease(()=>{throw new Error('expired');},async()=>{
   withoutDeviceWriteLease(()=>d.prepare("INSERT INTO items(value) VALUES ('session bookkeeping stand-in')").run());
   await Promise.resolve();assert.throws(()=>d.prepare("INSERT INTO items(value) VALUES ('forbidden')").run(),/expired/);
  });
  release();await stale;
  assert.deepEqual(d.prepare('SELECT value FROM items ORDER BY id').all().map(row=>row.value),['other request','session bookkeeping stand-in']);
 }finally{d.close();}
});
test('read-only statements do not recursively revalidate and guards may inspect current state safely',()=>{
 const d=fixture();try{
  let checks=0;const guard=()=>{checks++;d.prepare('SELECT count(*) FROM items').get();d.pragma('foreign_keys',{simple:true});};
  withDeviceWriteLease(guard,()=>{
   d.prepare('SELECT count(*) FROM items').get();assert.equal(checks,0);
   d.prepare("INSERT INTO items(value) VALUES ('current')").run();assert.equal(checks,1);
  });
 }finally{d.close();}
});
