/** Pure occurrence planner. Callers must supply a versioned, authorized
 * eligibility snapshot. Its persisted resolver is internal; no public route
 * authors rules or enables these new modes yet. */
import {createHash} from 'node:crypto';

const ids=value=>[...new Set((value||[]).map(Number).filter(id=>Number.isSafeInteger(id)&&id>0))];
const seed=(parts,length)=>Number(createHash('sha256').update(parts.join(':')).digest().readBigUInt64BE(0)%BigInt(length));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const directionOrder=(order,start,direction)=>{
  const index=Math.max(0,order.indexOf(start));
  return Array.from({length:order.length},(_,n)=>order[(index+(direction==='last_to_first'?-n:n)+order.length*2)%order.length]);
};

/** A row contains key, points, source, eligible_user_ids and optional
 * persisted_user_ids/locked. Eligibility includes skills, presence and a
 * feasible qualified supervisor. It is never recomputed by this pure planner. */
export function planSubtaskAssignments({snapshotVersion,occurrenceKey,rows}={}){
  if(!snapshotVersion||!occurrenceKey||!Array.isArray(rows)||rows.length>200)
    throw new Error('A versioned occurrence and bounded subtask list are required.');
  const seenKeys=new Set(),decisions=new Map(),conflicts=[],cursorAdvances=[],loads=new Map(),normalized=new Map();
  const byPoints=rows.some(row=>Number(row.points)>0);
  const load=id=>loads.get(id)||{points:0,count:0};
  const score=id=>byPoints?[load(id).points,load(id).count,id]:[load(id).count,id];
  const compare=(a,b)=>{const left=score(a),right=score(b);for(let n=0;n<left.length;n++)if(left[n]!==right[n])return left[n]-right[n];return 0;};
  const assign=(row,people)=>{const selected=ids(people);decisions.set(row.key,{key:row.key,source:row.source,assignee_ids:selected,state:'assigned',
    decision_key:`${occurrenceKey}:${row.key}:${row.source.kind}:${row.source.group_id||''}`});
    for(const id of selected){const before=load(id);loads.set(id,{points:before.points+Number(row.points),count:before.count+1});}};
  const conflict=(row,reason)=>{conflicts.push({key:row.key,reason});decisions.set(row.key,{key:row.key,source:row.source,assignee_ids:[],state:'unresolved'});};
  for(const row of rows){
    if(typeof row.key!=='string'||!row.key||seenKeys.has(row.key)||!['fixed','group'].includes(row.source?.kind))
      throw new Error('Every subtask needs one distinct key and source rule.');
    if(!Number.isFinite(Number(row.points))||Number(row.points)<0)throw new Error('Invalid subtask points.');
    seenKeys.add(row.key);
    normalized.set(row.key,{eligible:new Set(ids(row.eligible_user_ids)),order:ids(row.source.member_order)});
    if(row.locked||row.persisted_user_ids?.length){
      const saved=ids(row.persisted_user_ids);
      if(!saved.length)throw new Error('A locked subtask needs its persisted assignee.');
      if(!row.locked&&saved.some(id=>!normalized.get(row.key).eligible.has(id)))conflict(row,'persisted_assignee_ineligible');
      else assign(row,saved);
    }
  }
  const pending=rows.filter(row=>!decisions.has(row.key));
  for(const row of pending.filter(row=>row.source.kind==='fixed')){
    const selected=ids(row.source.user_ids),eligible=normalized.get(row.key).eligible;
    if(!selected.length||selected.some(id=>!eligible.has(id)))conflict(row,'fixed_person_ineligible');
    else assign(row,selected);
  }
  for(const row of pending.filter(row=>row.source.kind==='group'&&['global','random'].includes(row.source.mode))){
    const source=row.source,{eligible,order:members}=normalized.get(row.key),order=members.filter(id=>eligible.has(id));
    const selected=source.mode==='global'?Number(source.scheduled_user_id)
      :order.length?order[seed([occurrenceKey,row.key,source.group_id,'random'],order.length)]:null;
    if(source.mode==='global'&&!source.shared)conflict(row,'global_requires_shared_group');
    else if(!eligible.has(selected)||!members.includes(selected))conflict(row,'no_eligible_group_member');
    else assign(row,[selected]);
  }
  const synced=new Map();
  for(const row of pending.filter(row=>row.source.kind==='group'&&row.source.mode==='synced')){
    const id=Number(row.source.group_id);if(!synced.has(id))synced.set(id,[]);synced.get(id).push(row);
  }
  for(const [groupId,groupRows] of synced){
    const source=groupRows[0].source,order=normalized.get(groupRows[0].key).order;
    const held=ids(rows.filter(row=>row.source.kind==='group'&&row.source.mode==='synced'
      &&Number(row.source.group_id)===groupId&&decisions.get(row.key)?.state==='assigned')
      .flatMap(row=>decisions.get(row.key).assignee_ids));
    let eligible=new Set(order);
    for(const row of groupRows)eligible=new Set([...normalized.get(row.key).eligible].filter(id=>eligible.has(id)));
    if(held.length)eligible=new Set([...eligible].filter(id=>held.includes(id)));
    const inconsistent=source.shared||held.length>1||groupRows.some(row=>!same(normalized.get(row.key).order,order)
      ||row.source.direction!==source.direction||row.source.start_mode!==source.start_mode);
    if(inconsistent||!eligible.size){for(const row of groupRows)conflict(row,inconsistent?'synced_policy_conflict':'synced_no_common_eligible_member');continue;}
    const previous=Number(source.cursor_user_id)||null;
    const first=source.start_mode==='random'?order[seed([occurrenceKey,groupId,'synced-start'],order.length)]:order[0];
    const next=previous&&order.includes(previous)
      ?order[(order.indexOf(previous)+(source.direction==='last_to_first'?-1:1)+order.length)%order.length]:first;
    const selected=directionOrder(order,next,source.direction).find(id=>eligible.has(id));
    if(!selected){for(const row of groupRows)conflict(row,'synced_no_common_eligible_member');continue;}
    for(const row of groupRows)assign(row,[selected]);
    if(!held.length)cursorAdvances.push({group_id:groupId,user_id:selected,decision_key:`${occurrenceKey}:synced:${groupId}`});
  }
  const smart=pending.filter(row=>row.source.kind==='group'&&row.source.mode==='smart');
  const eligiblePools=new Map(smart.map(row=>[row.key,normalized.get(row.key).order.filter(id=>normalized.get(row.key).eligible.has(id))]));
  const eligiblePool=row=>eligiblePools.get(row.key);
  smart.sort((a,b)=>eligiblePool(a).length-eligiblePool(b).length
    ||Number(b.points)-Number(a.points)||a.key.localeCompare(b.key));
  // Polynomial augmenting-path matching maximizes distinct recipients first.
  const owner=new Map(),choice=new Map(),matchingOrder=new Map(smart.map(row=>[row.key,[...eligiblePool(row)].sort(compare)]));
  const match=(row,seen)=>{
    const eligible=matchingOrder.get(row.key);
    for(const id of eligible)if(!owner.has(id)){owner.set(id,row);choice.set(row.key,id);return true;}
    for(const id of eligible){if(seen.has(id))continue;seen.add(id);
      const other=owner.get(id);if(match(other,seen)){owner.set(id,row);choice.set(row.key,id);return true;}}
    return false;
  };
  for(const row of smart)if(!eligiblePool(row).length)conflict(row,'no_eligible_group_member');
    else match(row,new Set());
  for(const row of smart){
    if(decisions.has(row.key))continue;
    const eligible=eligiblePool(row);
    const selected=choice.get(row.key)||eligible.sort(compare)[0];
    if(!selected)conflict(row,'no_eligible_group_member');else assign(row,[selected]);
  }
  for(const row of pending)if(!decisions.has(row.key))conflict(row,'unsupported_assignment_mode');
  return {snapshot_version:snapshotVersion,occurrence_key:occurrenceKey,
    decisions:rows.map(row=>decisions.get(row.key)),conflicts,cursor_advances:cursorAdvances};
}
