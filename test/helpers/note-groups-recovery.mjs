/** Synthetic service-level recovery probe. Run unchanged in each immutable
 * runtime image with DB_PATH and its sidecar on the same disposable test volume.
 * Required: VIDAMIA_NOTES_RECOVERY_SYNTHETIC=1, VIDAMIA_NOTES_RECOVERY_ROOT,
 * DB_PATH (absolute, custom .db name), DB_ENCRYPTION_KEY. This never uses a
 * default application database or modifies a preexisting non-fixture database.
 * Modes: seed, assert-forward, assert-fallback, exercise-fallback,
 * assert-restored, fault-rollback. JSON output deliberately excludes note data.
 */
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3-multiple-ciphers';

const MARKER='notes-groups-recovery-synthetic-v1',MARKER_KEY='synthetic_notes_groups_recovery';
const USERS=[{id:91001,username:'synthetic-recovery-owner'},{id:91002,username:'synthetic-recovery-recipient'},{id:91003,username:'synthetic-recovery-other'}];
const OWNER=USERS[0].id,RECIPIENT=USERS[1].id,OTHER=USERS[2].id,DEVICE=91099;
const MODES=['seed','assert-forward','assert-fallback','exercise-fallback','assert-restored','fault-rollback'];
const mutable=['notes','note_access','note_layouts','note_groups','note_group_members','note_group_receipts','note_change_clock','sqlite_sequence'];
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const check=(value,code)=>{if(!value)throw Object.assign(new Error(code),{recoveryCode:code});};
const same=(actual,expected,code)=>check(hash(actual)===hash(expected),code);
const quote=name=>'"'+name.replaceAll('"','""')+'"';
const rows=(d,table)=>d.prepare(`SELECT * FROM ${quote(table)}`).all().sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
function protectedHashes(d){
  return Object.fromEntries(d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .filter(({name})=>!mutable.includes(name)&&!name.startsWith('search_index')).map(({name})=>[name,hash(rows(d,name))]));
}
function snapshot(d){
  check(d.pragma('integrity_check',{simple:true})==='ok','integrity_failed');same(d.pragma('foreign_key_check'),[],'foreign_key_violation');
  return {...Object.fromEntries(mutable.map(table=>[table,rows(d,table)])),search_index:rows(d,'search_index'),protected:protectedHashes(d),
    schema_hash:hash(d.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all())};
}
function openReadOnly(file){
  const d=new Database(file,{readonly:true,fileMustExist:true});
  try{d.pragma("cipher='sqlcipher'");d.pragma(`key="x'${Buffer.from(process.env.DB_ENCRYPTION_KEY,'utf8').toString('hex')}'"`);d.pragma('query_only=ON');return d;}
  catch(error){d.close();throw error;}
}
function safePaths(mode){
  check(process.env.VIDAMIA_NOTES_RECOVERY_SYNTHETIC==='1','synthetic_opt_in_required');check(MODES.includes(mode),'invalid_mode');
  const root=process.env.VIDAMIA_NOTES_RECOVERY_ROOT;
  check(root&&path.isAbsolute(root)&&path.resolve(root)!==path.parse(root).root,'invalid_synthetic_root');
  check(fs.existsSync(root)&&fs.realpathSync(root)===path.resolve(root),'invalid_synthetic_root');
  const contained=file=>{const relative=path.relative(root,file);return relative!==''&&!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative);};
  const file=process.env.DB_PATH;
  check(file&&path.isAbsolute(file)&&contained(file)&&fs.realpathSync(path.dirname(file))===path.resolve(path.dirname(file)),'database_outside_synthetic_root');
  check(path.extname(file)==='.db'&&!['yuvomi.db','oikos.db'].includes(path.basename(file)),'invalid_database_name');
  const state=process.env.VIDAMIA_NOTES_RECOVERY_STATE||`${file}.notes-groups-recovery.json`;
  check(path.isAbsolute(state)&&contained(state)&&fs.realpathSync(path.dirname(state))===path.resolve(path.dirname(state)),'state_outside_synthetic_root');
  check(state!==file&&path.extname(state)==='.json','invalid_state_path');
  for(const target of [file,state])if(fs.existsSync(target))check(fs.realpathSync(target)===path.resolve(target)&&!fs.lstatSync(target).isSymbolicLink(),'symlink_refused');
  check(Boolean(process.env.DB_ENCRYPTION_KEY),'encryption_key_required');
  if(['assert-fallback','exercise-fallback'].includes(mode))check(process.env.VIDAMIA_NOTE_GROUPS_MUTATIONS==='0','fallback_not_disabled');
  else check(process.env.VIDAMIA_NOTE_GROUPS_MUTATIONS!=='0','forward_mutations_disabled');
  if(mode==='seed'){
    check(![file,`${file}-wal`,`${file}-shm`,state].some(p=>fs.existsSync(p)),'seed_requires_empty_paths');
    // Exclusive reservation prevents a second seed from overwriting any file.
    fs.closeSync(fs.openSync(state,'wx',0o600));fs.closeSync(fs.openSync(file,'wx',0o600));return {file,state};
  }
  check(fs.existsSync(file)&&fs.existsSync(state),'fixture_files_required');
  let manifest,d;
  try{
    manifest=JSON.parse(fs.readFileSync(state,'utf8'));check(manifest.marker===MARKER&&manifest.format===1,'fixture_identity_mismatch');
    d=openReadOnly(file);
    check(d.prepare('SELECT value FROM sync_config WHERE key=?').get(MARKER_KEY)?.value===MARKER,'fixture_identity_mismatch');
    same(d.prepare('SELECT id,username FROM users ORDER BY id').all(),USERS,'fixture_identity_mismatch');
    same(d.prepare('SELECT id,title,created_by FROM notes ORDER BY id').all(),manifest.current.notes.map(({id,title,created_by})=>({id,title,created_by})).sort((a,b)=>a.id-b.id),'fixture_identity_mismatch');
    same(protectedHashes(d),manifest.protected,'fixture_identity_mismatch');
  }catch{throw Object.assign(new Error('fixture_identity_mismatch'),{recoveryCode:'fixture_identity_mismatch'});}
  finally{d?.close();}
  return {file,state,manifest};
}
const rectangle=(x,y,locked=true,top=true)=>({x,y,width:6,height:8,position_locked:locked,always_on_top:top});
function frozenCommand(s,d,kind,fields,noteIds,groupIds,operation_id){
  const board=s.readGroupedNoteBoard(d,OWNER);
  return {operation_id,kind,...fields,expected:{groups:groupIds.map(id=>({id,revision:board.groups.find(g=>g.id===id).revision})),notes:noteIds.map(id=>{const n=board.notes.find(n=>n.id===id);return {id,revision:n.revision,layout_revision:n.layout.revision};})}};
}
function mustReject(d,work,status,code){
  const before=snapshot(d);let caught;
  try{work();}catch(error){caught=error;}
  check(caught?.status===status,code);same(snapshot(d),before,`${code}_changed_data`);
}
function principal(d,s){return s.devicePrincipal(d.prepare('SELECT * FROM household_devices WHERE id=?').get(DEVICE));}
function assertPrivacy(d,s,m){
  const before=snapshot(d),owner=s.readGroupedNoteBoard(d,OWNER),recipient=s.readGroupedNoteBoard(d,RECIPIENT),other=s.readGroupedNoteBoard(d,OTHER),device=s.readGroupedNoteBoard(d,principal(d,s));
  const has=(board,id)=>board.notes.some(n=>n.id===id),missing=(board,ids)=>ids.every(id=>!has(board,id));
  check(has(owner,m.ids.private)&&has(owner,m.ids.selected)&&!has(owner,m.ids.survivor),'owner_projection');
  check(has(recipient,m.ids.selected)&&has(recipient,m.ids.survivor)&&!has(recipient,m.ids.private),'recipient_projection');
  check(missing(other,[m.ids.private,m.ids.selected,m.ids.survivor]),'other_projection');check(missing(device,[m.ids.private,m.ids.selected,m.ids.survivor]),'device_projection');
  for(const board of [other,device]){
    const encoded=JSON.stringify(board);for(const id of [m.ids.private,m.ids.selected,m.ids.survivor])check(!encoded.includes(d.prepare('SELECT title FROM notes WHERE id=?').get(id).title),'hidden_title_leak');
    check(!board.groups.some(g=>g.id===m.groups.pinned),'hidden_group_count_leak');
  }
  const partial=recipient.groups.find(g=>g.id===m.groups.pinned);same(partial?.member_ids,[m.ids.anchor,m.ids.selected],'dense_partial_order');check(partial.can_manage===false,'partial_group_manage');
  const flat=s.readNoteBoard(d,principal(d,s));same(flat.notes.map(n=>n.id),device.notes.map(n=>n.id),'flat_authorized_projection');
  same(snapshot(d),before,'read_changed_structure');
}
function summarize(mode,d,extra={}){
  const s=snapshot(d);return {ok:true,mode,notes:s.notes.length,groups:s.note_groups.length,receipts:s.note_group_receipts.length,clock:s.note_change_clock[0].version,
    state_hash:hash(s),membership_hash:hash(s.note_group_members),receipt_hash:hash(s.note_group_receipts),schema_hash:s.schema_hash,...extra};
}
function storeManifest(file,m,d){m.current=snapshot(d);fs.writeFileSync(file,JSON.stringify(m,null,2),{mode:0o600});}

export async function runNoteGroupsRecovery(mode){
  const paths=safePaths(mode);let m=paths.manifest,d;
  process.env.LOG_LEVEL='error';process.env.SESSION_SECRET||='synthetic-notes-recovery-session';
  try{
    // All path/identity checks above run before app import can migrate a DB.
    const db=await import('../../server/db.js');d=db.get();check(db.getPath()===paths.file,'application_database_path_changed');
    const s={...await import('../../server/services/note-board.js'),...await import('../../server/services/note-groups.js'),...await import('../../server/services/devices.js')};
    if(mode==='seed'){
      check(d.prepare('SELECT count(*) n FROM users').get().n===0&&d.prepare('SELECT count(*) n FROM notes').get().n===0,'seed_prior_user_data');
      for(const u of USERS)d.prepare("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(?,?,?,'synthetic-recovery-hash','member')").run(u.id,u.username,u.username);
      d.prepare('INSERT INTO sync_config(key,value) VALUES(?,?)').run(MARKER_KEY,MARKER);
      const permissions={modules:{notes:'read'},capabilities:Object.fromEntries(['view','create','edit','delete'].map(a=>[`device_notes.${a}`,'allow']))};
      d.prepare("INSERT INTO household_devices(id,name,permissions_json,scope_json,preferences_json) VALUES(?,'Synthetic recovery display',?,'{}','{}')").run(DEVICE,JSON.stringify(permissions));
      const note=(label,visibility='all',owner=OWNER)=>s.updateNote(d,owner,null,{title:`SYNTHETIC RECOVERY ${label}`,content:`Body ${label}`,visibility,...(visibility==='selected'?{access_user_ids:[RECIPIENT]}:{})}).id;
      const ids={anchor:note('Everyone anchor'),private:note('PRIVATE owner','private'),selected:note('SELECTED recipient','selected'),freeAnchor:note('Everyone free anchor'),freePage:note('Everyone free page'),deleteMe:note('Everyone deletion owner'),survivor:note('PRIVATE future survivor','all',RECIPIENT),faultTarget:note('Everyone fault target'),faultSource:note('Everyone fault source')};
      const pin=(id,layout)=>s.setNoteLayout(d,OWNER,id,{expected_layout_revision:0,layout:{x:layout.x,y:layout.y,width:layout.width,height:layout.height},position_locked:layout.position_locked,always_on_top:layout.always_on_top});
      const create=(target,source,name,layout)=>{pin(target,layout);const c=frozenCommand(s,d,'create',{source_note_id:source,target_note_id:target},[target,source],[],`recovery:create:${name}`);return s.applyNoteGroupCommand(d,OWNER,c).board.groups.find(g=>g.member_ids.includes(target)).id;};
      const groups={pinned:create(ids.anchor,ids.private,'pinned',rectangle(40,50)),unpinned:create(ids.freeAnchor,ids.freePage,'free',rectangle(100,120,true,false)),survivor:create(ids.deleteMe,ids.survivor,'survivor',rectangle(220,250))};
      s.applyNoteGroupCommand(d,OWNER,frozenCommand(s,d,'join',{target_group_id:groups.pinned,note_ids:[ids.selected],before_note_id:null},[ids.anchor,ids.private,ids.selected],[groups.pinned],'recovery:join:selected'));
      const receiptCommand=frozenCommand(s,d,'arrange',{items:[{kind:'group',id:groups.unpinned,layout:rectangle(100,120,false,false)}],include_locked:false},[ids.freeAnchor,ids.freePage],[groups.unpinned],'recovery:unpinned-layout');s.applyNoteGroupCommand(d,OWNER,receiptCommand);
      const hidden=d.prepare('SELECT revision FROM notes WHERE id=?').get(ids.survivor);s.updateNote(d,RECIPIENT,ids.survivor,{expected_revision:hidden.revision,visibility:'private'});pin(ids.faultTarget,rectangle(400,500));
      const staleCommand=frozenCommand(s,d,'reorder',{group_id:groups.pinned,selected_ids:[ids.selected],before_note_id:ids.anchor},[ids.anchor,ids.private,ids.selected],[groups.pinned],'recovery:stale-before-content');
      m={format:1,marker:MARKER,stage:'seeded',ids,groups,receiptCommand,staleCommand,survivorLayout:rectangle(220,250),protected:protectedHashes(d)};m.seed=snapshot(d);storeManifest(paths.state,m,d);assertPrivacy(d,s,m);return summarize(mode,d);
    }
    same(snapshot(d),m.current,'restart_changed_state');assertPrivacy(d,s,m);
    if(mode==='assert-forward')return summarize(mode,d);
    if(mode==='assert-fallback'){
      const undo={operation_id:'recovery:blocked-undo',kind:'undo',expected:{groups:[],notes:[]},undo_operation_id:m.receiptCommand.operation_id};
      for(const c of [m.staleCommand,m.receiptCommand,undo])mustReject(d,()=>s.applyNoteGroupCommand(d,OWNER,c),503,'structural_command_not_disabled');
      return summarize(mode,d,{blocked_commands:3});
    }
    if(mode==='exercise-fallback'){
      check(m.stage==='seeded','recovery_already_exercised');const before=snapshot(d),survivor=d.prepare('SELECT * FROM notes WHERE id=?').get(m.ids.survivor);
      mustReject(d,()=>s.mutateNote(d,OWNER,m.ids.survivor,'delete'),404,'hidden_delete_allowed');
      const old=d.prepare('SELECT * FROM notes WHERE id=?').get(m.ids.anchor);s.updateNote(d,OWNER,m.ids.anchor,{expected_revision:old.revision,content:'- [ ] Recovery item\nSynthetic ordinary edit'});
      s.mutateNote(d,OWNER,m.ids.anchor,'check',{line:0,checked:true,expect:'- [ ] Recovery item'});s.mutateNote(d,OWNER,m.ids.anchor,'pin');
      const changed=d.prepare('SELECT * FROM notes WHERE id=?').get(m.ids.anchor);check(changed.content==='- [x] Recovery item\nSynthetic ordinary edit'&&changed.pinned===1,'ordinary_actions_not_preserved');
      mustReject(d,()=>s.setNoteLayout(d,OWNER,m.ids.anchor,{expected_layout_revision:0,position_locked:false}),409,'legacy_group_layout_allowed');
      check(s.mutateNote(d,OWNER,m.ids.deleteMe,'delete')===null,'delete_disclosed_survivor');same(d.prepare('SELECT * FROM notes WHERE id=?').get(m.ids.survivor),survivor,'survivor_content_changed');
      const survivorLayout=d.prepare('SELECT * FROM note_layouts WHERE note_id=?').get(m.ids.survivor);same(Object.fromEntries(Object.keys(m.survivorLayout).map(k=>[k,typeof m.survivorLayout[k]==='boolean'?Boolean(survivorLayout[k]):survivorLayout[k]])),m.survivorLayout,'survivor_anchor_changed');
      check(!d.prepare('SELECT id FROM note_groups WHERE id=?').get(m.groups.survivor),'singleton_container_retained');same(rows(d,'note_group_receipts'),before.note_group_receipts,'ordinary_action_changed_receipts');
      same(rows(d,'note_access'),before.note_access,'ordinary_action_changed_audiences');
      const untouchedNotes=values=>values.filter(n=>![m.ids.anchor,m.ids.deleteMe].includes(n.id));same(untouchedNotes(rows(d,'notes')),untouchedNotes(before.notes),'unrelated_note_changed');
      const untouchedLayouts=values=>values.filter(n=>![m.ids.survivor,m.ids.deleteMe].includes(n.note_id));same(untouchedLayouts(rows(d,'note_layouts')),untouchedLayouts(before.note_layouts),'unrelated_layout_changed');
      for(const field of ['id','title','color','visibility','created_by','created_by_device','created_at'])same(changed[field],old[field],'ordinary_action_changed_identity');
      same(rows(d,'note_group_members'),before.note_group_members.filter(row=>row.group_id!==m.groups.survivor),'unrelated_membership_changed');same(rows(d,'note_groups'),before.note_groups.filter(row=>row.id!==m.groups.survivor),'unrelated_group_changed');same(protectedHashes(d),m.protected,'unrelated_user_data_changed');
      m.stage='fallback-exercised';storeManifest(paths.state,m,d);assertPrivacy(d,s,m);return summarize(mode,d,{hidden_survivor_preserved:true});
    }
    if(mode==='assert-restored'){
      check(m.stage==='fallback-exercised','fallback_exercise_required');const before=snapshot(d);
      // The command was committed by the seed subprocess without exposing its
      // board result. A later runtime must recover that uncertain outcome once.
      const replay=s.applyNoteGroupCommand(d,OWNER,m.receiptCommand);check(replay.replayed===true,'durable_receipt_not_replayed');same(snapshot(d),before,'replay_changed_state');
      check(replay.board.notes.find(n=>n.id===m.ids.anchor)?.content==='- [x] Recovery item\nSynthetic ordinary edit','replay_did_not_project_current_content');
      mustReject(d,()=>s.applyNoteGroupCommand(d,OWNER,m.staleCommand),409,'stale_client_accepted');
      const next=frozenCommand(s,d,'reorder',{group_id:m.groups.unpinned,selected_ids:[m.ids.freePage],before_note_id:m.ids.freeAnchor},[m.ids.freeAnchor,m.ids.freePage],[m.groups.unpinned],'recovery:resumed-reorder');
      const changed=s.applyNoteGroupCommand(d,OWNER,next);same(changed.board.groups.find(g=>g.id===m.groups.unpinned).member_ids,[m.ids.freePage,m.ids.freeAnchor],'forward_not_reenabled');
      s.applyNoteGroupCommand(d,OWNER,{operation_id:'recovery:resumed-undo',kind:'undo',expected:{groups:[],notes:[]},undo_operation_id:next.operation_id});
      same(rows(d,'note_group_members'),before.note_group_members,'forward_return_changed_membership');same(snapshot(d).schema_hash,before.schema_hash,'schema_rolled_back');m.stage='restored';storeManifest(paths.state,m,d);return summarize(mode,d,{replayed:true,stale_client_rejected:true});
    }
    if(mode==='fault-rollback'){
      const before=snapshot(d),c=frozenCommand(s,d,'create',{source_note_id:m.ids.faultSource,target_note_id:m.ids.faultTarget},[m.ids.faultSource,m.ids.faultTarget],[],'recovery:fault');
      const triggers=[`CREATE TEMP TRIGGER recovery_fault BEFORE INSERT ON note_group_members WHEN NEW.note_id=${m.ids.faultSource} BEGIN SELECT RAISE(ABORT,'synthetic recovery fault'); END`,"CREATE TEMP TRIGGER recovery_fault BEFORE INSERT ON note_group_receipts BEGIN SELECT RAISE(ABORT,'synthetic recovery fault'); END"];
      for(const sql of triggers){
        d.exec(sql);let failed=false;try{s.applyNoteGroupCommand(d,OWNER,c);}catch(error){failed=error.code==='SQLITE_CONSTRAINT_TRIGGER';}finally{d.exec('DROP TRIGGER recovery_fault');}
        check(failed,'injected_fault_not_reached');same(snapshot(d),before,'fault_did_not_rollback');
      }
      return summarize(mode,d,{faults:triggers.length});
    }
  }finally{if(d?.open){d.pragma('wal_checkpoint(TRUNCATE)');d.close();}}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{process.stdout.write(JSON.stringify(await runNoteGroupsRecovery(process.argv[2]))+'\n');}
  catch(error){process.stderr.write(JSON.stringify({ok:false,error:error.recoveryCode||'recovery_assertion_failed'})+'\n');process.exitCode=1;}
}
