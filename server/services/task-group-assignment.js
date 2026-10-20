import {normalizeGroupAssignment,groupAssignmentMembers,chooseGroupAssignee} from './group-assignment.js';
import {assertTaskSkillAssignments,TaskSkillError} from './task-skills.js';
import {assertTaskAssignmentAvailability,TaskAssignmentAvailabilityError} from './assignment-responsibilities.js';
import {todayKey} from '../utils/timezone.js';

/** Reuse ordinary Task skill and presence boundaries for each proposed Group
 * member. The source Task supplies planning context for prospective recurrence. */
export function selectTaskGroupMember(d,taskId,configuration,skills,{consumerKey,commit=true,allowDelegation=true,window=null}={}) {
  const task={...d.prepare('SELECT * FROM tasks WHERE id=?').get(taskId),...(window||{})};
  const config=normalizeGroupAssignment(d,configuration,{allowInactive:!commit});
  const candidates=groupAssignmentMembers(d,config).filter(userId=>{
    try{assertTaskSkillAssignments(d,skills,[userId],task.due_date||todayKey(d),{allowDelegation});
      assertTaskAssignmentAvailability(d,taskId,[userId],{task});return true;}
    catch(error){if(error instanceof TaskSkillError||error instanceof TaskAssignmentAvailabilityError)return false;throw error;}
  });
  return chooseGroupAssignee(d,config,{consumerKey,eligibleIds:candidates,commit,dateKey:task.due_date||todayKey(d)});
}
