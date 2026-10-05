import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='synthetic-group-commands';process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS}=await import('../../server/db.js');
const {setNoteLayout}=await import('../../server/services/note-board.js');
const {readGroupedNoteBoard}=await import('../../server/services/note-groups.js');
const {ensureNoteLayoutOwner,nextNoteGroupId,noteLayoutOwnerKey}=await import('../../server/services/note-layout-owner.js');
export const rect=(extra={})=>({x:20,y:30,width:6,height:8,position_locked:false,always_on_top:true,...extra});
export function fixture(count=10,actor=1){
  const d=new Database(':memory:');d.pragma('foreign_keys=ON');
  for(const m of ALL_MIGRATIONS){typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);}
  d.exec("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(1,'one','One','x','member'),(2,'two','Two','x','member'),(3,'admin','Admin','x','admin')");
  const insert=d.prepare('INSERT INTO notes(id,content,created_by,pinned) VALUES(?,?,1,?)');
  for(let i=1;i<=count;i++)insert.run(i,`PRIVATE BODY ${i}`,+(i===1));
  const group=(ids,layout=rect({position_locked:true}),principal=actor)=>{
    const ownerKey=noteLayoutOwnerKey(principal);ensureNoteLayoutOwner(d,ownerKey);
    const id=nextNoteGroupId(d,ownerKey);d.prepare('INSERT INTO note_board_groups(owner_key,id,x,y,width,height,position_locked,always_on_top) VALUES(?,?,?,?,?,?,?,?)').run(ownerKey,id,layout.x,layout.y,layout.width,layout.height,+layout.position_locked,+layout.always_on_top);
    ids.forEach((n,i)=>d.prepare('INSERT INTO note_board_group_members(owner_key,note_id,group_id,ordinal) VALUES(?,?,?,?)').run(ownerKey,n,id,i));return id;
  };
  const pin=(id,principal=actor)=>setNoteLayout(d,principal,id,{expected_layout_revision:0,layout:{x:40,y:50,width:8,height:10},position_locked:true,always_on_top:true});
  return {d,group,pin};
}
export function command(d,kind,fields,noteIds,groupIds=[],operation_id=crypto.randomUUID(),actor=1){
  const b=readGroupedNoteBoard(d,actor);
  return {operation_id,kind,expected:{groups:groupIds.map(id=>({id,revision:b.groups.find(g=>g.id===id).revision})),notes:noteIds.map(id=>{const n=b.notes.find(n=>n.id===id);return {id,revision:n.revision,layout_revision:n.layout.revision};})},...fields};
}
export const state=d=>Object.fromEntries(['notes','note_access','note_layouts','note_groups','note_group_members','note_group_receipts','note_board_owners','note_board_note_layouts','note_board_groups','note_board_group_members','note_board_group_receipts','note_change_clock'].map(table=>[table,d.prepare(`SELECT * FROM ${table}`).all()]));
