/** HTTP fixture for standalone arrange commands in the existing page tests.
 * Reject incomplete or stale snapshots before changing any fixture geometry. */
export function arrangeNotesFixture(notes, command, { conflict=false } = {}) {
  const sorted = rows => [...rows].sort((a,b)=>a.id-b.id);
  const items = command.items || [], affected = items.map(item=>notes.find(note=>note.id===item.id));
  const expected = affected.every(Boolean) ? sorted(affected.map(note=>({id:note.id,revision:note.revision,layout_revision:note.layout?.revision??0}))) : null;
  if (conflict || command.kind!=='arrange' || typeof command.operation_id!=='string' || !command.operation_id || items.some(item=>item.kind!=='note') || command.expected?.groups?.length!==0 || JSON.stringify(sorted(command.expected?.notes||[]))!==JSON.stringify(expected)) {
    return {status:409,body:{error:'Changed elsewhere',code:409}};
  }
  for (const item of items) {
    const note=notes.find(note=>note.id===item.id);
    note.layout={...item.layout,revision:(note.layout?.revision??0)+1};
  }
  return {status:200,body:{data:{operation_id:command.operation_id,replayed:false,board:{notes:structuredClone(notes),groups:[]},undo_available:true}}};
}
