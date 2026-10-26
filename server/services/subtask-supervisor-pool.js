import {householdMembers,ageOnDate} from './activity-eligibility.js';
import {groupAssignmentMembers,normalizeGroupAssignment} from './group-assignment.js';
import {todayKey} from '../utils/timezone.js';

export function supervisorPool(d,encoded,members,byId,dateKey){
  if(encoded==null)return members.filter(member=>{
    const age=ageOnDate(member.birth_date,dateKey);
    return age!==null?age>=18:['dad','mom','parent','grandparent'].includes(member.family_role);
  }).map(member=>member.id);
  const pool=JSON.parse(encoded);
  if(pool?.kind==='person'&&byId.has(Number(pool.user_id)))return [Number(pool.user_id)];
  if(pool?.kind==='group')return groupAssignmentMembers(d,
    normalizeGroupAssignment(d,{group_id:pool.group_id},{allowInactive:false,allowImported:false}));
  throw Object.assign(new Error('Choose an existing supervisor Person or Group.'),{status:409});
}

/** Batch the authored pool read for a whole split scope and share repeated pools. */
export function configuredSubtaskSupervisorIdsForActions(d,root,actionIds,members=householdMembers(d)){
  const ids=[...new Set(actionIds.map(Number))];
  if(!ids.length)return new Map();
  const rows=d.prepare(`SELECT t.id,t.due_date,t.start_date,r.source_json,r.supervisor_pool_json
    FROM tasks t LEFT JOIN task_subtask_assignment_rules r ON r.task_id=t.id
    WHERE t.id IN (${ids.map(()=>'?').join(',')})`).all(...ids);
  const byId=new Map(members.map(member=>[member.id,member]));
  const parsed=rows.map(row=>{
    try{const source=row.source_json?JSON.parse(row.source_json):null;
      return {...row,groupId:source?.kind==='group'?Number(source.group_id):null};}
    catch{return {...row,invalid:true,groupId:null};}
  });
  const groupIds=[...new Set(parsed.map(row=>row.groupId).filter(Boolean))];
  const defaults=new Map(groupIds.length?d.prepare(`SELECT group_id,pool_json FROM rotation_group_supervisor_defaults
    WHERE group_id IN (${groupIds.map(()=>'?').join(',')})`).all(...groupIds).map(row=>[row.group_id,row.pool_json]):[]);
  const cache=new Map(),result=new Map();
  for(const row of parsed){
    const encoded=row.supervisor_pool_json??(row.groupId?defaults.get(row.groupId):null)??null;
    const dateKey=row.due_date||root.due_date||row.start_date||root.start_date||todayKey(d);
    const key=JSON.stringify([row.invalid===true,encoded,dateKey]);
    if(!cache.has(key)){
      try{cache.set(key,row.invalid?[]:supervisorPool(d,encoded,members,byId,dateKey));}
      catch{cache.set(key,[]);}
    }
    result.set(row.id,cache.get(key));
  }
  return result;
}

export function configuredSubtaskSupervisorIds(d,rootId,actionId,members=householdMembers(d)){
  const root=d.prepare('SELECT id,due_date,start_date FROM tasks WHERE id=?').get(rootId);
  if(!root)throw Object.assign(new Error('Choose an Activity.'),{status:400});
  return configuredSubtaskSupervisorIdsForActions(d,root,[actionId],members).get(actionId)||[];
}
