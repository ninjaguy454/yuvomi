/** Group-aware P2 seed -> P3 upgrade -> same-backend fallback -> P3 return.
 * Only run with a new synthetic /cert directory. Never boot an older writer. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {fork} from 'node:child_process';
import express from 'express';
const stage=process.argv[2],root='/cert';
if(!['seed','upgrade','fallback','return','worker'].includes(stage))throw Error(`Unsupported recovery stage: ${stage}`);
process.env.DB_PATH=root+'/synthetic.db';process.env.DB_ENCRYPTION_KEY='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.SESSION_SECRET='synthetic-rollback-certification';process.env.LOG_LEVEL='error';
const {get}=await import('../../server/db.js');const d=get();
const {devicePreset,normalizeDevicePermissions,createDevice,updateDevice,devicePrincipal}=await import('../../server/services/devices.js');
const {readNoteBoard,saveNote,setNoteLayout}=await import('../../server/services/note-board.js');
const {deviceNotesRequest}=await import('../../server/services/device-notes.js');
const tables=['notes','note_access','note_layouts','note_groups','note_group_members','note_group_receipts','note_board_owners','note_board_note_layouts','note_board_groups','note_board_group_members','note_board_group_receipts','tasks','task_assignments','task_responsibilities','task_acceptance_receipts'];
const snapshot=()=>Object.fromEntries(tables.filter(t=>d.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(t)).map(t=>[t,d.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
const load=name=>JSON.parse(readFileSync(root+'/'+name+'.json','utf8'));
const save=(name,value)=>writeFileSync(root+'/'+name+'.json',JSON.stringify(value,null,2));
const schema=()=>d.prepare('SELECT MAX(version) n FROM schema_migrations').get().n;
function migrations() {
  for(const version of [10051,10052])assert.equal(d.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version=?').get(version).n,1,`required migration ${version}`);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version=10050').get().n,stage==='seed'?0:1,'P3 acceptance migration presence');
  assert.equal(d.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version=?').get(10053).n,stage==='seed'?0:1,'Notes owner migration presence');
}
const integrity=()=>{assert.equal(d.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(d.pragma('foreign_key_check'),[]);assert.notEqual(readFileSync(process.env.DB_PATH).subarray(0,16).toString(),'SQLite format 3\0');};
function layoutState(report){
  const stageIndex=['seed','upgrade','fallback','return'].indexOf(stage);
  assert.ok(stageIndex>=0);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version=10051').get().n,1);
  report.layout_state=[];
  for(const [id,x,y] of [[1,77,24],[2,99,60],[3,120,100]]){
    const initialized=stage!=='seed'&&d.prepare('SELECT 1 FROM note_board_owners WHERE owner_key=?').get('human:1');
    const current=initialized?d.prepare('SELECT * FROM note_board_note_layouts WHERE owner_key=? AND note_id=?').get('human:1',id):d.prepare('SELECT * FROM note_layouts WHERE note_id=?').get(id);
    assert.equal(current.x,x);assert.equal(current.y,y);assert.equal(current.width,4+stageIndex);assert.equal(current.height,6);
    assert.equal(current.position_locked,1);assert.equal(current.always_on_top,1);
    const before=snapshot(),changes=d.prepare('SELECT total_changes() n').get().n;
    assert.throws(()=>setNoteLayout(d,1,id,{expected_layout_revision:current.revision,layout:{x:x+1,y,width:current.width,height:6}}),e=>e.status===409);
    assert.deepEqual(snapshot(),before);assert.equal(d.prepare('SELECT total_changes() n').get().n,changes);
    const resized=setNoteLayout(d,1,id,{expected_layout_revision:current.revision,layout:{x,y,width:current.width+1,height:6}});
    assert.equal(resized.x,x);assert.equal(resized.y,y);assert.equal(resized.width,current.width+1);assert.equal(resized.revision,current.revision+1);
    assert.equal(resized.position_locked,true);assert.equal(resized.always_on_top,true);
    assert.deepEqual(snapshot().notes,before.notes,'layout resize preserves content, audience and dashboard pins');
    report.layout_state.push({note_id:id,x,y,width:resized.width,position_locked:true,always_on_top:true,locked_move_status:409,fixed_position_resize:true});
  }
  report.migration_10050_present=Boolean(d.prepare('SELECT 1 FROM schema_migrations WHERE version=10050').get());
  report.migration_10051_present=true;
  report.migration_10052_present=true;
  report.migration_10053_present=stage!=='seed';
  if(stage!=='seed')report.scoped_state=Object.fromEntries(tables.filter(t=>t.startsWith('note_board_')).map(t=>[t,d.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n]));
}
function privacy(){
  assert.deepEqual(readNoteBoard(d,2).notes.map(n=>n.id).sort(),[2,3]);
  assert.deepEqual(readNoteBoard(d,4).notes.map(n=>n.id),[3]);
  const p=devicePrincipal(d.prepare('SELECT * FROM household_devices WHERE id=1').get());
  assert.deepEqual(deviceNotesRequest(d,p,'GET').body.data.map(n=>n.id),[3]);
}
if(stage==='worker'){
  const {acceptTask}=await import('../../server/services/task-acceptance.js');
  process.on('message',m=>{try{process.send({result:acceptTask(d,m.actor,m.id,m.body)});}catch(e){process.send({error:{status:e.status,message:e.message}});}});
  process.send({ready:true});
}else{
  let report={stage,schema:schema()};
  migrations();
  if(stage==='seed'){
    for(const id of [1,2,3,4])d.prepare("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(?,?,?,'synthetic','admin')").run(id,'Cert'+id,'Cert '+id);
    d.exec("INSERT INTO notes(id,title,content,created_by,visibility,pinned) VALUES(1,'Private','Private original',1,'private',1),(2,'Selected','Selected original',1,'selected',0),(3,'Everyone','Shared original',1,'all',1); INSERT INTO note_access(note_id,user_id) VALUES(2,2);");
    for(const [id,title,parent] of [[1,'Helpers partial',null],[2,'Solo',null],[3,'Competing claim',null],[4,'Identical retry',null],[5,'Remaining open',null],[10,'Allocated child',1],[11,'Unassigned child',1]])d.prepare('INSERT INTO tasks(id,title,created_by,parent_task_id,points) VALUES(?,?,1,?,5)').run(id,title,parent);
    const permissions=devicePreset();permissions.capabilities['device_notes.view']='allow';permissions.capabilities['device_notes.edit']='allow';permissions.capabilities['device_tasks.claim']='allow';
    createDevice(d,{name:'Synthetic rollback display',permissions,scope:{member_ids:[2,3]}},1);
    for(const [id,x,y] of [[1,77,24],[2,99,60],[3,120,100]])setNoteLayout(d,1,id,{expected_layout_revision:0,layout:{x,y,width:4,height:6},position_locked:true,always_on_top:true});
    layoutState(report);privacy();save('seed',snapshot());report.populated=true;
  }else if(stage==='upgrade'){
    const before=load('seed'),up=snapshot();for(const key of Object.keys(before))assert.deepEqual(up[key],before[key]);
    const {acceptanceOptions}=await import('../../server/services/task-acceptance-policy.js');const {acceptTask}=await import('../../server/services/task-acceptance.js');
    const body=id=>{const o=acceptanceOptions(d,2,id);return {operation_id:'rollback-'+id,expected_revision:o.expected_revision,coassignee_ids:[],subtask_snapshot:o.subtask_snapshot,subtask_assignments:[]};};
    const partial={...body(1),coassignee_ids:[3],subtask_assignments:[{id:10,user_id:3},{id:11,user_id:null}]},solo=body(2);
    acceptTask(d,2,1,partial);acceptTask(d,2,2,solo);assert.equal(acceptTask(d,2,1,partial).replayed,true);
    const workers=[];async function worker(){const c=fork(new URL(import.meta.url),['worker'],{stdio:['ignore','ignore','inherit','ipc'],env:process.env});workers.push(c);await new Promise((resolve,reject)=>{c.once('message',resolve);c.once('error',reject);});return c;}
    const run=(c,m)=>new Promise(resolve=>{c.once('message',resolve);c.send(m);});
    try{const [a,b]=await Promise.all([worker(),worker()]);const race=body(3),same=body(4);
      const competing=await Promise.all([run(a,{actor:2,id:3,body:race}),run(b,{actor:3,id:3,body:{...race,operation_id:'rival'}})]);
      assert.equal(competing.filter(r=>r.result).length,1);assert.equal(competing.filter(r=>r.error?.status===409).length,1);
      const retry=await Promise.all([run(a,{actor:2,id:4,body:same}),run(b,{actor:2,id:4,body:same})]);assert.deepEqual(retry.map(r=>r.result?.replayed).sort(),[false,true]);report.concurrent={competing,retry};
    }finally{for(const c of workers){const exited=new Promise(resolve=>c.once('exit',resolve));c.kill();await exited;}}
    const row=d.prepare('SELECT * FROM household_devices WHERE id=1').get();updateDevice(d,1,{revision:row.revision,permissions:{capabilities:{'device_tasks.accept_with_helpers':'allow'}}},1);
    assert.equal(d.prepare('SELECT COUNT(*) n FROM task_acceptance_receipts').get().n,4);assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_ledger').get().n,0);
    layoutState(report);setNoteLayout(d,2,2,{expected_layout_revision:readNoteBoard(d,2).notes.find(n=>n.id===2).layout.revision,layout:{x:199.125,y:260.875,width:5,height:8},position_locked:false,always_on_top:true});const display=devicePrincipal(d.prepare('SELECT * FROM household_devices WHERE id=1').get());setNoteLayout(d,display,3,{expected_layout_revision:readNoteBoard(d,display).notes.find(n=>n.id===3).layout.revision,layout:{x:320.125,y:400.875,width:6,height:9},position_locked:false});privacy();save('requests',{partial,solo});save('accepted',snapshot());report.assignments=d.prepare('SELECT task_id,user_id FROM task_assignments ORDER BY task_id,user_id').all();
  }else if(stage==='fallback'){
    assert.deepEqual(snapshot(),load('accepted'));privacy();
    assert.ok(readFileSync('/app/public/sw.js','utf8').includes('-vidamia.61-acceptance-paused'));
    assert.equal(process.env.VIDAMIA_NOTE_GROUPS_MUTATIONS,'0');
    assert.ok(readFileSync('/app/public/pages/notes.js','utf8').includes('const NOTE_GROUPS_INTERFACE_ENABLED = false;'));
    assert.ok(readFileSync('/app/public/pages/notes.js','utf8').includes('compact: true, active: true'));
    assert.ok(readFileSync('/app/public/styles/notes.css','utf8').includes('#notes-compact-view { display: none !important; }'));
    assert.ok(readFileSync('/app/public/styles/notes.css','utf8').includes('#notes-open-tasks { display: none !important; }'));
    assert.ok(readFileSync('/app/public/styles/tasks.css','utf8').includes('#filter-open-tasks { display: none !important; }'));
    assert.ok(!readFileSync('/app/public/pages/tasks.js','utf8').includes("new URLSearchParams(window.location.search).get('offers') === '1'"));
    const {listTaskOffers}=await import('../../server/services/task-offers.js');const {acceptTask}=await import('../../server/services/task-acceptance.js');const {acceptanceOptions}=await import('../../server/services/task-acceptance-policy.js');
    assert.deepEqual(listTaskOffers(d,2),[]);assert.throws(()=>acceptanceOptions(d,2,5),e=>e.status===503);assert.throws(()=>acceptTask(d,2,1,load('requests').partial),e=>e.status===503);assert.deepEqual(snapshot(),load('accepted'));
    const row=d.prepare('SELECT * FROM household_devices WHERE id=1').get(),permissions=normalizeDevicePermissions(JSON.parse(row.permissions_json));assert.equal(permissions.capabilities['device_tasks.accept_with_helpers'],'allow');
    updateDevice(d,1,{revision:row.revision,name:'Safe fallback rename'},1);assert.equal(JSON.parse(d.prepare('SELECT permissions_json FROM household_devices WHERE id=1').get().permissions_json).capabilities['device_tasks.accept_with_helpers'],'allow');
    const n=d.prepare('SELECT * FROM notes WHERE id=2').get();saveNote(d,1,2,{content:'Selected edited during fallback',expected_revision:n.revision});privacy();
    const {default:tasksRouter}=await import('../../server/routes/tasks.js');const app=express();app.use(express.json());app.use((q,_r,next)=>{q.authUserId=2;q.session={userId:2};next();});app.use('/tasks',tasksRouter);const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    try{const base='http://127.0.0.1:'+server.address().port;
      const ordinary=await fetch(base+'/tasks/1');assert.equal(ordinary.status,200);const task=(await ordinary.json()).data;assert.equal(task.is_offer,false);assert.equal(task.assigned_to,2);
      const reject=await fetch(base+'/tasks/1/accept',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(load('requests').partial)});assert.equal(reject.status,503);
    }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    layoutState(report);save('fallback',snapshot());report.acceptance_disabled=true;report.existing_device_config_editable=true;
  }else if(stage==='return'){
    assert.deepEqual(snapshot(),load('fallback'));privacy();const {acceptTask}=await import('../../server/services/task-acceptance.js');
    const changes=d.prepare('SELECT total_changes() n').get().n;
    assert.equal(acceptTask(d,2,1,load('requests').partial).replayed,true);assert.equal(acceptTask(d,2,2,load('requests').solo).replayed,true);assert.deepEqual(snapshot(),load('fallback'));assert.equal(d.prepare('SELECT total_changes() n').get().n,changes,'receipt replay writes no rows, including notifications/outbound');
    assert.equal(d.prepare('SELECT COUNT(*) n FROM task_acceptance_receipts').get().n,4);assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_ledger').get().n,0);
    assert.equal(d.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version=10050').get().n,1);report.replayed_without_duplicate=true;layoutState(report);
  }else throw Error('Unknown stage');
  assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_ledger').get().n,0);report.reward_ledger_rows=0;report.acceptance_receipt_rows=stage==='seed'?0:d.prepare('SELECT COUNT(*) n FROM task_acceptance_receipts').get().n;if(stage!=='seed')assert.equal(report.acceptance_receipt_rows,4);
  integrity();report.integrity='ok';report.encrypted=true;save(stage+'-result',report);d.pragma('wal_checkpoint(TRUNCATE)');d.close();console.log(JSON.stringify(report));
}
