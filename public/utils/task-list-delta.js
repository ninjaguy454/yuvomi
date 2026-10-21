/** Pure merge for an authoritative, query-bound Task list delta. */
const PRIORITY={urgent:0,high:1,medium:2,low:3};
export function compareTaskListRows(a,b){
  const done=Number(a.status==='done')-Number(b.status==='done');if(done)return done;
  const priority=(PRIORITY[a.priority]??4)-(PRIORITY[b.priority]??4);if(priority)return priority;
  if(a.due_date!==b.due_date){if(!a.due_date)return 1;if(!b.due_date)return -1;
    return String(a.due_date).localeCompare(String(b.due_date));}
  const created=String(b.created_at||'').localeCompare(String(a.created_at||''));if(created)return created;
  return Number(b.id)-Number(a.id);
}
export function mergeTaskListDelta(current,{data=[],removed=[]}={}){
  const rows=new Map(current.map(row=>[Number(row.id),row]));
  for(const id of removed)rows.delete(Number(id));
  for(const row of data){
    const prior=rows.get(Number(row.id));
    if(prior&&Number.isSafeInteger(Number(prior.revision))&&Number.isSafeInteger(Number(row.revision))
      &&Number(prior.revision)>Number(row.revision))continue;
    rows.set(Number(row.id),row);
  }
  return [...rows.values()].sort(compareTaskListRows);
}
export function mergeTaskStartVisibility(previous,next){
  const old=Number(previous?.next_start_at),fresh=Number(next?.next_start_at);
  const oldValid=Number.isFinite(old)&&previous?.next_start_at!=null;
  const newValid=Number.isFinite(fresh)&&next?.next_start_at!=null;
  return {server_now:next?.server_now??previous?.server_now,
    next_start_at:oldValid&&newValid?Math.min(old,fresh):oldValid?old:newValid?fresh:null};
}
