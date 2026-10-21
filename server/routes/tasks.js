import {setTaskAssignments as setAssignments} from '../services/task-assignments.js';
import {parseCategoryAssigneeLimit,categoryAssigneePolicy,assertAssigneeCount,proposedTaskAssigneePolicy,persistTaskAssigneePolicy,persistNewTaskAssignees,assigneePolicyProjection,readTaskAssigneePolicy,persistCapturedTaskAssignees,proposeDefinitionAssigneePolicies,proposedBoundTaskCategoryPolicy,taskDirectAssignmentSelection} from '../services/task-assignee-policy.js';
import {isTripStep,tripTaskState,markTripTaskOverrides} from '../services/trip-task-state.js';
import {attachTripTaskProjection} from '../services/trip-task-projection.js';
import {retireTripTask,refreshTripStepReminders} from '../services/trip-tasks.js';
import {listTaskOffers,taskOfferState} from '../services/task-offers.js';
import {acceptanceOptions} from '../services/task-acceptance-policy.js';
import {acceptTask} from '../services/task-acceptance.js';
import {previewTemplateLaunch,createTemplateLaunch,TemplateLaunchError} from '../services/task-template-launch.js';
import {attachTaskHelperViewMetadata} from '../services/task-helper-views.js';
import {skipTaskOccurrence,taskSkipUnsupportedReason,taskSkipHasRotationScope} from '../services/task-skip.js';
import {closeIncompleteTask,reopenIncompleteTask,taskCloseUnsupportedReason} from '../services/task-close.js';
/**
 * Modul: Aufgaben (Tasks)
 * Zweck: REST-API-Routen für Aufgaben und Teilaufgaben (max. 2 Ebenen)
 * Abhängigkeiten: express, server/db.js
 */

import { createLogger } from '../logger.js';
import { randomUUID } from 'node:crypto';
import express from 'express';
import {assignNewTaskCardColor,setTaskCardColor,freezeSeriesCardColorPolicy,preserveFutureCardColorPolicies} from '../services/task-card-colors.js';
import {validateCardColorChoice,normalizeCardColorChoice} from '../../public/utils/card-colors.js';
import * as db from '../db.js';
import { documentVisibleSql } from '../services/document-access.js';
import { nextDueAfterCompletion, nextDueAfterExpiration } from '../services/recurrence.js';
import { addCalendarDays, calendarDayOffset, resolveActivitySchedule } from '../services/activity-schedule.js';
import { registerRecurrenceOccurrence, registerRecurrenceAction, recurrenceFrontier, isRecurrenceFrontier, isTerminalRecurrenceOccurrence } from '../services/task-recurrence-frontier.js';
import { ensureSeriesDefinition, seriesMaterializationPlan, recordOccurrenceDefinition, registerSeriesAction, authoritativeTaskRecurrence,
  seriesMetadata, taskSeriesState, captureSeriesDefinition, appendSeriesDefinition, definitionEqual, seriesDefinitionForGeneration,
  normalizeSeriesSchedule, effectiveSeriesScoringDefinition, seriesActionAuthorization, planSeriesOccurrence,
  prepareSeriesOccurrenceWork, seriesRotationAssignment, translatedSeriesDate } from '../services/task-series.js';
import { proposedSeriesDefinition, proposedFutureSeriesDefinition, resolveSeriesDraftClientKeys, sameSeriesBindingPolicy, futureActionCapabilities, futureRootCapabilities, assertSeriesEdit, assertSeriesDefinitionMutation, reconcileSeriesFuture, seriesOccurrencePreservationReason } from '../services/task-series-edit.js';
import {taskScoringSummary,previewTaskScoring,assertTaskScoringMutation,taskScoringRoot,taskScoringRows,taskScoringIdentity} from '../services/task-scoring.js';
import { readTaskActivityDefinition, updateTaskActivitySnapshotSkills, captureActivityTemplateDefinition } from '../services/task-activity-snapshot.js';
import { syncTaskRewards } from '../services/rewards.js';
import { unresolvedDependencies, syncWorkflowInstanceForTask, resolveActivityTemplate } from '../services/activity-workflows.js';
import {
  TaskActivityBindingError,
  activitySupportTasks,
  applyTaskActivityBinding,
  attachTaskActivityBindings,
  clearTaskActivityBinding,
  copyTaskActivityBinding,
  getTaskActivityBinding,
  matchesGeneratedActivitySupportTask,
  ordinaryActivitySubtasks,
  previewTaskActivityBinding,
  overrideTaskActivityAssignees,
} from '../services/task-activity-bindings.js';
import { occurrenceFeed, occurrenceHistory, syncTaskCompletion } from '../services/task-completions.js';
import { normalizeCategoryFilter, taskCategoryWhere, taskStartProjection, taskScopeWhere } from '../services/task-scope.js';
import { taskUnskippedWhere } from '../services/task-window.js';
import { normalizeRotationBindings, parseRotationBindings, rotationBindingsEqual, assertRotationBindingsChange, bindTaskRotations, taskRotationContexts } from '../services/task-rotation.js';
import { householdMembers } from '../services/activity-eligibility.js';
import {normalizeGroupAssignment,recordGroupAssignment} from '../services/group-assignment.js';
import {mappedLegacyRotationGroups,refreshLegacyRotationGroupMapping,convertedLegacyFutureDefinition} from '../services/legacy-rotation-conversion.js';
import {selectTaskGroupMember as selectTaskGroupMemberForDatabase} from '../services/task-group-assignment.js';
import { initializeTaskRotationRendering, applyTaskRotationRendering, refreshTaskRotationRendering } from '../services/task-rotation-rendering.js';
import { rotationCompletionEvidence } from '../services/rotation-completion-evidence.js';
import { workflowRotationOperations } from '../services/workflow-rotation-operations.js';
import { normalizeVisibility, visibilityWhere } from '../services/visibility.js';
import {
  flushOutbound, markTodoOutbound, queueTodoDeletion,
} from '../services/caldav-todo-outbound.js';
import { uniqueKey } from '../utils/category-slug.js';
import { parseSyncTargetValue } from '../../public/utils/sync-target.js';
import { mentionedUserIds } from '../../public/utils/mentions.js';
import { toggleChecklistLine } from '../../public/utils/markdown-checklist.js';
import { notifyTaskAssignments } from '../services/notification-events.js';
import { enqueueNotification } from '../services/notification-inbox.js';
import { todayKey } from '../utils/timezone.js';
import { requireAdmin } from '../middleware/require-admin.js';
import {
  attachTaskLocations,
  copyTaskLocation,
  normalizeTaskLocation,
  promoteTaskGoogleLocation,
  setTaskLocation,
  storedTaskLocation,
  TaskLocationError,
} from '../services/task-locations.js';
import {
  allTags, applyTagChanges, loadTags, loadTagsFor, normalizeTags,
  removeTagEverywhere, renameTag, setTags, tagKey, tagsKey, taskIdsWithTag,
} from '../utils/task-tags.js';
import * as v from '../middleware/validate.js';
import { TaskSkillError, normalizeSkillIds, loadTaskSkillIds, setTaskSkills, copyTaskSkills,
  attachTaskSkills, assertTaskSkillAssignments, qualifiedTaskAssignees } from '../services/task-skills.js';
import { assertTaskAssignmentAvailability, TaskAssignmentAvailabilityError } from '../services/assignment-responsibilities.js';
import { assertTaskMutation, attachTaskCapabilities, taskCapabilities, taskVisibilityWhere, taskSupervisionManagementAllowed, withTaskReadProjection, withTaskReadSnapshot,taskReadRecord,taskReadStatement } from '../services/task-access.js';
import { assertTaskRevision, changeTaskStatus, reopenExpiredTask, assertTaskWindowAction, configureTaskRecurrence, recordTaskActivity, taskActivity, TaskStateError } from '../services/task-lifecycle.js';
import { attachTaskSupervision, reconcileTaskSupervision, assertTaskSupervisionAssignee, deleteTaskSupervisionProjections, taskSupervisionRootId, prepareProspectiveTaskExecution } from '../services/task-supervision.js';
import { EXPIRATION_POLICIES, taskDeadlineMs, taskStartMs, taskWindowAncestors } from '../services/task-window.js';
import { createTaskOptionalContextReader } from '../services/task-optional.js';
import { taskChangesStream } from '../services/task-changes.js';
import { assertCapability,hasCapability } from '../permissions.js';

const log = createLogger('Tasks');

/**
 * Ausgehende Arbeit an einem CalDAV-Spiegel anstoßen (#617). Bewusst nach der
 * Antwort und ohne await: der Server-Aufruf darf die Antwort weder verzögern
 * noch scheitern lassen. Schlägt er fehl, bleibt die Vormerkung liegen und der
 * nächste Sync-Lauf holt sie nach.
 */
function pushToCalDAV(what) {
  flushOutbound().catch((err) => log.warn(`${what} vorgemerkt, Sofortversuch fehlgeschlagen:`, err.message));
}

/**
 * Prüft ein gewünschtes Sync-Ziel gegen die tatsächlich freigegebenen Listen (#695).
 *
 * Geprüft wird gegen die Auswahltabelle und nicht nur gegen das Format: sonst
 * ließe sich eine Aufgabe auf eine abgewählte oder gar dem Einkauf zugeordnete
 * Liste richten, und sie bliebe für immer im Wartezustand, ohne dass irgendwo
 * stünde warum.
 *
 * @returns {{ok: true, target: {accountId: number, listUrl: string}|null}
 *          |{ok: false, error: string}} target === null heißt "nur lokal".
 */
function resolveTaskSyncTarget(value) {
  const parsed = parseSyncTargetValue(value);
  if (parsed === null) {
    return { ok: false, error: 'sync_target: erwartet "caldav:<kontoId>|<url>" oder einen leeren Wert.' };
  }
  if (parsed.kind === 'local') return { ok: true, target: null };
  if (parsed.kind !== 'caldav') {
    // Aufgaben kennen kein Google-Ziel: der VTODO-Abgleich läuft ausschließlich
    // über CalDAV, ein "google:"-Wert wäre also eine stille Nullaktion.
    return { ok: false, error: 'sync_target: Aufgaben lassen sich nur mit einer CalDAV-Erinnerungsliste abgleichen.' };
  }

  const allowed = db.get().prepare(`
    SELECT 1 FROM caldav_reminder_selection
     WHERE account_id = ? AND list_url = ? AND enabled = 1 AND target_module = 'tasks'
  `).get(parsed.accountId, parsed.calendarUrl);
  if (!allowed) {
    return { ok: false, error: 'sync_target: Diese Erinnerungsliste ist für Aufgaben nicht freigegeben.' };
  }
  return { ok: true, target: { accountId: parsed.accountId, listUrl: parsed.calendarUrl } };
}

const router = express.Router();
const templateLaunchSnapshot = Symbol('templateLaunchSnapshot');

// Same permission and revision checks for both mounted compatibility prefixes.
router.use((req,res,next) => {
  if (!['POST','PUT','PATCH','DELETE'].includes(req.method)) return next();
  try {
    const path = req.path.toLowerCase().replace(/\/+$/, '') || '/';
    if (/^\/(tags|categories)(\/|$)/.test(path)) assertCapability(db.get(),req,'tasks.change_category_tags');
    if (req.method === 'POST' && path === '/') {
      assertTaskMutation(db.get(),req,null,req.body,{operation:'create'});
      if (req.body.parent_task_id) {
        const parent = db.get().prepare('SELECT * FROM tasks WHERE id=?').get(req.body.parent_task_id);
        if (parent) {
          assertTaskMutation(db.get(),req,parent,{subtasks:[]},{operation:'update'});
          assertTaskRevision(db.get(),parent,{expected_revision:req.body.expected_parent_revision},{required:true});
        }
      }
    }
    next();
  } catch(error) {
    res.status(error.status||403).json({error:error.message,code:error.status||403,...error.details});
  }
});
// Bind checks to Express's matched route and decoded parameter. Matching raw
// req.path allowed encoded IDs, case aliases and trailing slashes to skip them.
router.param('id',(req,res,next,value)=>{
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value)<1)
    return res.status(404).json({error:'Task not found.',code:404});
  if (!['POST','PUT','PATCH','DELETE'].includes(req.method)) return next();
  const route=req.route.path;
  if (route==='/:id/supervisor' || route==='/:id/location/promote' || route==='/:id/rotation/reconcile' || route==='/:id/accept' || route==='/:id/skip' || route==='/:id/close-incomplete' || route==='/:id/reopen-incomplete') return next();
  try {
    const task=db.get().prepare('SELECT * FROM tasks WHERE id=?').get(Number(value));
    if (!task) return res.status(404).json({error:'Task not found.',code:404});
    const action=route.split('/')[2];
    if(action==='check')assertTaskWindowAction(db.get(),task.id);
    const body=req.body||{};
    const operation=action==='comments'?'comment'
      :action==='status'&&body.status==='archived'?'archive'
      :action||(req.method==='DELETE'?'delete':'update');
    assertTaskMutation(db.get(),req,task,body,{operation});
    if (!(req.method==='POST'&&route==='/:id/comments'))
      assertTaskRevision(db.get(),task,body,{required:true,requireParent:true});
    return next();
  } catch(error) {
    return res.status(error.status||403).json({error:error.message,code:error.status||403,...error.details});
  }
});
router.get('/changes', taskChangesStream);
configureTaskRecurrence({spawn:spawnRecurrenceFollowup,discard:discardRecurrenceFollowup});

// --------------------------------------------------------
// Konstanten
// --------------------------------------------------------

const VALID_PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'];
const VALID_ASSIGNMENT_MODES = ['fixed', 'round_robin'];

// Die drei Zustände, die eine Aufgabe im Lauf durchläuft. Mehr steht nicht im
// Statusfeld.
const REAL_STATUSES = ['open', 'in_progress', 'done'];

// 'archived' war bis v1.86.2 ein vierter Statuswert und ist seit #688 eine eigene
// Achse (tasks.archived_at). Als Eingabe bleibt es erlaubt: Bestandsclients, die
// MCP-Schnittstelle und der Filterchip der Oberfläche sprechen weiter so darüber,
// und für sie bedeutet es unverändert „ablegen" bzw. „das Archiv zeigen". Was es
// nicht mehr tut: den Status überschreiben.
const ARCHIVE_STATUS = 'archived';
const VALID_STATUSES = [...REAL_STATUSES, ARCHIVE_STATUS];

const MAX_POINTS = 10000;
const FALLBACK_CATEGORY = 'misc';

function validateScoringInput(body) {
  if(Object.hasOwn(body,'scoring_mode')&&!['whole_task','subtasks'].includes(body.scoring_mode))
    throw new TaskStateError('Choose Whole task or Each subtask.',{reason:'invalid_scoring_mode'},400);
  for(const row of [body,...(Array.isArray(body.subtasks)?body.subtasks:[])])if(row&&Object.hasOwn(row,'points')) {
    const value=row.points;
    if(!['number','string'].includes(typeof value)||String(value).trim()===''||!Number.isInteger(Number(value))||Number(value)<0||Number(value)>MAX_POINTS)
      throw new TaskStateError(`${row===body?'Points':'Subtask points'} must be a whole number from 0 to 10000.`,{reason:'invalid_points'},400);
  }
}
function assertScoringOwner(task,body) {
  if(body.scoring_mode!==undefined&&taskScoringRoot(db.get(),task.id)?.id!==task.id)
    throw new TaskStateError('Choose the scoring mode on the original executable Task.',{reason:'scoring_owner_required'},400);
}
function draftVisibilityAssignees(task,body,ids,edited){
  if(!task||task.parent_task_id)return ids;
  const enrolled=readTaskAssigneePolicy(db.get(),task.id)||proposedTaskAssigneePolicy(db.get(),task,body,{directIds:ids});if(!enrolled)return ids;
  const derived=edited?edited.next.flatMap(child=>child.assignedUsers??(child.id?db.get().prepare('SELECT user_id FROM task_assignments WHERE task_id=?').all(child.id).map(row=>row.user_id):[]))
    :db.get().prepare(`SELECT p.user_id FROM task_responsibilities p WHERE p.task_id=? AND p.role='participant' AND p.source='subtasks' AND p.status='active'
      AND EXISTS(SELECT 1 FROM tasks c JOIN task_assignments a ON a.task_id=c.id WHERE c.parent_task_id=p.task_id AND c.archived_at IS NULL AND a.user_id=p.user_id)`).all(task.id).map(row=>row.user_id);
  return [...new Set([...ids,...derived])];
}
function scoringMutationWire(body,edited,task=null) {
  const value=Object.fromEntries(['scoring_mode','points','assigned_to'].filter(key=>body[key]!==undefined).map(key=>[key,body[key]]));
  if(value.assigned_to!==undefined)value.assigned_to=draftVisibilityAssignees(task,body,parseAssignedTo(value.assigned_to),edited);
  if(edited)value.subtasks=edited.next.map(row=>({...(row.id?{id:row.id}:{}),title:row.title,points:row.points,...(row.assignedUsers===undefined?{}:{assigned_user_ids:row.assignedUsers})}));
  return value;
}
function attachScoring(task,viewerId,authorizedTaskIds,includeHistoricalSettlements=false) {
  Object.assign(task,assigneePolicyProjection(db.get(),task.id));
  try {
    const allowed=includeHistoricalSettlements?authorizedScoringHistoryIds(task,viewerId,authorizedTaskIds):authorizedTaskIds;
    task.scoring=taskScoringSummary(db.get(),task.id,{viewerId,authorizedTaskIds:allowed});
    task.scoring_mode=task.scoring.mode;
  } catch(error) {if(error.status!==404)throw error;task.scoring=null;}
  return task;
}
export function authorizedScoringHistoryIds(task,viewerId,ids,{publicOnly=false}={}) {
  if(taskScoringRoot(db.get(),task.id)?.id!==task.id)return ids;
  const allowed=new Set(ids);
  for(const settlement of taskReadStatement(db.get(),'SELECT task_id,visibility_json FROM task_scoring_settlements WHERE root_task_id=? OR root_logical_key=?').all(task.id,taskScoringIdentity(db.get(),task.id))) {
    const extant=taskReadRecord(db.get(),settlement.task_id);
    const snapshot=JSON.parse(settlement.visibility_json);
    const historical=extant||{visibility:snapshot.visibility,created_by:snapshot.created_by,assigned_to:snapshot.assigned};
    const actors=Array.isArray(viewerId)?viewerId:[viewerId];
    const publicVisible=!publicOnly||(historical.visibility==='all'&&(!extant||taskWindowAncestors(db.get(),extant.id).every(row=>!row.visibility||row.visibility==='all')));
    if(publicVisible&&actors.every(actor=>taskCapabilities(db.get(),actor,historical).view))allowed.add(settlement.task_id);
  }
  return [...allowed];
}
function futureEditContext(req,task) {
  const allowed=['edit_scope','expected_revision','expected_parent_revision','expected_series_revision','future_patch','include_edit_definition'];
  if(Object.keys(req.body||{}).some(key=>!allowed.includes(key)))throw new TaskStateError('Future edits accept only future_patch. Save progress and occurrence settings separately.',{reason:'future_patch_required'},400);
  if(req.body.include_edit_definition!==undefined&&typeof req.body.include_edit_definition!=='boolean')throw new TaskStateError('include_edit_definition must be a boolean.',{},400);
  const state=taskSeriesState(db.get(),task.id);
  assertSeriesEdit(db.get(),req,task,state,req.body.expected_series_revision);
  const stored=seriesDefinitionForGeneration(db.get(),state.series_id,state.occurrence.generation+1);
  const before=effectiveSeriesScoringDefinition(db.get(),stored).data;
  const futurePermissions=futureRootCapabilities(db.get(),req,task,before);
  if(!futurePermissions.view)throw new TaskStateError('This future definition is unavailable.',{},404);
  if(!futurePermissions.edit)throw new TaskStateError('Your permissions do not allow editing this future definition.',{},403);
  const validateFields=fields=>{
    fields={...fields};
    validateScoringInput(fields);
    const errors=validateTaskInput(fields,false,before.task.recurrence_rule);if(errors.length)throw new TaskStateError(errors.join(' '),{},400);
    if(fields.title!==undefined&&(typeof fields.title!=='string'||!fields.title.trim()))throw new TaskStateError('Give the Task a title.',{},400);
    for(const name of ['assigned_to','assigned_user_ids','rotation_user_ids'])if(fields[name]!==undefined) {
      if(!Array.isArray(fields[name])||fields[name].some(id=>!Number.isSafeInteger(id)||id<1)||new Set(fields[name]).size!==fields[name].length
        ||fields[name].some(id=>!householdMembers(db.get()).some(member=>member.id===id)))throw new TaskStateError('Choose valid household members.',{reason:'invalid_assignment'},400);
    }
    if(fields.skill_ids!==undefined)fields.skill_ids=normalizeSkillIds(db.get(),fields.skill_ids);
    if(fields.rotation_bindings!==undefined)fields.rotation_bindings=normalizeRotationBindings(db.get(),fields.rotation_bindings);
    if(fields.tags!==undefined)fields.tags=normalizeTags(fields.tags);
    for(const name of ['is_optional','is_recurring','recurrence_from_completion','locked','countdown'])if(fields[name]!==undefined){
      if(![true,false,0,1].includes(fields[name]))throw new TaskStateError('Choose a valid enabled or disabled setting.',{},400);
      fields[name]=Number(!!fields[name]);
    }
    if(fields.location!==undefined)throw new TaskStateError('Change future locations through the existing series editor.',{},400);
    if(fields.visibility!==undefined&&!['all','private','assignees'].includes(fields.visibility))throw new TaskStateError('Choose valid visibility.',{},400);
    return fields;
  };
  const definition=proposedFutureSeriesDefinition(db.get(),req,task,before,req.body.future_patch??{}, {validateFields});
  if (before.binding?.snapshot?.fixed_assignee_ids && Object.hasOwn(req.body.future_patch?.fields ?? {}, 'assigned_to')) {
    // Future-only authoring starts from its frozen definition, independently
    // of any assignment exception on the selected occurrence.
    const existing = { ...before.binding, definition_snapshot_json: JSON.stringify(before.binding.snapshot) };
    const request = parseTaskActivityBinding(req.body.future_patch.fields, existing);
    if (request.error) throw new TaskStateError(request.error, {}, 400);
    const desired = request.binding;
    definition.binding.snapshot = overrideTaskActivityAssignees(definition.binding.snapshot, desired.assignmentOverrideUserIds);
    definition.binding.assignment_override_user_id = desired.assignmentOverrideUserId;
    definition.assigned_user_ids = [...desired.assignmentOverrideUserIds];
    definition.authorization = { ...definition.authorization, assigned_user_ids: [...definition.assigned_user_ids] };
  }
  proposeDefinitionAssigneePolicies(db.get(),before,definition,{assignmentIntent:req.body.future_patch,
    resolveRootDirectIds:definition.task.assignment_mode==='round_robin'?()=>seriesRotationAssignment(task,definition,{advance:true}).assigned_user_ids:null});
  if(!futureRootCapabilities(db.get(),req,task,definition).view)throw new TaskStateError('This future definition is unavailable.',{},404);
  assertSeriesDefinitionMutation(db.get(),req,task,before,definition,{futureOnly:true});
  validateFutureDefinitionWindows(req,task,definition);
  validateFutureDefinitionConfiguration(task,before,definition);
  assertFutureSharedGroupOrder(req,task,state,stored,before,definition);
  assertFutureIndependentAssignmentIntent(req,task,state,stored,before,definition);
  return {state,stored,before,definition};
}

function assertFutureSharedGroupOrder(req,task,state,stored,before,definition) {
  const requested=[{fields:req.body.future_patch?.fields,action:null},
    ...(req.body.future_patch?.actions?.update||[]).map(action=>({fields:action.fields,action})),
    ...(req.body.future_patch?.actions?.add||[]).map(action=>({fields:action.fields,action}))]
    .filter(item=>item.fields&&Object.hasOwn(item.fields,'assignment_group'));
  const ordered=requested.filter(item=>{
    const raw=item.fields.assignment_group;
    const config=typeof raw==='string'?JSON.parse(raw):raw;
    if(!Array.isArray(config?.member_order)||!config.member_order.length)return false;
    const previous=item.action?before.subtasks.find(row=>row.action_key===item.action.action_key)?.task:before.task;
    const old=previous?.assignment_group_json?JSON.parse(previous.assignment_group_json):null;
    const same=group=>JSON.stringify(group&&{
      group_id:Number(group.group_id),start_mode:group.start_mode??'first',direction:group.direction??'first_to_last',
      member_order:group.member_order?.map(Number),legacy_exact_next:group.legacy_exact_next??false
    });
    return same(config)!==same(old);
  });
  if(!ordered.length)return;
  const d=db.get(),asOfDate=todayInHouseholdZone();
  const canonicalUnchanged=!!stored&&definitionEqual(stored.data,definition);
  const record=canonicalUnchanged?{...stored,data:definition}:{...stored,id:null,data:definition};
  const occurrence=d.prepare("SELECT * FROM task_recurrence_occurrences WHERE series_id=? AND generation=? AND state='materialized'")
    .get(state.series_id,state.occurrence.generation+1);
  const actual=occurrence&&d.prepare('SELECT * FROM tasks WHERE id=?').get(occurrence.task_id);
  const target=actual&&!seriesOccurrencePreservationReason(d,occurrence,actual)?{occurrence,task:actual}:null;
  let window;
  try{window=prospectiveRootWindow(task,state,record,definition,asOfDate,target,{preserveActual:canonicalUnchanged});}
  catch{throw prospectiveUnavailable('projection_evidence_unavailable');}
  if(!window)throw prospectiveUnavailable(definition.task.is_recurring?'next_occurrence_unavailable':'recurrence_ended');
  for(const item of ordered){
    const action=item.action&&definition.subtasks.find(row=>row.action_key===item.action.action_key
      ||row.action_key===`new:${item.action.client_key}`);
    const fields=action?.task||definition.task;
    const group=JSON.parse(fields.assignment_group_json||'null');
    const relative=definition.task.due_date_offset_days!=null;
    const priorAnchor=relative?definition.task.start_date:definition.task.due_date;
    const nextAnchor=relative?window.start_date:window.due_date;
    const date=action&&fields.due_date&&priorAnchor&&nextAnchor
      ?translatedSeriesDate(fields.due_date,priorAnchor,nextAnchor)
      :action?fields.due_date||asOfDate:window.due_date||asOfDate;
    if(group&&sharedGroupOnDate(d,group.group_id,date))
      throw new TaskStateError('This shared Group uses its Group-owned order.',{},400);
  }
}

/** Explicit independent selections must qualify before generation filters them.
 * Default/canonical no-ops and derived child participation keep their policy. */
function assertFutureIndependentAssignmentIntent(req,task,state,stored,before,definition) {
  const sharedBinding = before.binding?.snapshot?.fixed_assignee_ids && definition.binding?.snapshot?.fixed_assignee_ids;
  if(!Object.hasOwn(req.body.future_patch?.fields??{},'assigned_to')||definition.binding&&!sharedBinding
    ||(definition.task.assignment_mode??'fixed')!=='fixed'
    ||sameIdOrder(before.assignee_policy?.direct_assignee_ids??before.assigned_user_ids,definition.assignee_policy?.direct_assignee_ids??definition.assigned_user_ids))return;
  const d=db.get(),skills=definition.skill_ids,assigned=definition.assignee_policy?.direct_assignee_ids??definition.assigned_user_ids;
  // The central empty-list/no-requirement rule needs no future date proof.
  if(!sharedBinding&&(!skills.length||!assigned.length))return assertTaskSkillAssignments(d,skills,assigned);
  const asOfDate=todayInHouseholdZone(),canonicalUnchanged=!!stored&&definitionEqual(stored.data,definition);
  const record=canonicalUnchanged?{...stored,data:definition}:{...stored,id:null,data:definition};
  let window;
  try {
    const occurrence=d.prepare("SELECT * FROM task_recurrence_occurrences WHERE series_id=? AND generation=? AND state='materialized'")
      .get(state.series_id,state.occurrence.generation+1);
    const actual=occurrence&&d.prepare('SELECT * FROM tasks WHERE id=?').get(occurrence.task_id);
    // A preserved target is not rewritten; validate only the configured next
    // nominal window. The forecast retains its existing preservation guard.
    const target=actual&&!seriesOccurrencePreservationReason(d,occurrence,actual)?{occurrence,task:actual}:null;
    window=prospectiveRootWindow(task,state,record,definition,asOfDate,target,{preserveActual:canonicalUnchanged});
  }catch(error){throw prospectiveUnavailable('projection_evidence_unavailable');}
  if(!window)throw prospectiveUnavailable(definition.task.is_recurring?'next_occurrence_unavailable':'recurrence_ended');
  if (sharedBinding) {
    previewTaskActivityBinding(d, { activityTemplateId: definition.binding.activity_template_id,
      subjectUserId: definition.binding.subject_user_id, assignmentOverrideUserId: definition.binding.assignment_override_user_id,
      activitySnapshot: definition.binding.snapshot, task: { ...definition.task, ...window },
      assigneePolicy: definition.binding.snapshot.assignee_policy, allowInactive: true,
      dateKey: window.due_date || window.start_date || asOfDate });
  } else assertTaskSkillAssignments(d,skills,assigned,window.due_date||window.start_date||asOfDate,{allowDelegation:false});
}
function futureScoringWires(req,task,before,after) {
  const visible=definition=>definition.subtasks.filter(action=>futureActionCapabilities(db.get(),req,task,action).view);
  const old=visible(before),next=visible(after),keys=[...new Set([...before.subtasks,...after.subtasks].map(a=>a.action_key))].sort();
  const maximum=Math.max(...taskScoringRows(db.get(),taskScoringRoot(db.get(),task.id)).map(row=>row.id));
  const ids=new Map(keys.map((key,i)=>[key,maximum+i+1]));
  const wire=(definition,actions)=>({scoring_mode:definition.task.scoring_mode,points:definition.task.points,
    assigned_to:definition.assigned_user_ids,subtasks:actions.map(action=>({id:ids.get(action.action_key),title:action.task.title,points:action.task.points,assigned_user_ids:action.assigned_user_ids}))});
  return {before:wire(before,old),after:wire(after,next),ids,old,next};
}
function futureReviewRequired(definition) {
  return definition.task.scoring_mode==='legacy'&&!!definition.task.scoring_review_required
    &&[definition.task,...definition.subtasks.map(a=>a.task)].some(row=>row.points>0);
}
function scoringAssignmentIntent(task,body) {
  const d=db.get(),assigned=d.prepare('SELECT user_id FROM task_assignments WHERE task_id=?').all(task.id).map(row=>row.user_id);
  const existing=getTaskActivityBinding(d,task.id),binding=parseTaskActivityBinding(body,existing);
  if(binding.error)throw new TaskStateError(binding.error,{},400);
  const bindingChanged=!sameTaskActivityBinding(binding.binding,existing);
  if(binding.binding){
    if(!bindingChanged)return {assigned,changed:false,binding:binding.binding,bindingChanged:false};
    const desired=binding.binding,activity=existing?.activity_template_id===desired.activityTemplateId
      ?scoringActivitySnapshot(task,body,desired,existing)
      :overrideTaskActivityAssignees({...captureActivityTemplateDefinition(d,desired.activityTemplateId),
        required_skill_ids:taskSkillInput(body,task.id,desired.activityTemplateId)},desired.assignmentOverrideUserIds);
    // Save may select a random person. A read-only preview cannot promise who
    // that later draw will choose, and must never consume the assignment cursor.
    if(!desired.assignmentOverrideUserId&&['eligible_random','random'].includes(activity.assignment_policy||activity.assignment_strategy))
      throw new TaskStateError('The proposed assignment is random. A recipient cannot be forecast before saving.',{reason:'scoring_projection_unavailable',conditions:['random_assignment_unresolved']});
    const planned={...task,...Object.fromEntries(['category','start_date','start_time','due_date','due_time'].filter(key=>body[key]!==undefined).map(key=>[key,body[key]]))};
    const resolved=previewTaskActivityBinding(d,{...desired,activitySnapshot:activity,assigneePolicy:categoryAssigneePolicy(d,planned.category),task:planned,dateKey:planned.due_date||todayInHouseholdZone()}).resolution;
    const participants=(resolved.participants?.length?resolved.participants:resolved.primary?[resolved.primary]:[]).map(member=>member.id);
    const childOwners=d.prepare("SELECT user_id FROM task_responsibilities WHERE task_id=? AND role='participant' AND source='subtasks' AND status='active' ORDER BY user_id").all(task.id).map(row=>row.user_id);
    const next=[...new Set([...participants,...childOwners])],primary=resolved.primary?.id??null;
    return {assigned:next,primary,changed:!sameIdOrder(next,assigned)||primary!==task.assigned_to,binding:desired,bindingChanged:true,activity,policyAssigned:participants};
  }
  const mode=body.assignment_mode??task.assignment_mode??'fixed';
  let next=body.assigned_to===undefined?assigned:parseAssignedTo(body.assigned_to);
  if(mode==='round_robin') {
    const rotation=body.rotation_user_ids===undefined?loadRotationUserIds(db.get(),task.id):parseRotationUserIds(body.rotation_user_ids);
    const group=normalizeRotationGroup(body.rotation_group??task.rotation_group);
    const slot=group?body.rotation_slot===undefined?Number(task.rotation_slot||0):parseRotationSlot(body.rotation_slot):0;
    const position=rotation.indexOf(Number(task.assigned_to));
    const index=group?currentRotationGroupState(db.get(),group,task.rotation_group?task.id:null).rotationIndex
      :task.assignment_mode==='round_robin'&&position>=0?position:0;
    next=[rotation[(index+slot)%rotation.length]];
  }
  const primary=body.assigned_to===undefined&&mode==='fixed'?task.assigned_to:next[0]??null;
  const direct=taskDirectAssignmentSelection(d,task,body),directChanged=!sameIdOrder(direct.previous,direct.selected);
  if(mode==='fixed'&&directChanged)assertTaskSkillAssignments(d,taskSkillInput(body,task.id),direct.selected,body.due_date??task.due_date??todayInHouseholdZone(),{allowDelegation:!!task.parent_task_id});
  return {assigned:next,primary,changed:directChanged||!sameIdOrder(next,assigned)||primary!==task.assigned_to,binding:null,bindingChanged};
}

function scoringActivitySnapshot(task,body,binding,existing=getTaskActivityBinding(db.get(),task.id)) {
  const snapshot=existing?.definition_snapshot_json?readTaskActivityDefinition(db.get(),task.id):captureActivityTemplateDefinition(db.get(),binding.activityTemplateId);
  return overrideTaskActivityAssignees({...snapshot,required_skill_ids:taskSkillInput(body,task.id,binding.activityTemplateId)},binding.assignmentOverrideUserIds);
}

/** Save reconciles the whole helper scope after authored execution changes.
 * Compare effective inputs so ordinary labels, amounts and editor echoes do
 * not force unrelated legacy/nested scopes through prospective preparation. */
function currentScoringExecutionChanged(task,body,edited,assignment) {
  if(assignment.changed||assignment.bindingChanged)return true;
  const sameSkills=(left,right)=>sameIdOrder([...left].sort((a,b)=>a-b),[...right].sort((a,b)=>a-b));
  if(body.skill_ids!==undefined){
    const before=taskSkillInput({},task.id,assignment.binding?.activityTemplateId);
    const after=taskSkillInput(body,task.id,assignment.binding?.activityTemplateId);
    if(!sameSkills(before,after))return true;
  }
  if(['start_date','start_time','due_date','due_time'].some(key=>body[key]!==undefined&&(body[key]??null)!==(task[key]??null))
    ||body.is_optional!==undefined&&!!body.is_optional!==!!task.is_optional)return true;
  if(!edited)return false;
  if(edited.remove.length)return true;
  return edited.next.some(child=>{
    if(!child.id)return true;
    const old=db.get().prepare('SELECT is_optional FROM tasks WHERE id=?').get(child.id);
    return !!child.isOptional!==!!old.is_optional||!sameSkills(child.skillIds,loadTaskSkillIds(db.get(),child.id))
      ||child.assignedUsers!==undefined&&!sameIdOrder(child.assignedUsers,
        db.get().prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(child.id).map(row=>row.user_id));
  });
}

/** Re-assess the proposed occurrence's full helper scope before projecting its
 * authorized reward units. Existing completions/history stay outside this plan. */
function prepareCurrentScoringExecution(task,body,edited,assignment,ctx) {
  const d=db.get(),root=ctx.root;
  if(root.id!==task.id||ctx.rows.some(row=>row.id!==root.id&&row.parent_task_id!==root.id))
    throw new TaskStateError('Review this assignment on its original executable Task.',{reason:'scoring_projection_unavailable'});
  const assigned=row=>{
    if(row._assigned!==undefined)return row._assigned;
    const joins=d.prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(row.id).map(item=>item.user_id);
    return joins.length?joins:row.assigned_to?[row.assigned_to]:[];
  };
  const ref=row=>row.id===root.id?{kind:'definition_root'}:row.id>0?{kind:'template',template_id:row.id}:{kind:'draft',draft_index:row._draft_index};
  const fields={...root,...Object.fromEntries(['start_date','start_time','due_date','due_time'].filter(key=>body[key]!==undefined).map(key=>[key,body[key]]))};
  const desired=assignment.binding,activity=desired?(assignment.activity??scoringActivitySnapshot(task,body,desired)):null;
  // Attaching a template to an empty manual Task also creates its checklist.
  // Its generated identities do not exist yet; do not show an incomplete plan.
  if(desired&&!getTaskActivityBinding(d,task.id)&&ctx.rows.length===1&&activity.checklist?.length)
    throw new TaskStateError('Save the Activity Template before reviewing its new checklist rewards.',{reason:'scoring_projection_unavailable'});
  const binding=desired?{activity_template_id:desired.activityTemplateId,subject_user_id:desired.subjectUserId,
    assignment_override_user_id:desired.assignmentOverrideUserId,snapshot:activity}:null;
  const primary=assignment.primary===undefined?root.assigned_to:assignment.primary;
  const rootPlanning=d.prepare('SELECT * FROM task_planning_context WHERE task_id=?').get(root.id)||{};
  const planning=assignment.bindingChanged&&!binding&&rootPlanning.source==='activity_template'?{}:rootPlanning;
  const children=new Map((edited?.next||[]).map((child,index)=>[child.id??`draft:${index}`,child]));
  const optionalFor=createTaskOptionalContextReader(d,ctx.rows.map(row=>{
    const child=children.get(row.id>0?row.id:`draft:${row._draft_index}`);
    return {...row,is_optional:child?child.isOptional:row.id===root.id&&body.is_optional!==undefined?Number(!!body.is_optional):row.is_optional};
  }));
  const rootRole=d.prepare('SELECT 1 FROM workflow_instances WHERE parent_task_id=?').get(root.id)?'container':'source_root';
  const window=row=>Object.fromEntries(['start_date','start_time','due_date','due_time'].map(key=>[key,row.id===root.id?fields[key]:row[key]===task[key]?fields[key]:row[key]]));
  const node=row=>{
    const child=children.get(row.id>0?row.id:`draft:${row._draft_index}`),isRoot=row.id===root.id,own=assigned(row);
    const pc=!isRoot&&row.id>0?d.prepare('SELECT * FROM task_planning_context WHERE task_id=?').get(row.id):null;
    const boundParticipants=isRoot&&assignment.bindingChanged&&binding
      ?[...new Set([...assignment.policyAssigned,...ctx.rows.filter(child=>child.id!==root.id&&!child.archived_at).flatMap(assigned)])]:own;
    return {ref:ref(row),role:isRoot?rootRole:'source_action',task:executionTask(isRoot?fields:row),
      primary_user_id:isRoot?primary??null:child?.assignedUsers!==undefined?child.assignedUsers[0]??null:row.assigned_to??null,
      assigned_user_ids:boundParticipants,skill_ids:isRoot?taskSkillInput(body,task.id,desired?.activityTemplateId):child?.skillIds??(row.id>0?loadTaskSkillIds(d,row.id):[]),
      window:window(row),is_optional:optionalFor(row.id).is_optional,completed:!!row.archived_at||['done','expired','skipped','closed_incomplete'].includes(row.status),
      ...(isRoot?{binding,planning}:pc?{planning:pc}:{})};
  };
  const refs=new Map(ctx.rows.filter(row=>row.id>0).map(row=>[row.id,ref(row)]));
  const selection={
    preferred_supervisor_user_ids:assignment.bindingChanged?[]:d.prepare("SELECT user_id FROM task_responsibilities WHERE task_id=? AND role='supervisor' AND status='active'").all(root.id).map(row=>row.user_id),
    attempted_supervisor_user_ids:[...new Set(d.prepare("SELECT responsible_user_id FROM planning_obligations WHERE task_id=? AND role='supervisor' AND status IN ('declined','timed_out')").all(root.id).map(row=>row.responsible_user_id))],
    prior_units:d.prepare('SELECT action_task_id,learner_user_id,supervisor_user_id FROM task_supervision_actions WHERE source_task_id=?').all(root.id)
      .filter(prior=>refs.has(prior.action_task_id)).map(prior=>({ref:refs.get(prior.action_task_id),learner_user_id:prior.learner_user_id,supervisor_user_id:prior.supervisor_user_id}))};
  return prepareProspectiveTaskExecution(d,{context:{kind:'current_occurrence',generation:null,as_of_date:todayInHouseholdZone(),assumed_completion_date:null,preparation:'existing_untouched',conditions:[]},
    root:node(root),actions:ctx.rows.filter(row=>row.id!==root.id).map(node),selection});
}
function assertScoringProgressIntent(task,body,edited,{performersChanged=null}={}) {
  if(performersChanged===null){const assignment=scoringAssignmentIntent(task,body);performersChanged=assignment.changed||assignment.bindingChanged;}
  const status=body.status===undefined||body.status===ARCHIVE_STATUS?task.status:body.status;
  const children=edited?ordinaryActivitySubtasks(db.get(),task.id).filter(row=>!row.archived_at):[];
  const changed=body.scoring_mode!==undefined&&body.scoring_mode!==task.scoring_mode
    ||body.points!==undefined&&Number(body.points)!==task.points
    ||performersChanged
    ||edited&&(edited.remove.length||edited.next.some(child=>{
      const old=children.find(row=>row.id===child.id);
      return !old||child.points!==Number(old.points||0)||child.assignedUsers!==undefined&&!sameIdOrder(child.assignedUsers,
        db.get().prepare('SELECT user_id FROM task_assignments WHERE task_id=?').all(child.id).map(row=>row.user_id));
    }));
  if(changed&&status!==task.status)throw new TaskStateError('Save scoring settings first, then change progress separately.',{reason:'scoring_progress_separate'});
}
function finalizeFutureActionKeys(definition) {
  if(new Set(definition.subtasks.map(action=>action.action_key)).size!==definition.subtasks.length)
    throw new TaskStateError('Choose unique future work keys.',{},400);
  const created=[];
  for(const action of definition.subtasks)if(action.action_key.startsWith('new:')) {
    const client_key=action.action_key.slice(4);action.action_key=`series-action:${randomUUID()}`;
    created.push({client_key,action_key:action.action_key});
  }
  return created;
}
function assertCompatibleFutureDefinition(req,task,series,definition,{capturedDirectIds=null,deferRandomBinding=false}={}) {
  const before=effectiveSeriesScoringDefinition(db.get(),seriesDefinitionForGeneration(db.get(),series.series_id,series.occurrence.generation+1)).data;
  const assignmentIntent=!definition.binding&&(definition.task.assignment_mode??'fixed')==='fixed'&&Object.hasOwn(req.body,'direct_assignee_ids')
    ?{fields:{assigned_to:parseAssignedTo(req.body.direct_assignee_ids)}}:null;
  proposeDefinitionAssigneePolicies(db.get(),before,definition,{assignmentIntent,resolveRootDirectIds:()=>{
    if(capturedDirectIds!==null)return capturedDirectIds;
    // Historical future authoring does not select a random performer for the
    // settled occurrence. Materialization captures the actual future person.
    const binding=definition.binding,activity=binding?.snapshot;
    if(deferRandomBinding&&binding&&!binding.assignment_override_user_id&&['eligible_random','random'].includes(activity.assignment_policy||activity.assignment_strategy))return [];
    const resolved=scoringAssignmentIntent(task,req.body);return resolved.policyAssigned??resolved.assigned;
  }});
  assertSeriesDefinitionMutation(db.get(),req,task,before,definition,{futureOnly:true});
  if(!futureRootCapabilities(db.get(),req,task,definition).view)throw new TaskStateError('This future definition is unavailable.',{},404);
  validateFutureDefinitionWindows(req,task,definition);
  validateFutureDefinitionConfiguration(task,before,definition);
  if(futureReviewRequired(definition))throw new TaskStateError('Choose a scoring mode for future work before saving.',{reason:'scoring_review_required'});
  return before;
}
/** Pure full-body compatibility proposal; the historical save and preview share
 * this intent rather than forecasting settled selected work. */
function compatibleFutureDefinition(req,task,series,before,edited,{normalizeSchedule=true}={}) {
  const body=req.body,fields={...before.task};
  const colorBase=seriesDefinitionForGeneration(db.get(),series.series_id,series.occurrence.generation+1)?.data||series.definition.data;
  fields.card_color_policy=body.card_color_choice!==undefined?validateCardColorChoice(body.card_color_choice):normalizeCardColorChoice(colorBase.task.card_color_policy);
  for(const key of ['title','description','category','priority','start_date','start_time','due_date','due_time','is_recurring','recurrence_rule',
    'recurrence_from_completion','points','scoring_mode','visibility','countdown','locked','expiration_policy','is_optional'])if(body[key]!==undefined)fields[key]=body[key];
  if(typeof fields.title!=='string'||!fields.title.trim())throw new TaskStateError('Give the Task a title.',{},400);
  fields.title=fields.title.trim();fields.points=Number(fields.points);
  for(const key of ['is_recurring','recurrence_from_completion','is_optional','countdown','locked'])fields[key]=Number(!!fields[key]);
  fields.scoring_review_required=body.scoring_mode===undefined?task.scoring_review_required:0;
  fields.visibility=body.visibility===undefined?task.visibility:normalizeVisibility(body.visibility,task.visibility);
  fields.due_date_offset_days=task.due_date_offset_days==null&&calendarDayOffset(fields.start_date,fields.due_date)===calendarDayOffset(task.start_date,task.due_date)
    ?null:calendarDayOffset(fields.start_date,fields.due_date);
  fields.rotation_bindings_json=body.rotation_bindings===undefined?task.rotation_bindings_json:JSON.stringify(normalizeRotationBindings(db.get(),body.rotation_bindings));
  const existing=getTaskActivityBinding(db.get(),task.id),request=parseTaskActivityBinding(body,existing);
  if(request.error)throw new TaskStateError(request.error,{},400);
  const desired=request.binding,skills=taskSkillInput(body,task.id,desired?.activityTemplateId);
  let binding=null;
  if(desired)binding={activity_template_id:desired.activityTemplateId,subject_user_id:desired.subjectUserId,
    assignment_override_user_id:desired.assignmentOverrideUserId,snapshot:overrideTaskActivityAssignees(before.binding?.activity_template_id===desired.activityTemplateId
      ?structuredClone(before.binding.snapshot):captureActivityTemplateDefinition(db.get(),desired.activityTemplateId),desired.assignmentOverrideUserIds)};
  if(binding)binding.snapshot.required_skill_ids=[...skills];
  if(desired&&!sameTaskActivityBinding(desired,existing)) {
    if(task.rotation_group)throw new TaskStateError('Remove this task from its rotation group before attaching an Activity Template.',{},409);
    const error=validateTaskActivityBindingRequest(desired,fields.due_date||todayInHouseholdZone(),{
      task:fields,activitySnapshot:existing?.activity_template_id===desired.activityTemplateId?{...readTaskActivityDefinition(db.get(),task.id),required_skill_ids:skills}:null});
    if(error)throw new TaskStateError(error,{},400);
  }
  fields.assignment_mode=desired?'fixed':body.assignment_mode??task.assignment_mode??'fixed';
  const rotation=desired?[]:body.rotation_user_ids===undefined?before.rotation_user_ids:parseRotationUserIds(body.rotation_user_ids);
  fields.rotation_group=fields.assignment_mode==='round_robin'?normalizeRotationGroup(body.rotation_group??task.rotation_group):null;
  fields.rotation_slot=fields.rotation_group?body.rotation_slot===undefined?Number(task.rotation_slot||0):parseRotationSlot(body.rotation_slot):0;
  const error=roundRobinConfigError(db.get(),{assignmentMode:fields.assignment_mode,isRecurring:!!fields.is_recurring,
    recurrenceRule:fields.recurrence_rule,parentTaskId:task.parent_task_id,rotationUserIds:rotation});
  if(error)throw new TaskStateError(error,{},400);
  if(task.rotation_group&&fields.rotation_group&&task.rotation_group.localeCompare(fields.rotation_group,undefined,{sensitivity:'accent'})!==0)
    throw new TaskStateError('Move a grouped task by removing it from the group first.',{},400);
  const group=currentRotationGroupState(db.get(),fields.rotation_group,task.rotation_group?task.id:null);
  const groupError=rotationGroupConfigError(db.get(),{taskId:task.rotation_group?task.id:null,
    joining:!!fields.rotation_group&&!task.rotation_group,assignmentMode:fields.assignment_mode,
    rotationGroup:fields.rotation_group,rotationSlot:fields.rotation_slot,rotationUserIds:rotation,
    recurrenceRule:fields.recurrence_rule,recurrenceFromCompletion:fields.recurrence_from_completion,
    dueDate:fields.due_date,dueTime:fields.due_time,startDate:fields.start_date,dueDateOffset:fields.due_date_offset_days});
  if(groupError)throw new TaskStateError(groupError,{},400);
  if(task.rotation_group&&Number(task.rotation_slot||0)!==fields.rotation_slot&&group.peers.some(peer=>peer.status!=='open'))
    throw new TaskStateError('Cannot change a rotation-group position after its current cycle has started.',{},409);
  const previous=db.get().prepare('SELECT user_id FROM task_assignments WHERE task_id=?').all(task.id).map(row=>row.user_id);
  let assigned=desired?desired.assignmentOverrideUserIds??previous:body.assigned_to===undefined?previous:parseAssignedTo(body.assigned_to);
  if(fields.assignment_mode==='round_robin') {
    const position=rotation.indexOf(Number(task.assigned_to));
    const index=fields.rotation_group?group.rotationIndex:task.assignment_mode==='round_robin'&&position>=0?position:0;
    assigned=[rotation[(index+fields.rotation_slot)%rotation.length]];
  }
  const primary=desired?.assignmentOverrideUserIds?.[0]??(body.assigned_to===undefined&&fields.assignment_mode==='fixed'?task.assigned_to:assigned[0]);
  assigned=primary?[primary,...assigned.filter(id=>id!==primary)]:assigned;
  const location=body.location===undefined?undefined:normalizeTaskLocation(db.get(),body.location);
  const proposed=proposedSeriesDefinition(before,{fields,editedSubtasks:edited,assigned,rotation,skills,
    tags:body.tags===undefined?undefined:normalizeTags(body.tags),binding,
    location:location===undefined?undefined:location?{kind:location.kind,place_id:location.placeId??null,
      external_provider:location.provider??null,external_place_id:location.externalPlaceId??null,user_label:location.userLabel??null,
      manual_address:location.manualAddress??null,latitude:location.latitude??null,longitude:location.longitude??null}:null,
    authorId:req.authUserId||req.session.userId,assignmentExplicit:body.assigned_to!==undefined&&!desired});
  preserveFutureCardColorPolicies(proposed,colorBase,body.card_color_choice);
  return normalizeSchedule?normalizeSeriesSchedule(proposed,series.occurrence):proposed;
}
function compatiblePreviewNoop(task,body,series,current,proposed) {
  const status=body.status===undefined||body.status===ARCHIVE_STATUS?task.status:body.status;
  return status===task.status&&!(body.status===ARCHIVE_STATUS&&!task.archived_at)
    &&body.sync_target===undefined
    &&['start_date','due_date'].every(key=>sameFieldValue(current.task[key],proposed.task[key]))
    &&definitionEqual(current,proposed)&&definitionEqual(series.definition.data,current);
}
function validateFutureDefinitionWindows(req,task,definition) {
  for(const [index,row] of [definition.task,...definition.subtasks.map(action=>action.task)].entries()) {
    const error=validateTaskWindow(row);
    if(error)throw new TaskStateError(index&& !futureActionCapabilities(db.get(),req,task,definition.subtasks[index-1]).view
      ? 'The future definition has an invalid schedule. Review it with its creator.' : error,{},400);
  }
}
function validateFutureDefinitionConfiguration(task,before,definition) {
  const fields=definition.task,roster=definition.rotation_user_ids,mode=fields.assignment_mode??'fixed';
  if(definition.binding&&mode==='round_robin')throw new TaskStateError('The Activity Template owns this Task assignment. Keep its fixed Task assignment mode.',{},400);
  const error=roundRobinConfigError(db.get(),{assignmentMode:mode,isRecurring:!!fields.is_recurring,
    recurrenceRule:fields.recurrence_rule,parentTaskId:task.parent_task_id,rotationUserIds:roster});
  if(error)throw new TaskStateError(error,{},400);
  const group=mode==='round_robin'?normalizeRotationGroup(fields.rotation_group):null;
  const slot=group?parseRotationSlot(fields.rotation_slot):0;
  const priorGroup=normalizeRotationGroup(before.task.rotation_group);
  if(priorGroup&&group&&priorGroup.localeCompare(group,undefined,{sensitivity:'accent'})!==0)
    throw new TaskStateError('Move a grouped task by removing it from the group first.',{},400);
  const groupError=rotationGroupConfigError(db.get(),{taskId:task.id,joining:!!group&&!priorGroup,
    assignmentMode:mode,rotationGroup:group,rotationSlot:slot,rotationUserIds:roster,
    recurrenceRule:fields.recurrence_rule,recurrenceFromCompletion:fields.recurrence_from_completion,
    dueDate:fields.due_date,dueTime:fields.due_time,startDate:fields.start_date,dueDateOffset:fields.due_date_offset_days,
    futureDefinitions:true});
  if(groupError)throw new TaskStateError(groupError,{},400);
  if(priorGroup&&Number(before.task.rotation_slot||0)!==slot
    &&futureRotationGroupState(db.get(),group,task.id).progressPeers.some(peer=>peer.status!=='open'))
    throw new TaskStateError('Cannot change a rotation-group position after its current cycle has started.',{},409);
}
function previewFutureDefinitions(req,task,before,definition,{viewerId,authorizedTaskIds,scope='future_only'}) {
  const wires=futureScoringWires(req,task,before,definition),proposal={...wires.after};
  if(proposal.scoring_mode==='legacy')delete proposal.scoring_mode;
  const prepared=prepareFutureScoringExecution(task,before,definition,wires);
  const preview=previewTaskScoring(db.get(),task.id,proposal,{scope:'future_only',viewerId,beforeDefinition:wires.before,
    authorizedTaskIds,authorizedTemplateIds:[...wires.ids.values()],includeUnits:true,
    beforeExecutionContext:prepared.before,afterExecutionContext:prepared.after});
  const metadata=(value,actions)=>new Map([['root',value.task],...actions.map(action=>[action.action_key,action.task])]);
  decorateScoringUnits(preview,metadata(before,wires.old),metadata(definition,wires.next),{futureIds:new Map([...wires.ids].map(([key,id])=>[id,key]))});
  preview.scope=scope;preview.review_required=!!definition.task.scoring_review_required;preview.forecast_context=prepared.forecast_context;
  if(futureReviewRequired(definition)){preview.valid=false;preview.warnings.push({reason:'scoring_review_required',message:'Choose a scoring mode for future work.'});}
  return preview;
}

function qualifySeriesAssignments(ids,skills,date,allowDelegation=false) {
  return ids.filter(userId=>{
    try {assertTaskSkillAssignments(db.get(),skills,[userId],date,{allowDelegation});return true;}
    catch(error){if(error instanceof TaskSkillError)return false;throw error;}
  });
}
function prospectiveUnavailable(condition='next_occurrence_unavailable') {
  return new TaskStateError('The next occurrence cannot be forecast yet. Review its schedule or assignment before trying again.',
    {reason:'scoring_projection_unavailable',conditions:[condition]});
}
function executionTask(fields) {
  const {id,parent_task_id,...task}=fields;
  return {...task,status:'open',archived_at:null};
}
/** Pure root-window branches shared by forecasts and explicit intent checks. */
function prospectiveRootWindow(task,state,record,definition,asOfDate,target,{preserveActual=false}={}) {
  if(target){
    if(preserveActual)return {start_date:target.task.start_date,due_date:target.task.due_date};
    if(definition.task.recurrence_from_completion)
      return {start_date:target.occurrence.planned_start_date,due_date:target.occurrence.planned_due_date};
    return planSeriesOccurrence(db.get(),record,state.occurrence);
  }
  return planSeriesOccurrence(db.get(),record,state.occurrence,{completedOn:asOfDate,skipped:task.status==='skipped',withoutCompletion:['expired','skipped','closed_incomplete'].includes(task.status)});
}
function phaseExecutionInput(task,state,record,definition,ids,asOfDate,target,{beforePhase=false,canonicalUnchanged=false}={}) {
  const d=db.get(),context={kind:'next_occurrence',generation:state.occurrence.generation+1,as_of_date:asOfDate,
    assumed_completion_date:null,preparation:target?'existing_untouched':'fresh',conditions:[]};
  let prepared,skillAssignees,selection={preferred_supervisor_user_ids:[],attempted_supervisor_user_ids:[]};
  if(target) {
    const targetTask=target.task,baseline=captureSeriesDefinition(d,targetTask.id,{registerActions:false});
    const preserveActual=beforePhase||canonicalUnchanged;
    const window=prospectiveRootWindow(task,state,record,definition,asOfDate,target,{preserveActual});
    if(!window)throw prospectiveUnavailable('recurrence_ended');
    const actual=new Map(d.prepare(`SELECT t.*,a.action_key FROM tasks t JOIN task_recurrence_actions a ON a.task_id=t.id
      WHERE a.occurrence_task_id=?`).all(targetTask.id).map(row=>[row.action_key,row]));
    const joins=id=>d.prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(id).map(row=>row.user_id);
    const assignment=seriesRotationAssignment(targetTask,definition);
    if(!beforePhase&&definition.binding&&!sameSeriesBindingPolicy(baseline.binding,definition.binding))
      throw prospectiveUnavailable('binding_policy_changed');
    const sameAssignment=canonicalUnchanged||definition.binding;
    let rootAssigned=beforePhase||sameAssignment?joins(targetTask.id):assignment.assigned_user_ids;
    let primary=beforePhase||sameAssignment?targetTask.assigned_to:assignment.primary_user_id;
    if(!beforePhase&&definition.binding&&!sameSeriesBindingPolicy(baseline.binding,definition.binding,{includeRequirements:true})) {
      const binding=definition.binding,activity=binding.snapshot;
      if(!binding.assignment_override_user_id&&['eligible_random','random'].includes(activity.assignment_policy||activity.assignment_strategy))
        throw prospectiveUnavailable('random_assignment_unresolved');
      const resolved=previewTaskActivityBinding(d,{activityTemplateId:binding.activity_template_id,subjectUserId:binding.subject_user_id,
        assignmentOverrideUserId:binding.assignment_override_user_id,activitySnapshot:activity,allowInactive:true,
        task:{...window,start_time:definition.task.start_time,due_time:definition.task.due_time},dateKey:window.due_date||asOfDate}).resolution;
      primary=resolved.primary?.id??null;
      rootAssigned=(resolved.participants?.length?resolved.participants:resolved.primary?[resolved.primary]:[]).map(member=>member.id);
      context.conditions.push('binding_assignment_reprepared');
    }
    const oldAnchor=definition.task.due_date_offset_days!=null?definition.task.start_date:definition.task.due_date;
    const newAnchor=definition.task.due_date_offset_days!=null?window.start_date:window.due_date;
    const shift=date=>!date||!oldAnchor||!newAnchor?date??null
      :new Date(Date.parse(`${date}T00:00:00Z`)+Date.parse(`${newAnchor}T00:00:00Z`)-Date.parse(`${oldAnchor}T00:00:00Z`)).toISOString().slice(0,10);
    prepared={primary_user_id:primary??null,assigned_user_ids:rootAssigned,
      window:{...window,start_time:preserveActual?targetTask.start_time:definition.task.start_time,due_time:preserveActual?targetTask.due_time:definition.task.due_time},
      actions:definition.subtasks.map(action=>{
        const row=actual.get(action.action_key);
        return {action_key:action.action_key,primary_user_id:preserveActual&&row?row.assigned_to??null:action.assigned_user_ids[0]??null,
          assigned_user_ids:preserveActual&&row?joins(row.id):[...action.assigned_user_ids],
          window:preserveActual&&row?{start_date:row.start_date,start_time:row.start_time,due_date:row.due_date,due_time:row.due_time}
            :{start_date:shift(action.task.start_date),start_time:action.task.start_time,due_date:shift(action.task.due_date),due_time:action.task.due_time}};
      })};
    selection={
      preferred_supervisor_user_ids:d.prepare("SELECT user_id FROM task_responsibilities WHERE task_id=? AND role='supervisor' AND status='active'").all(targetTask.id).map(row=>row.user_id),
      attempted_supervisor_user_ids:[...new Set(d.prepare("SELECT responsible_user_id FROM planning_obligations WHERE task_id=? AND role='supervisor' AND status IN ('declined','timed_out')").all(targetTask.id).map(row=>row.responsible_user_id))],
      prior_units:[]
    };
    for(const prior of d.prepare('SELECT action_task_id,learner_user_id,supervisor_user_id FROM task_supervision_actions WHERE source_task_id=?').all(targetTask.id)) {
      const key=prior.action_task_id===targetTask.id?'root':[...actual.values()].find(row=>row.id===prior.action_task_id)?.action_key;
      if(!key)throw prospectiveUnavailable();
      if(key!=='root'&&!definition.subtasks.some(action=>action.action_key===key))continue;
      selection.prior_units.push({ref:key==='root'?{kind:'definition_root'}:{kind:'template',template_id:ids.get(key)},
        learner_user_id:prior.learner_user_id,supervisor_user_id:prior.supervisor_user_id});
    }
  } else {
    const completionRelative=!!definition.task.recurrence_from_completion&&!['expired','skipped','closed_incomplete'].includes(task.status);
    context.assumed_completion_date=completionRelative?asOfDate:null;
    if(completionRelative)context.conditions.push('completion_date_assumed');
    const window=prospectiveRootWindow(task,state,record,definition,asOfDate,target);
    if(!window)throw prospectiveUnavailable(definition.task.is_recurring?'next_occurrence_unavailable':'recurrence_ended');
    prepared=prepareSeriesOccurrenceWork(task,definition,window,{qualify:qualifySeriesAssignments,asOfDate,
      resolveGroupAssignment:({sourceTaskId,configuration,skills,window:groupWindow,previousUserId,actionKey})=>
        actionKey==='root'&&definition.binding?null:selectTaskGroupMember(sourceTaskId||task.id,configuration,skills,
          {consumerKey:`series:${state.series_id}:${actionKey}`,commit:false,previousUserId,window:groupWindow,allowDelegation:actionKey!=='root'})});
    if(definition.binding) {
      const binding=definition.binding,activity=binding.snapshot;
      if(!binding.assignment_override_user_id&&['eligible_random','random'].includes(activity.assignment_policy||activity.assignment_strategy))
        throw prospectiveUnavailable('random_assignment_unresolved');
      const resolved=previewTaskActivityBinding(d,{activityTemplateId:binding.activity_template_id,subjectUserId:binding.subject_user_id,
        assignmentOverrideUserId:binding.assignment_override_user_id,activitySnapshot:activity,
        allowInactive:true,task:prepared.window,dateKey:window.due_date||asOfDate}).resolution;
      prepared.primary_user_id=resolved.primary?.id??null;
      prepared.assigned_user_ids=(resolved.participants?.length?resolved.participants:resolved.primary?[resolved.primary]:[]).map(member=>member.id);
    }
    // Manual materialization adds explicit child owners as parent participants.
    // Binding materialization subsequently replaces those joins with its own
    // resolved assignment; helper eligibility still sees every child below.
    if(!definition.binding){
      skillAssignees=[...prepared.assigned_user_ids];
      prepared.assigned_user_ids=[...new Set([...prepared.assigned_user_ids,...prepared.actions.flatMap(action=>action.assigned_user_ids)])];
    }
  }
  const actions=new Map(prepared.actions.map(action=>[action.action_key,action]));
  const input={context,root:{ref:{kind:'definition_root'},role:'source_root',task:executionTask(definition.task),
    primary_user_id:prepared.primary_user_id,assigned_user_ids:prepared.assigned_user_ids,skill_ids:definition.skill_ids,
    ...(skillAssignees?{skill_assignee_user_ids:skillAssignees}:{}),
    window:prepared.window,is_optional:!!definition.task.is_optional,binding:definition.binding,planning:definition.planning},
    actions:definition.subtasks.map(action=>({ref:{kind:'template',template_id:ids.get(action.action_key)},role:'source_action',
      task:executionTask(action.task),primary_user_id:actions.get(action.action_key).primary_user_id,
      assigned_user_ids:actions.get(action.action_key).assigned_user_ids,skill_ids:action.skill_ids,
      window:actions.get(action.action_key).window,is_optional:!!action.task.is_optional})),selection};
  return {execution:prepareProspectiveTaskExecution(d,input),window:prepared.window,context};
}
function prepareFutureScoringExecution(task,before,after,wires) {
  try {return prepareFutureScoringExecutionChecked(task,before,after,wires);}
  catch(error){if(error instanceof TaskStateError&&error.details?.reason==='scoring_projection_unavailable')throw error;
    throw prospectiveUnavailable('projection_evidence_unavailable');}
}
function prepareFutureScoringExecutionChecked(task,before,after,wires) {
  const d=db.get(),state=taskSeriesState(d,task.id),asOfDate=todayInHouseholdZone();
  const stored=seriesDefinitionForGeneration(d,state.series_id,state.occurrence.generation+1);
  const targetOccurrence=d.prepare("SELECT * FROM task_recurrence_occurrences WHERE series_id=? AND generation=? AND state='materialized'")
    .get(state.series_id,state.occurrence.generation+1);
  let target=null;
  if(targetOccurrence) {
    const targetTask=d.prepare('SELECT * FROM tasks WHERE id=?').get(targetOccurrence.task_id);
    if(!targetTask||seriesOccurrencePreservationReason(d,targetOccurrence,targetTask))throw prospectiveUnavailable('target_preserved');
    target={occurrence:targetOccurrence,task:targetTask};
  }
  const old=phaseExecutionInput(task,state,{...stored,data:before},before,wires.ids,asOfDate,target,{beforePhase:true});
  // Match appendSeriesDefinition's canonical no-op, not the concrete target's
  // child-derived participant joins or a projected legacy scoring definition.
  const canonicalUnchanged=!!stored&&definitionEqual(stored.data,after);
  const record=canonicalUnchanged?{...stored,data:after}:{...stored,id:null,data:after};
  const next=phaseExecutionInput(task,state,record,after,wires.ids,asOfDate,target,{canonicalUnchanged});
  const project=(prepared,actions)=>({...prepared.execution,units:prepared.execution.units.filter(unit=>unit.ref.kind==='definition_root'
    ||actions.some(action=>wires.ids.get(action.action_key)===unit.ref.template_id))});
  return {before:project(old,wires.old),after:project(next,wires.next),forecast_context:{kind:'next_occurrence',effective_generation:state.occurrence.generation+1,
    as_of_date:asOfDate,before:{...old.window,preparation:old.context.preparation},after:{...next.window,preparation:next.context.preparation},
    conditions:[...new Set([...old.context.conditions,...next.context.conditions,
      ...[...old.execution.warnings,...next.execution.warnings].map(warning=>warning.reason)])]}};
}
function decorateScoringSettlements(preview,actor) {
  if(!preview.settlements)return;
  preview.settlements=preview.settlements.map(settlement=>{
    const task=db.get().prepare('SELECT * FROM tasks WHERE id=?').get(settlement.task_id);
    const frozen=db.get().prepare('SELECT logical_key FROM task_scoring_settlements WHERE id=?').get(settlement.settlement_id);
    const matching=task&&frozen?.logical_key===taskScoringIdentity(db.get(),task.id)&&taskCapabilities(db.get(),actor,task).view;
    return {...settlement,title:matching?task.title:task?'Historical work':'Removed work',...(matching?{is_optional:!!task.is_optional}:{})};
  });
}
function decorateScoringUnits(preview,before,after,{futureIds=null,drafts=[]}={}) {
  const decorate=(units,metadata)=>units?.map(unit=>{
    let ref=unit.ref,row;
    if(futureIds&&ref.kind==='definition_root'){ref={kind:'action',action_key:'root'};row=metadata.get('root');}
    else if(futureIds&&ref.kind==='template'){
      const key=futureIds.get(ref.template_id);row=metadata.get(key);ref={kind:'action',action_key:key};
    }else if(!futureIds&&ref.kind==='task')row=metadata.get(ref.task_id);
    else if(!futureIds&&ref.kind==='draft'){
      row=drafts[ref.draft_index];ref={kind:'draft',draft_key:row?.client_key??`draft:${ref.draft_index}`};
    }
    if(!row)throw new TaskStateError('The scoring preview changed. Refresh before trying again.',{reason:'scoring_projection_unavailable'});
    return {...unit,ref,title:row.title,is_optional:!!row.is_optional};
  });
  if(preview.before_units)preview.before_units=decorate(preview.before_units,before);
  if(preview.after_units)preview.after_units=decorate(preview.after_units,after);
  return preview;
}
function futureEditProjection(req,task,definition,state) {
  const fields=Object.fromEntries(['title','description','points','scoring_mode','visibility','priority','category','start_date','start_time','due_date','due_time','due_date_offset_days','is_recurring','recurrence_rule','recurrence_from_completion','expiration_policy','locked','countdown','assignment_mode','rotation_group','rotation_slot'].map(key=>[key,definition.task[key]]));
  fields.card_color_choice=definition.task.card_color_policy;
  fields.assigned_to=definition.assigned_user_ids;fields.skill_ids=definition.skill_ids;fields.tags=definition.tags;
  fields.assignee_policy=definition.assignee_policy??null;fields.direct_assignee_ids=definition.assignee_policy?.direct_assignee_ids??null;
  fields.rotation_user_ids=definition.rotation_user_ids;fields.rotation_bindings=parseRotationBindings(definition.task.rotation_bindings_json);
  fields.assignment_group=definition.task.assignment_group_json?JSON.parse(definition.task.assignment_group_json):null;
  return {task_id:task.id,effective_generation:state.occurrence.generation+1,review_required:!!definition.task.scoring_review_required,permissions:futureRootCapabilities(db.get(),req,task,definition),fields,
    actions:definition.subtasks.filter(a=>futureActionCapabilities(db.get(),req,task,a).view).map(action=>({action_key:action.action_key,
    fields:{...Object.fromEntries(['title','description','category','priority','start_date','start_time','due_date','due_time','points','visibility','locked','expiration_policy','is_optional'].map(key=>[key,action.task[key]])),assignment_group:action.task.assignment_group_json?JSON.parse(action.task.assignment_group_json):null,
      assigned_user_ids:action.assigned_user_ids,skill_ids:action.skill_ids,tags:action.tags},permissions:futureActionCapabilities(db.get(),req,task,action)})),
    revisions:{expected_revision:task.revision,...(task.parent_task_id?{expected_parent_revision:db.get().prepare('SELECT revision FROM tasks WHERE id=?').get(task.parent_task_id)?.revision}:{}),expected_series_revision:state.revision}};
}
function saveFutureTaskDefinition(req,res,task) {
  let updated,seriesEdit,unchanged=false;
  db.get().transaction(()=>{
    const current=db.get().prepare('SELECT * FROM tasks WHERE id=?').get(task.id);
    assertTaskRevision(db.get(),current,req.body,{required:true,requireParent:true});
    const {state,before,definition}=futureEditContext(req,current);
    if(futureReviewRequired(definition))throw new TaskStateError('Choose a scoring mode for future work before saving.',{reason:'scoring_review_required'});
    const full={points:definition.task.points,assigned_to:definition.assigned_user_ids,subtasks:definition.subtasks.map((a,i)=>({id:i+1,title:a.task.title,points:a.task.points,assigned_user_ids:a.assigned_user_ids})),
      ...(['whole_task','subtasks'].includes(definition.task.scoring_mode)?{scoring_mode:definition.task.scoring_mode}:{})};
    assertTaskScoringMutation(db.get(),current.id,full,{scope:'future_only'});
    // UUID allocation is confined to this authorized save transaction.
    const createdActions=finalizeFutureActionKeys(definition);
    const revised=appendSeriesDefinition(db.get(),current.id,{expectedRevision:req.body.expected_series_revision,
      actorId:req.authUserId||req.session.userId,definition,effectiveGeneration:state.occurrence.generation+1});
    unchanged=!revised.changed;
    seriesEdit=revised.changed?reconcileSeriesFuture(db.get(),revised,{actor:req,scope:'future_only'})
      :{scope:'future_only',series_id:state.series_id,revision:state.revision,current_preserved:true,updated:[],preserved:[]};
    if(createdActions.length)seriesEdit.created_actions=createdActions;
    updated=current;
  }).immediate();
  return res.json({data:hydrateTask(updated,req.authUserId||req.session.userId),series_edit:seriesEdit,...(unchanged?{unchanged:true}:{})});
}

/** Zeitstempel im Format der übrigen Spalten (UTC, sekundengenau). */
function nowStamp() {
  return new Date().toISOString().slice(0, 19) + 'Z';
}

/**
 * Eine Aufgabe ablegen oder zurückholen (#688). Rührt den Status nicht an: was
 * erledigt war, bleibt erledigt, was offen war, bleibt offen.
 * Rückgabe: der neue archived_at-Wert (null = zurückgeholt).
 */
function setArchived(taskId, archived) {
  const value = archived ? nowStamp() : null;
  db.get().prepare('UPDATE tasks SET archived_at = ? WHERE id = ?').run(value, taskId);
  return value;
}

/** Verwaltbare Kategorien aus der DB (nach sort_order). */
function loadTaskCategories() {
  return db.get().prepare(
    'SELECT key, name, label_key, sort_order, max_assignees FROM task_categories ORDER BY sort_order ASC, key ASC'
  ).all();
}

/** Nur die Keys — für die dynamische category-Validierung. */
function validTaskCategoryKeys() {
  return loadTaskCategories().map((c) => c.key);
}

/** Anzahl Aufgaben, die eine Kategorie referenzieren (Guard vor dem Löschen). */
function taskCategoryInUseCount(key) {
  return ['tasks','activity_templates','workflow_templates'].reduce((count,table)=>count+db.get().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE category=?`).get(key).n,0);
}

/**
 * Der heutige Tag in der Zone des Haushalts (YYYY-MM-DD).
 *
 * Wichtig für die Serienrechnung (#658): "an dem Tag, an dem ich sie erledigt
 * habe" ist eine Wanduhr-Aussage. Wer um 00:30 in Berlin abhakt, hat es am
 * neuen Tag getan, auch wenn in UTC noch der Vortag läuft - eine wöchentliche
 * Aufgabe wäre sonst sechs statt sieben Tage später fällig. Dieselbe Zone
 * begrenzt auch das Aufholen der fälligkeitsverankerten Serien, damit die
 * Folgeinstanz nicht in einem Zeitzonen-Saum als überfällig entsteht;
 * `due_date` ist ohnehin ein reiner Wanduhr-Wert (siehe utils/timezone.js).
 */
function todayInHouseholdZone() {
  return todayKey(db.get());
}

/** Punktewert einer Aufgabe auf eine nichtnegative Ganzzahl normalisieren. */
function clampPoints(val) {
  const n = Math.trunc(Number(val));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, MAX_POINTS);
}

/**
 * Haushaltweiter Standard-Punktwert für neue Aufgaben (#578). 0 = kein Standard.
 * Liegt in sync_config, damit die Einstellung im selben Speicher wie die
 * übrigen Haushalt-Präferenzen liegt (siehe server/routes/preferences.js).
 */
function defaultTaskPoints() {
  const row = db.get().prepare("SELECT value FROM sync_config WHERE key = 'tasks_default_points'").get();
  return clampPoints(row?.value);
}

// Erledigte Aufgaben dürfen nicht umbepunktet werden: genau für 'done' hält der
// reward_ledger eine earn-Buchung über den damaligen Punktwert
// (awardForCompletion in server/services/rewards.js); ein nachträglicher Wechsel
// ließe Aufgabenwert und Gutschrift auseinanderlaufen.
// Alle übrigen Status sind buchungsfrei. Sie mitzuziehen verhindert, dass eine
// später reaktivierte Aufgabe einen veralteten Wert auszahlt.
// Das Archiv spielt hier bewusst keine Rolle: es sagt nichts über eine Buchung
// aus. Eine abgelegte erledigte Aufgabe steht auf 'done' und ist damit ohnehin
// ausgenommen; eine abgelegte offene ist buchungsfrei wie jede andere offene.
const REBASE_EXCLUDED_STATUS = 'done';

/** Nicht erledigte Hauptaufgaben, die exakt auf einem Punktwert stehen. */
function rebasableTasks(points,actor) {
  return db.get().prepare(`SELECT t.* FROM tasks t
    WHERE t.points=? AND t.parent_task_id IS NULL AND t.status!=?
      AND t.scoring_review_required=0 AND NOT EXISTS(SELECT 1 FROM task_scoring_settlements s WHERE s.task_id=t.id)`)
    .all(points,REBASE_EXCLUDED_STATUS).filter(task=>{const caps=taskCapabilities(db.get(),actor,task);return caps.edit&&caps.change_points;});
}

// --------------------------------------------------------
// Hilfsfunktionen
// --------------------------------------------------------

const ASSIGNED_USERS_SQL = `(
  SELECT json_group_array(json_object(
    'id', u.id, 'display_name', u.display_name, 'color', u.avatar_color,
    'avatar_data', u.avatar_data
  ))
  FROM task_assignments ta JOIN users u ON u.id = ta.user_id
  WHERE ta.task_id = t.id
) AS assigned_users_json`;

function addAssignedUsers(task) {
  task.assigned_users = task.assigned_users_json ? JSON.parse(task.assigned_users_json) : [];
  delete task.assigned_users_json;
  task.rotation_user_ids = task.assignment_mode === 'round_robin'
    ? loadRotationUserIds(db.get(), task.id)
    : [];
  return task;
}

/**
 * Hängt jedem Task die Anzahl der für die Person sichtbaren, verknüpften
 * Dokumente an (document_count, #503). Eine einzige gruppierte Abfrage statt
 * pro-Task, damit die Listen-Route günstig bleibt.
 */
function attachDocumentCounts(tasks, me) {
  if (!tasks.length) return tasks;
  const counts = db.get().prepare(`
    SELECT td.task_id AS id, COUNT(*) AS n
    FROM task_documents td
    JOIN family_documents d ON d.id = td.document_id
    WHERE d.status != 'archived' AND ${DOC_VISIBLE_SQL}
    GROUP BY td.task_id
  `).all({ me });
  const map = new Map(counts.map((r) => [r.id, r.n]));
  for (const task of tasks) task.document_count = map.get(task.id) ?? 0;
  return tasks;
}

/**
 * Hängt jeder Aufgabe ihre Tags an (#586). Eine Abfrage für die ganze Liste,
 * aus demselben Grund wie attachDocumentCounts.
 */
function attachTags(tasks) {
  if (!tasks.length) return tasks;
  const map = loadTagsFor(db.get(), tasks.map((t) => t.id));
  for (const task of tasks) task.tags = map.get(task.id) ?? [];
  return attachTaskSkills(db.get(), tasks);
}

function taskSkillInput(body, existingTaskId = null, activityTemplateId = null) {
  const d = db.get();
  const snapshot=existingTaskId&&getTaskActivityBinding(d,existingTaskId)?.definition_snapshot_json;
  if(snapshot && Number(getTaskActivityBinding(d,existingTaskId)?.activity_template_id)===Number(activityTemplateId))
    return normalizeSkillIds(d,body.skill_ids,JSON.parse(snapshot).required_skill_ids);
  const saved = existingTaskId ? loadTaskSkillIds(d, existingTaskId) : [];
  const ids = normalizeSkillIds(d, body.skill_ids, saved);
  if (activityTemplateId) {
    const templateIds = d.prepare('SELECT skill_id FROM activity_template_skills WHERE activity_template_id = ? ORDER BY sort_order')
      .all(activityTemplateId).map((row) => row.skill_id);
    return body.skill_ids === undefined ? templateIds : ids;
  }
  return ids;
}

function instanceActivitySkillSnapshot(d, templateId, skillIds, existingSnapshot = null) {
  const snapshot=existingSnapshot?structuredClone(existingSnapshot):captureActivityTemplateDefinition(d,templateId);
  if(JSON.stringify(snapshot.required_skill_ids)===JSON.stringify(skillIds))return existingSnapshot;
  snapshot.required_skill_ids=[...skillIds];
  return snapshot;
}

function instanceGroupSnapshot(d,snapshot,requested,{newInstance=false}={}) {
  if(newInstance&&Array.isArray(snapshot.checklist))snapshot={...snapshot,checklist:snapshot.checklist.map(item=>{
    if(!item.assignment_group_json)return item;
    const configuration=typeof item.assignment_group_json==='string'?JSON.parse(item.assignment_group_json):item.assignment_group_json;
    const {member_order,...defaultConfiguration}=configuration;
    return {...item,assignment_group_json:JSON.stringify(defaultConfiguration)};
  })};
  if((snapshot.assignment_policy||snapshot.assignment_strategy)!=='group_rotation') {
    if(requested)throw new TaskStateError('This Activity Template does not use a Rotation Group.',{},400);
    return snapshot;
  }
  const source=typeof snapshot.assignment_group_json==='string'?JSON.parse(snapshot.assignment_group_json):snapshot.assignment_group_json;
  if(!source?.group_id)throw new TaskStateError('This Activity Template has no Rotation Group.',{},400);
  const configuration=normalizeGroupAssignment(d,requested||{
    ...source,...(newInstance?{member_order:undefined}:{})
  },{allowInactive:!newInstance,allowImported:!newInstance});
  if(Number(configuration.group_id)!==Number(source.group_id))
    throw new TaskStateError('Choose the Group configured on this Activity Template.',{},400);
  return {...snapshot,assignment_group_json:JSON.stringify(configuration)};
}

function sharedGroupOnDate(d,groupId,dateKey) {
  return d.prepare(`SELECT v.usage_mode FROM rotation_group_schedule_versions v
    JOIN rotation_group_schedules s ON s.id=v.schedule_id WHERE s.group_id=? AND v.effective_date<=?
    ORDER BY v.effective_date DESC,v.id DESC LIMIT 1`).get(groupId,dateKey)?.usage_mode==='shared';
}

function independentlyAssignedTaskMembers(taskId, userIds, previousUserIds, primaryUserId) {
  const direct=readTaskAssigneePolicy(db.get(),taskId);
  if(direct)return userIds.filter(id=>direct.direct_assignee_ids.includes(id)||!previousUserIds.includes(id)||id===primaryUserId);
  const derived = new Set(db.get().prepare(`SELECT user_id FROM task_responsibilities
    WHERE task_id = ? AND role = 'participant' AND source = 'subtasks'
      AND status IN ('active', 'fulfilled')`).all(taskId).map((row) => Number(row.user_id)));
  const previous = new Set(previousUserIds.map(Number));
  // Child assignees also appear in the parent's assignment list for visibility
  // and responsibility. They do not inherit its required skills. There is no
  // separate marker for an old secondary assignee who also helps on a child:
  // preserve that existing derived responsibility, but always validate the
  // primary and every newly selected independent worker.
  return userIds.filter((id) => Number(id) === Number(primaryUserId)
    || !previous.has(Number(id)) || !derived.has(Number(id)));
}

function initialSubtasksInput(body, {preserveProvenance=false,parentTaskId=null}={}) {
  if (body.subtasks === undefined) return undefined;
  if (body.parent_task_id || !Array.isArray(body.subtasks) || body.subtasks.length > 50) {
    throw new TaskSkillError('A new Task can contain at most 50 subtasks.');
  }
  return body.subtasks.map((item) => {
    if (!item || typeof item !== 'object' || typeof item.title !== 'string' || !item.title.trim() || item.title.trim().length > 200) {
      throw new TaskSkillError('Give each subtask a name of at most 200 characters.');
    }
    if (item.is_optional !== undefined && ![true,false,0,1].includes(item.is_optional)) throw new TaskSkillError('Subtask optional must be true or false.');
    let assignedUsers;
    let templateItemId=null;
    let points;
    if (item.points !== undefined) {
      if (item.points !== null && !['number', 'string'].includes(typeof item.points)
        || !Number.isInteger(Number(item.points)) || Number(item.points) < 0 || Number(item.points) > MAX_POINTS)
        throw new TaskSkillError('Subtask points must be a whole number from 0 to 10000.');
      points = clampPoints(item.points);
    }
    if(item.activity_template_checklist_item_id!=null && !preserveProvenance) {
      const source=db.get().prepare('SELECT activity_template_id FROM activity_template_checklist_items WHERE id=?').get(item.activity_template_checklist_item_id);
      if(!source || Number(source.activity_template_id)!==Number(body.activity_template_id))throw new TaskSkillError('Choose a subtask from this Activity Template.');
      templateItemId=Number(item.activity_template_checklist_item_id);
    }
    if(item.assigned_user_ids!==undefined) {
      if(!Array.isArray(item.assigned_user_ids)||item.assigned_user_ids.length>50
        ||item.assigned_user_ids.some(id=>!Number.isSafeInteger(id)||id<1)
        ||new Set(item.assigned_user_ids).size!==item.assigned_user_ids.length)throw new TaskSkillError('Choose valid household members for each subtask.');
      const members=new Set(householdMembers(db.get()).map(member=>member.id));
      if(item.assigned_user_ids.some(id=>!members.has(id)))throw new TaskSkillError('Choose an existing household member for each subtask.');
      assignedUsers=[...item.assigned_user_ids];
    }
    const savedGroupJson=item.id&&parentTaskId?db.get().prepare('SELECT assignment_group_json FROM tasks WHERE id=? AND parent_task_id=?').get(Number(item.id),parentTaskId)?.assignment_group_json:null;
    const savedGroup=savedGroupJson?JSON.parse(savedGroupJson):null;
    const proposedGroup=item.assignment_group===undefined?item.assignment_group_json??savedGroup:item.assignment_group;
    const proposedGroupId=(typeof proposedGroup==='string'?JSON.parse(proposedGroup):proposedGroup)?.group_id;
    const assignmentGroup=normalizeGroupAssignment(db.get(),proposedGroup,
      {allowInactive:!!savedGroup&&Number(proposedGroupId)===Number(savedGroup.group_id)});
    if(assignmentGroup&&assignedUsers?.length)throw new TaskSkillError('Choose a person or a Rotation Group for a subtask.');
    return { title: item.title.trim(), skillIds: normalizeSkillIds(db.get(), item.skill_ids), points, assignedUsers,templateItemId,
      assignmentGroup,
      isOptional: item.is_optional === undefined ? undefined : item.is_optional ? 1 : 0 };
  });
}

function selectTaskGroupMember(taskId,configuration,skills,{consumerKey,commit=true,allowDelegation=true,previousUserId=null,window=null}={}) {
  return selectTaskGroupMemberForDatabase(db.get(),taskId,configuration,skills,
    {consumerKey,commit,allowDelegation,previousUserId,window});
}

function assertOptionalityEdit(task, value) {
  if (value === undefined || Number(!!value) === Number(task.is_optional || 0)) return;
  if (taskWindowAncestors(db.get(),task.id).some(row=>row.id!==task.id&&row.status==='done'))
    throw new TaskStateError('Reopen the completed parent Task before changing whether its subtasks are optional.',{reason:'optional_parent_completed'});
}

function editedSubtasksInput(task, body, actor, { definitionOnly = false } = {}) {
  if(body.subtasks===undefined)return undefined;
  if(task.parent_task_id)throw new TaskSkillError('Edit subtasks on the original Task.');
  const normalized=initialSubtasksInput(body,{preserveProvenance:true,parentTaskId:task.id});
  const existing=ordinaryActivitySubtasks(db.get(),task.id).filter(child=>!child.archived_at);
  const seen=new Set();
  const next=normalized.map((item,index)=>{
    const clientKey=body.subtasks[index].client_key;
    let id=body.subtasks[index].id;
    // Idempotent retry from an older create form without child IDs.
    if(id==null && normalized.length===existing.length
      && normalized.every((candidate,i)=>candidate.title===existing[i].title
        && sameIdOrder(candidate.skillIds,loadTaskSkillIds(db.get(),existing[i].id))))id=existing[index].id;
    if(id!=null) {
      id=Number(id);
      const child=existing.find(row=>row.id===id);
      if(!child)throw new TaskSkillError('Only existing editable subtasks from this Task can be selected.');
      if(seen.has(id))throw new TaskSkillError('Choose each existing subtask only once.');
      seen.add(id);
      item.points ??= child.points || 0;
      item.isOptional ??= child.is_optional || 0;
      if(!definitionOnly)assertOptionalityEdit(child,item.isOptional);
      if(JSON.stringify(item.assignmentGroup)!==(child.assignment_group_json||'null')){
        if(!taskCapabilities(db.get(),actor,child).change_assignment||!taskCapabilities(db.get(),actor,child).reassign)
          throw new TaskSkillError('Your permissions do not allow changing this subtask assignment.');
        if(item.assignmentGroup)assertCapability(db.get(),actor,'rotations.view');
      }
      const assignments=item.assignedUsers===undefined?{}:{assigned_to:item.assignedUsers};
      if(!definitionOnly && item.assignedUsers!==undefined && ['done','expired','skipped','closed_incomplete'].includes(child.status)
        && !sameIdOrder(item.assignedUsers,db.get().prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(child.id).map(row=>row.user_id)))
        throw new TaskStateError('Completed subtask assignments are historical. Reopen that action before changing its assignee.');
      assertTaskMutation(db.get(),actor,child,{title:item.title,points:item.points,skill_ids:item.skillIds,is_optional:item.isOptional,...assignments},{operation:'update'});
    } else {
      if(task.status==='done'&&!definitionOnly)throw new TaskStateError('Reopen the completed parent Task before adding checklist steps.',{reason:'optional_parent_completed'});
      if(item.assignmentGroup)assertCapability(db.get(),actor,'rotations.view');
      assertTaskMutation(db.get(),actor,null,{parent_task_id:task.id,points:item.points,skill_ids:item.skillIds,is_optional:item.isOptional,...(item.assignedUsers===undefined?{}:{assigned_to:item.assignedUsers})},{operation:'create'});
    }
    return {...item,points:item.points ?? 0,isOptional:item.isOptional ?? 0,id,clientKey};
  });
  for(const child of existing.filter(row=>!seen.has(row.id)))
    assertTaskMutation(db.get(),actor,child,{}, {operation:'delete'});
  return {next:resolveSeriesDraftClientKeys(next),remove:existing.filter(row=>!seen.has(row.id))};
}

function applyEditedSubtasks(task, edited, actorId) {
  if(!edited)return;
  const recurring = !!db.get().prepare('SELECT 1 FROM task_recurrence_occurrences WHERE task_id=?').get(task.id);
  for(const child of edited.remove) {
    recordTaskActivity(db.get(),task.id,'subtask_removed',actorId,{title:child.title},child.id);
    queueTodoDeletion('tasks',child);
    if(isTripStep(db.get(),child.id)) {
      retireTripTask(db.get(),child.id,actorId,'Trip step removed in Task editor');
      db.get().prepare("UPDATE trip_task_steps SET state='removed' WHERE task_id=?").run(child.id);
    } else if(recurring) {
      // An action removed from an occurrence stops being actionable, while its
      // original ID, progress, documents, comments, awards and helper evidence
      // remain available as history. Supervision reconciliation retires work.
      registerRecurrenceAction(db.get(),child.id);
      db.get().prepare("UPDATE tasks SET archived_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?").run(child.id);
    } else {
      deleteTaskSupervisionProjections(db.get(),child.id);
      db.get().prepare('DELETE FROM tasks WHERE id=?').run(child.id);
    }
  }
  for(const [order,child] of edited.next.entries()) {
    let id=child.id;
    if(id) {
      assertOptionalityEdit(db.get().prepare('SELECT * FROM tasks WHERE id=?').get(id),child.isOptional);
      db.get().prepare('UPDATE tasks SET title=?,sort_order=?,is_optional=?,points=? WHERE id=?').run(child.title,order,child.isOptional,child.points,id);
    }
    else {id=Number(db.get().prepare(`INSERT INTO tasks(title,category,status,start_date,due_date,due_time,
      parent_task_id,created_by,visibility,sort_order,start_time,is_optional,points) VALUES(?,?,'open',?,?,?,?,?,?,?,?,?,?)`)
      .run(child.title,task.category,task.start_date,task.due_date,task.due_time,task.id,actorId,task.visibility,order,task.start_time,child.isOptional,child.points).lastInsertRowid);assignNewTaskCardColor(db.get(),id,{inheritFrom:task.id});}
    if(!sameIdOrder(loadTaskSkillIds(db.get(),id),child.skillIds))setTaskSkills(db.get(),id,child.skillIds);
    if(child.assignmentGroup){
      const existing=db.get().prepare('SELECT * FROM tasks WHERE id=?').get(id);
      const unchanged=child.id&&existing.assignment_group_json===JSON.stringify(child.assignmentGroup);
      let selected=unchanged?Number(existing.assigned_to)||null:null;
      if(selected){try{assertTaskSkillAssignments(db.get(),child.skillIds,[selected],existing.due_date||todayInHouseholdZone(),{allowDelegation:true});
        assertTaskAssignmentAvailability(db.get(),id,[selected]);}catch{selected=null;}}
      if(!selected){selected=selectTaskGroupMember(id,child.assignmentGroup,child.skillIds,{consumerKey:`subtask:${task.id}:${child.clientKey||id}`});
        assertTaskMutation(db.get(),actorId,existing,{assigned_to:[selected]},{operation:child.id?'update':'create'});}
      child.assignedUsers=[selected];recordGroupAssignment(db.get(),id,child.assignmentGroup,selected);
    }else if(child.id&&db.get().prepare('SELECT assignment_group_json FROM tasks WHERE id=?').get(id)?.assignment_group_json){
      db.get().prepare('UPDATE tasks SET assignment_group_json=NULL WHERE id=?').run(id);
      db.get().prepare("UPDATE task_group_assignment_decisions SET superseded_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE task_id=? AND superseded_at IS NULL").run(id);
    }
    if(!child.id&&child.assignedUsers===undefined)persistNewTaskAssignees(db.get(),id,[]);
    if(child.assignedUsers!==undefined) {
      const old=child.id?db.get().prepare('SELECT * FROM tasks WHERE id=?').get(id):null;
      const proposal=proposedTaskAssigneePolicy(db.get(),old,{assigned_to:child.assignedUsers},{category:old?.category??task.category});
      if(proposal)persistTaskAssigneePolicy(db.get(),id,proposal,proposal.direct_assignee_ids);
      assertTaskSkillAssignments(db.get(),child.skillIds,child.assignedUsers,task.due_date||todayInHouseholdZone(),{allowDelegation:true});
      assertTaskAssignmentAvailability(db.get(),id,child.assignedUsers);
      db.get().prepare('UPDATE tasks SET assigned_to=? WHERE id=?').run(child.assignedUsers[0]??null,id);
      setAssignments(db.get(),id,child.assignedUsers);
    }
    if(recurring)registerRecurrenceAction(db.get(),id);
  }
}

/**
 * Attach an optional typed action to a Task without teaching the Tasks module
 * about Meals, Trips, or any other destination. The link remains generic and
 * the shared Task detail component can expose it from every origin.
 */
function attachTaskActionLinks(tasks) {
  if (!tasks.length) return tasks;
  const supported = db.get().prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_action_links'"
  ).get();
  if (!supported) return tasks;
  const ids = tasks.map((task) => Number(task.id)).filter(Number.isInteger);
  if (!ids.length) return tasks;
  const rows = db.get().prepare(`
    SELECT task_id, action_type, label, path, params_json, source_type, source_id
      FROM task_action_links
     WHERE task_id IN (${ids.map(() => '?').join(',')})
  `).all(...ids);
  const byTask = new Map(rows.map((row) => {
    let params = {};
    try { params = JSON.parse(row.params_json || '{}'); } catch { params = {}; }
    return [Number(row.task_id), { ...row, params }];
  }));
  for (const task of tasks) task.action_link = byTask.get(Number(task.id)) || null;
  return tasks;
}

function parseAssignedTo(val) {
  if (Array.isArray(val)) return val.map(Number).filter(Boolean);
  if (val !== null && val !== undefined && val !== '') return [Number(val)].filter(Boolean);
  return [];
}

function parseTaskActivityBinding(body, existing = null) {
  const hasTemplate = Object.prototype.hasOwnProperty.call(body, 'activity_template_id');
  const hasSubject = Object.prototype.hasOwnProperty.call(body, 'activity_subject_user_id');
  const existingSnapshot = existing?.definition_snapshot_json ? JSON.parse(existing.definition_snapshot_json) : null;
  const existingRoster = Array.isArray(existingSnapshot?.fixed_assignee_ids) ? existingSnapshot.fixed_assignee_ids : null;
  if (!hasTemplate && !hasSubject && body.assigned_to === undefined && body.direct_assignee_ids === undefined) {
    return {
      specified: false,
      binding: existing ? {
        activityTemplateId: Number(existing.activity_template_id),
        subjectUserId: existing.subject_user_id == null ? null : Number(existing.subject_user_id),
        assignmentOverrideUserId: existing.assignment_override_user_id ?? null,
        ...(existingRoster ? { assignmentOverrideUserIds: [...existingRoster] } : {}),
      } : null,
    };
  }

  const rawTemplate = hasTemplate ? body.activity_template_id : existing?.activity_template_id;
  if (rawTemplate === null || rawTemplate === undefined || rawTemplate === '') {
    return { specified: true, binding: null };
  }
  const activityTemplateId = Number(rawTemplate);
  if (!Number.isInteger(activityTemplateId) || activityTemplateId <= 0) {
    return { specified: true, error: 'activity_template_id must be a positive integer or null.' };
  }

  const rawSubject = hasSubject ? body.activity_subject_user_id : existing?.subject_user_id;
  let subjectUserId = null;
  if (rawSubject !== null && rawSubject !== undefined && rawSubject !== '') {
    subjectUserId = Number(rawSubject);
    if (!Number.isInteger(subjectUserId) || subjectUserId <= 0) {
      return { specified: true, error: 'activity_subject_user_id must be a positive integer or null.' };
    }
  }
  const sameTemplate = Number(existing?.activity_template_id) === activityTemplateId;
  let assignmentOverrideUserId = sameTemplate ? existing?.assignment_override_user_id ?? null : null;
  if (sameTemplate && existingRoster) {
    const raw = Object.hasOwn(body, 'direct_assignee_ids') ? body.direct_assignee_ids : body.assigned_to;
    let roster = [...existingRoster];
    if (raw !== undefined) {
      let requested = (Array.isArray(raw) ? raw : [raw]).map(id => typeof id === 'number' || typeof id === 'string' && id.trim() ? Number(id) : NaN);
      if (!requested.length || requested.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(requested).size !== requested.length)
        return { specified: true, error: 'Choose valid distinct Activity Template assignees.' };
      const currentTask = existing.task_id ? db.get().prepare('SELECT * FROM tasks WHERE id=?').get(existing.task_id) : null;
      // An old editor can echo the parent visibility union, including child
      // owners. Only a direct marker promotes that unchanged union to a roster.
      if (currentTask && !Object.hasOwn(body, 'direct_assignee_ids'))
        requested = taskDirectAssignmentSelection(db.get(), currentTask, { ...body, assigned_to: requested }).selected;
      const current = currentTask?.assigned_to ?? existingSnapshot.fixed_user_id;
      const primary = requested.includes(Number(current)) ? Number(current) : requested[0];
      roster = [primary, ...existingRoster.filter(id => id !== primary && requested.includes(id)), ...requested.filter(id => id !== primary && !existingRoster.includes(id))];
      try { overrideTaskActivityAssignees(existingSnapshot, roster); } catch (error) { return { specified: true, error: error.message }; }
      if (primary !== Number(existingSnapshot.fixed_user_id)) assignmentOverrideUserId = primary;
    }
    return { specified: true, binding: { activityTemplateId, subjectUserId, assignmentOverrideUserId, assignmentOverrideUserIds: roster } };
  }
  const requested = parseAssignedTo(body.assigned_to);
  const currentAssignment = sameTemplate && existing?.task_id ? db.get().prepare(`
    SELECT user_id FROM task_assignments WHERE task_id=?
    UNION SELECT assigned_to AS user_id FROM tasks WHERE id=? AND assigned_to IS NOT NULL
    ORDER BY user_id`).all(existing.task_id,existing.task_id).map(row=>Number(row.user_id)) : null;
  // Full editors echo the current assignee. That does not authorize or request
  // a new fixed override, and a subject change must still resolve its new person.
  const unchangedAssignment = currentAssignment && sameIdOrder([...requested].sort((a,b)=>a-b),currentAssignment);
  if (requested.length && !unchangedAssignment) {
    if (requested.length !== 1 || !Number.isSafeInteger(requested[0]) || requested[0] <= 0) return {specified:true,error:'Choose one valid Activity Template assignee.'};
    const activity = sameTemplate&&existing?.definition_snapshot_json ? JSON.parse(existing.definition_snapshot_json)
      : db.get().prepare('SELECT fixed_user_id,assignment_policy,assignment_strategy,allow_assignment_override FROM activity_templates WHERE id=?').get(activityTemplateId);
    if (activity && !activity.allow_assignment_override) {
      if ((activity.assignment_policy || activity.assignment_strategy) !== 'fixed' || Number(activity.fixed_user_id) !== requested[0])
        return {specified:true,error:'This Activity Template does not allow changing its assignee.'};
      assignmentOverrideUserId = null;
    } else assignmentOverrideUserId = requested[0];
  }
  return { specified: true, binding: { activityTemplateId, subjectUserId, assignmentOverrideUserId } };
}

function sameTaskActivityBinding(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const roster = binding => binding.assignmentOverrideUserIds ?? (binding.definition_snapshot_json ? JSON.parse(binding.definition_snapshot_json).fixed_assignee_ids : null) ?? null;
  const leftRoster = roster(a), rightRoster = roster(b);
  return (leftRoster === null && rightRoster === null || leftRoster !== null && rightRoster !== null && sameIdOrder(leftRoster, rightRoster))
    && Number(a.activityTemplateId ?? a.activity_template_id) === Number(b.activityTemplateId ?? b.activity_template_id)
    && Number(a.subjectUserId ?? a.subject_user_id ?? 0) === Number(b.subjectUserId ?? b.subject_user_id ?? 0)
    && Number(a.assignmentOverrideUserId ?? a.assignment_override_user_id ?? 0) === Number(b.assignmentOverrideUserId ?? b.assignment_override_user_id ?? 0);
}

function validateTaskActivityBindingRequest(binding, dateKey, { allowInactive = false, task = null, activitySnapshot = null,assigneePolicy=undefined } = {}) {
  if (!binding) return null;
  try {
    previewTaskActivityBinding(db.get(), {
      activityTemplateId: binding.activityTemplateId,
      subjectUserId: binding.subjectUserId,
      assignmentOverrideUserId: binding.assignmentOverrideUserId,
      assignmentOverrideUserIds: binding.assignmentOverrideUserIds,
      dateKey,
      task,
      allowInactive,
      activitySnapshot,
      assigneePolicy,
    });
    return null;
  } catch (err) {
    if(err.reason==='category_assignee_limit')throw err;
    return err.message;
  }
}

function parseRotationUserIds(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function loadRotationUserIds(d, taskId) {
  return d.prepare(
    'SELECT user_id FROM task_rotation_members WHERE task_id = ? ORDER BY sort_order ASC'
  ).all(taskId).map((row) => row.user_id);
}

function setRotationMembers(d, taskId, userIds) {
  d.prepare('DELETE FROM task_rotation_members WHERE task_id = ?').run(taskId);
  const insert = d.prepare(
    'INSERT INTO task_rotation_members (task_id, user_id, sort_order) VALUES (?, ?, ?)'
  );
  userIds.forEach((userId, index) => insert.run(taskId, userId, index));
}

function sameIdOrder(a, b) {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function normalizeRotationGroup(value) {
  if (value === undefined || value === null) return null;
  const group = String(value).trim();
  return group || null;
}

function parseRotationSlot(value) {
  const slot = Number(value ?? 0);
  return Number.isInteger(slot) && slot >= 0 ? slot : null;
}

function currentRotationGroupState(d, rotationGroup, taskId = null) {
  if (!rotationGroup) return { rotationIndex: 0, rotationCycle: 0, peers: [] };

  let anchor = null;
  if (taskId) {
    const candidate = d.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    if (candidate?.rotation_group
        && candidate.rotation_group.localeCompare(rotationGroup, undefined, { sensitivity: 'accent' }) === 0) {
      anchor = candidate;
    }
  }
  if (!anchor) {
    anchor = d.prepare(`
      SELECT * FROM tasks
       WHERE rotation_group = ? COLLATE NOCASE AND parent_task_id IS NULL
       ORDER BY rotation_cycle DESC, id DESC LIMIT 1
    `).get(rotationGroup);
  }

  const rotationCycle = Number(anchor?.rotation_cycle || 0);
  const rotationIndex = Number(anchor?.rotation_index || 0);
  const params = [rotationGroup, rotationCycle];
  let sql = `SELECT * FROM tasks
              WHERE rotation_group = ? COLLATE NOCASE
                AND rotation_cycle = ? AND parent_task_id IS NULL`;
  if (taskId) { sql += ' AND id != ?'; params.push(Number(taskId)); }
  sql += ' ORDER BY rotation_slot ASC, id ASC';
  const peers = d.prepare(sql).all(...params);
  return { rotationIndex, rotationCycle, peers };
}

/** Future constraints use canonical policy, once per proven series. Keep live
 * current-cycle evidence separate; this read never registers an occurrence. */
function futureRotationGroupState(d,rotationGroup,taskId=null) {
  const current=currentRotationGroupState(d,rotationGroup,taskId);
  if(!rotationGroup)return {...current,progressPeers:[]};
  const selectedSeries=taskId?taskSeriesState(d,taskId)?.series_id:null;
  const frontiers=d.prepare(`SELECT t.*,o.series_id AS future_series_id,o.generation AS future_generation
    FROM task_recurrence_occurrences o JOIN tasks t ON t.id=o.task_id
    WHERE o.state='materialized' AND t.parent_task_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM task_recurrence_occurrences later JOIN tasks next ON next.id=later.task_id
        WHERE later.series_id=o.series_id AND later.state='materialized'
          AND (later.generation>o.generation OR later.generation=o.generation AND later.task_id>o.task_id))`).all();
  const occurrence=d.prepare('SELECT series_id FROM task_recurrence_occurrences WHERE task_id=?');
  const peers=[],effectiveSeries=new Set(),legacyIds=new Set();
  for(const concrete of frontiers) {
    if(concrete.id===Number(taskId)||concrete.future_series_id===selectedSeries)continue;
    const definition=effectiveSeriesScoringDefinition(d,seriesDefinitionForGeneration(d,concrete.future_series_id,concrete.future_generation+1))?.data;
    const peer=definition?{...concrete,...definition.task,series_rotation_user_ids:definition.rotation_user_ids}:concrete;
    const group=normalizeRotationGroup(peer.rotation_group);
    if(peer.assignment_mode!=='round_robin'||!peer.is_recurring||!group
      ||group.localeCompare(rotationGroup,undefined,{sensitivity:'accent'})!==0)continue;
    peers.push(peer);effectiveSeries.add(concrete.future_series_id);
  }
  // Provenance-free current peers retain the established concrete fallback.
  // Retired/deleted historical occurrences are not independent future series.
  for(const peer of current.peers)if(!occurrence.get(peer.id)) {
    peers.push(peer);legacyIds.add(peer.id);
  }
  const progressPeers=current.peers.filter(peer=>{
    const series=occurrence.get(peer.id)?.series_id;
    return series!==selectedSeries&&(effectiveSeries.has(series)||legacyIds.has(peer.id));
  });
  return {...current,peers,progressPeers};
}

function rotationGroupConfigError(d, {
  taskId = null, joining = false, assignmentMode, rotationGroup, rotationSlot,
  rotationUserIds, recurrenceRule, recurrenceFromCompletion, dueDate, dueTime,
  startDate = null, dueDateOffset = null, futureDefinitions = false,
}) {
  if (!rotationGroup) return null;
  if (assignmentMode !== 'round_robin') return 'Rotation groups require round-robin assignment.';
  if (rotationGroup.length > 80) return 'Rotation group names are limited to 80 characters.';
  if (rotationSlot === null || rotationSlot >= rotationUserIds.length) {
    return 'Rotation group position must refer to a member in the round-robin list.';
  }

  const state = futureDefinitions?futureRotationGroupState(d,rotationGroup,taskId):currentRotationGroupState(d, rotationGroup, taskId);
  if (joining && (state.progressPeers??state.peers).some((peer) => peer.status !== 'open')) {
    return 'Cannot join a rotation group after its current cycle has started.';
  }
  for (const peer of state.peers) {
    if (!sameIdOrder(peer.series_rotation_user_ids??loadRotationUserIds(d, peer.id), rotationUserIds)) {
      return 'Every task in a rotation group must use the same ordered member list.';
    }
    if (!sameRecurrenceDateAnchor(peer, { start_date: startDate, due_date_offset_days: dueDateOffset })) {
      return 'Every task in a rotation group must use the same relative start and due schedule.';
    }
    if (peer.recurrence_rule !== recurrenceRule
        || Number(peer.recurrence_from_completion || 0) !== Number(recurrenceFromCompletion ? 1 : 0)
        || (peer.due_date ?? null) !== (dueDate ?? null)
        || (peer.due_time ?? null) !== (dueTime ?? null)) {
      return 'Every task in a rotation group must use the same recurrence schedule and due time.';
    }
    if (Number(peer.rotation_slot || 0) === rotationSlot) {
      return 'That position is already used in this rotation group.';
    }
  }
  return null;
}

function sameRecurrenceDateAnchor(left, right) {
  const leftOffset = left.due_date_offset_days ?? null;
  const rightOffset = right.due_date_offset_days ?? null;
  // Legacy cohorts have always allowed different lead-in Start Dates. Only
  // relative occurrences introduce a Start Date recurrence anchor to compare.
  return leftOffset === null && rightOffset === null
    || leftOffset === rightOffset && (left.start_date ?? null) === (right.start_date ?? null);
}

function roundRobinConfigError(d, { assignmentMode, isRecurring, recurrenceRule, parentTaskId, rotationUserIds }) {
  if (assignmentMode !== 'round_robin') return null;
  if (parentTaskId) return 'Round-robin assignment is only available for top-level tasks.';
  if (!isRecurring || !recurrenceRule) return 'Round-robin assignment requires a recurring task.';
  if (rotationUserIds.length < 2) return 'Round-robin assignment requires at least two household members.';
  const placeholders = rotationUserIds.map(() => '?').join(',');
  const found = d.prepare(`SELECT COUNT(*) AS n FROM users WHERE id IN (${placeholders})`).get(...rotationUserIds).n;
  if (found !== rotationUserIds.length) return 'Round-robin assignment contains an unknown household member.';
  return null;
}

function syncHousekeepingPaymentStatus(d, taskId, status) {
  const table = d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'housekeeping_work_sessions'").get();
  if (!table) return;
  d.prepare(`
    UPDATE housekeeping_work_sessions
    SET paid_at = CASE
      WHEN ? = 'done' THEN COALESCE(paid_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      ELSE NULL
    END
    WHERE payment_task_id = ?
  `).run(status, taskId);
}

/** Alle Subtasks einer Aufgabe laden (eine Ebene tief). */
/**
 * Darf `me` diese Aufgabe ueberhaupt sehen? Genau die Bedingung, die jede
 * Leseabfrage schon anlegt - hier fuer die schreibenden Routen, die sie nie
 * hatten: PUT und DELETE luden die Zeile per id und arbeiteten darauf, ohne zu
 * fragen. Wer eine fremde ID kannte, konnte eine private Aufgabe eines anderen
 * aendern oder loeschen. Aufgefallen ueber die Unteraufgaben (#748-Review), wo
 * die Liste fremde Titel mitlieferte und die IDs damit frei Haus kamen.
 *
 * Bewusst dieselbe Regel wie beim Lesen und keine engere: wer eine Aufgabe sieht,
 * darf sie im Haushalt auch bearbeiten - das ist die bestehende Zusage des
 * Moduls. Neu ist nur, dass Unsichtbares auch unantastbar ist.
 */
function mayAccessTask(task, me) {
  return !!task && taskCapabilities(db.get(),me,task).view;
}

/**
 * Die Aufgabe, deren Sperre hier gilt - sie selbst, ihre Elternaufgabe, oder
 * null, wenn nichts gesperrt ist (#830).
 *
 * Eine Unteraufgabe erbt die Sperre ihrer Elternaufgabe. Sie ist ein
 * Checklistenpunkt und damit Teil derselben Anweisung: waeren die Punkte frei
 * aenderbar, waere die Sperre der Elternaufgabe wertlos, weil sich "vor dem
 * Abendessen" einfach eine Ebene tiefer umschreiben liesse.
 */
function lockingTask(task) {
  if (!task) return null;
  if (task.locked) return task;
  if (!task.parent_task_id) return null;
  const parent = db.get().prepare('SELECT id, locked, created_by FROM tasks WHERE id = ?')
    .get(task.parent_task_id);
  return parent && parent.locked ? parent : null;
}

/** Admin - hier lokal, weil die Regel in der Route wohnt und nicht in einer Middleware. */
function isAdmin(req) { return req.authRole === 'admin' || req.session?.role === 'admin'; }

/**
 * Darf diese Person die DEFINITION der Aufgabe aendern oder sie loeschen? (#830)
 *
 * Gesperrt heisst nicht unsichtbar und nicht unantastbar: Ansehen, Abhaken,
 * Kommentieren, die eigene Erinnerung und die eigene Zuweisung bleiben fuer
 * alle offen. Zu ist nur, was die Aufgabe zu dem macht, was sie ist.
 *
 * Berechtigt sind Ersteller:in und Admins - bewusst NICHT abgeleitet aus
 * `family_role`: die Rolle sagt, wer jemand ist, nicht was er darf, und
 * "Elternteil" ist dort kein einzelner Wert. Siehe Migration v155.
 */
function mayEditTaskDefinition(task, req) {
  const lock = lockingTask(task);
  if (!lock) return true;
  if (isAdmin(req)) return true;
  return lock.created_by === (req.authUserId || req.session?.userId);
}

const LOCKED_ERROR = { error: 'This task is locked; only its creator and administrators can change it.', code: 403 };

/**
 * Aufgaben-IDs, deren Definition diese Person anfassen darf - fuer die
 * Sammeloperationen, die nicht eine Aufgabe meinen, sondern viele (#830).
 *
 * Eine gesperrte Aufgabe wird dort UEBERSPRUNGEN statt den ganzen Aufruf
 * abzuweisen: ein Tag ueber 40 Aufgaben umzubenennen, von denen eine gesperrt
 * ist, soll die anderen 39 nicht blockieren. Was wegfiel, steht in der Antwort.
 */
function editableTaskIds(ids, req) {
  if (!ids.length) return ids;
  const rows = db.get().prepare(
    `SELECT id, locked, created_by, parent_task_id FROM tasks WHERE id IN (${ids.map(() => '?').join(',')})`
  ).all(...ids);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.filter((id) => {
    const row = byId.get(id);
    return !!row && mayEditTaskDefinition(row, req) && taskCapabilities(db.get(),req,row).change_category_tags;
  });
}

/** Wertevergleich fuer den Definitionsabgleich: NULL, '' und 0 bleiben unterscheidbar. */
function sameFieldValue(a, b) {
  return String(a ?? '') === String(b ?? '');
}

function loadSubtasks(taskId, me, supervisionViews) {
  // Eine Unteraufgabe trägt eine eigene Sichtbarkeit (POST nimmt das Feld
  // entgegen). Sie hing hier noch nie an der Regel: unter einer geteilten
  // Elternaufgabe wurde eine private Unteraufgabe samt Titel ausgeliefert.
  // Mit den Tags käme deren Freitext dazu.
  const rows = db.get().prepare(`
    SELECT t.*, u.display_name AS assigned_name, u.avatar_color AS assigned_color,
      u.avatar_data AS assigned_avatar, ${ASSIGNED_USERS_SQL}
    FROM tasks t
    LEFT JOIN users u ON t.assigned_to = u.id
    WHERE t.parent_task_id = ?
      AND ${taskVisibilityWhere(db.get(), me, 't', '@me')}
    ORDER BY t.sort_order, t.created_at, t.id
  `).all(taskId, { me }).map(addAssignedUsers);
  // Unteraufgaben sind Aufgaben und können Tags tragen - über den CalDAV-Spiegel
  // bekommen sie welche, ohne dass jemand sie hier vergibt. Ohne das Anhängen
  // wären sie in der Antwort einfach nicht da, und ein PUT auf Basis dieser
  // Zeile schriebe sie still weg.
  const parentRevision = db.get().prepare('SELECT revision FROM tasks WHERE id=?').get(taskId)?.revision;
  for (const row of rows) row.parent_revision = parentRevision;
  attachTaskCapabilities(db.get(),me,rows);
  attachTaskLocations(db.get(),rows);
  for(const row of rows)attachTripTaskProjection(db.get(),row,me);
  attachTaskSupervision(db.get(),rows,me,supervisionViews);
  return attachTags(rows);
}

const rotationReadCacheKey = Symbol('taskRotationReadCache');
const legacyGroupReadCacheKey = Symbol('legacyGroupReadCache');
const legacyGroupByIdCacheKey = Symbol('legacyGroupByIdCache');
export function hydrateTask(task, me, supervisionViews = new Map(), starts = null) {
  if (!task) return task;
  // The list query knows whether any structural child exists, including
  // archived or privately hidden children. Only a definite zero can skip the
  // detail child projection; other callers continue to read it normally.
  const noChildren = task.has_any_children === 0;
  task = db.get().prepare(`SELECT t.*,u.display_name AS assigned_name,u.avatar_color AS assigned_color,
    u.avatar_data AS assigned_avatar,${ASSIGNED_USERS_SQL}
    FROM tasks t LEFT JOIN users u ON u.id=t.assigned_to WHERE t.id=?`).get(task.id);
  if(task.rotation_group||task.assignment_group_json){
    const savedGroupId=task.assignment_group_json?Number(JSON.parse(task.assignment_group_json)?.group_id):null;
    if(!supervisionViews.has(legacyGroupReadCacheKey))
      supervisionViews.set(legacyGroupReadCacheKey,hasCapability(db.get(),me,'rotations.view')
        ?mappedLegacyRotationGroups(db.get()):new Map());
    if(savedGroupId&&!supervisionViews.has(legacyGroupByIdCacheKey))
      supervisionViews.set(legacyGroupByIdCacheKey,new Map([...supervisionViews.get(legacyGroupReadCacheKey).values()]
        .map(group=>[Number(group.group_id),group])));
    const legacyGroup=task.rotation_group?supervisionViews.get(legacyGroupReadCacheKey)?.get(task.rotation_group.replace(/[A-Z]/g,letter=>letter.toLowerCase())):null;
    task.legacy_rotation_group=legacyGroup?{group_id:legacyGroup.group_id,compatibility_mode:legacyGroup.compatibility_mode,
      name:legacyGroup.name,slot:Number(task.rotation_slot||0)+1}:null;
    const savedImported=savedGroupId?supervisionViews.get(legacyGroupByIdCacheKey).get(savedGroupId):null;
    task.legacy_assignment_group=savedImported?{group_id:savedImported.group_id,name:savedImported.name,
      compatibility_mode:savedImported.compatibility_mode}:null;
  }
  const offer=taskOfferState(db.get(),me,task,{starts});
  addAssignedUsers(task);
  task.subtasks=noChildren?[]:loadSubtasks(task.id,me,supervisionViews);
  for(const child of task.subtasks)Object.assign(child,assigneePolicyProjection(db.get(),child.id));
  if(task.parent_task_id)task.parent_revision=db.get().prepare('SELECT revision FROM tasks WHERE id=?').get(task.parent_task_id)?.revision;
  attachTags([task]);attachTaskCapabilities(db.get(),me,[task]);attachTaskSupervision(db.get(),[task],me,supervisionViews);
  Object.assign(task,seriesMetadata(db.get(),task.id));
  if(!supervisionViews.has(rotationReadCacheKey))supervisionViews.set(rotationReadCacheKey,new Map());
  const rotationCache = supervisionViews.get(rotationReadCacheKey);
  for (const row of [task,...task.subtasks]) {
    row.rotations = taskRotationContexts(db.get(),row,me,rotationCache);
    row.rotation_bindings = rotationCache.get(`permission:${me}`)===false?[]:parseRotationBindings(row.rotation_bindings_json);
    row.rotation_bindings_json=undefined;
  }
  task.permissions.edit_series=!!task.recurrence_series_id&&task.permissions.edit&&task.permissions.change_dates;
  task.can_skip_occurrence=Boolean(task.permissions.skip_occurrence && !task.archived_at
    && ['open','in_progress','expired'].includes(task.status) && !task.parent_task_id && task.is_recurring
    && !taskSkipUnsupportedReason(db.get(),task));
  task.can_close_incomplete=Boolean(task.permissions.close_incomplete&&!task.archived_at
    &&['open','in_progress'].includes(task.status)&&!task.parent_task_id&&!taskCloseUnsupportedReason(db.get(),task));
  const closure=db.get().prepare('SELECT first_closed_at,recurrence_handled FROM task_incomplete_closures WHERE task_id=?').get(task.id);
  task.incomplete_closure=closure?{first_closed_at:closure.first_closed_at,recurrence_handled:!!closure.recurrence_handled}:null;
  task.can_reopen_incomplete=Boolean(task.permissions.close_incomplete&&!task.archived_at&&task.status==='closed_incomplete'&&closure);
  for(const row of [task,...task.subtasks])if(row.supervision) {
    // A shared parent does not expose a separately private child's title.
    let actions=row.supervision.actions.filter(action=>mayAccessTask(
      db.get().prepare('SELECT * FROM tasks WHERE id=?').get(action.action_task_id),me));
    const hiddenScope=actions.length!==row.supervision.actions.length;
    if(hiddenScope) actions=actions.map(action=>({...action,
      reason:action.completed ? 'Historical supervision is recorded for this completed action.'
        : action.state==='not_required' ? 'This action does not currently require supervision.'
        : `This action ${action.execution_mode==='delegated'?'must be performed by the helper':'requires supervision'} for ${action.required_skills.map(skill=>skill.name).join(', ')}. One supervisor must cover the Task’s entire remaining helper scope.`,
      supervisor_explanations:[],blocked_requirements:[]}));
    const active=actions.filter(action=>!action.completed&&action.state!=='not_required');
    row.supervision={...row.supervision,actions,can_view_support:!!row.supervision.support_task_id&&mayAccessTask(
      db.get().prepare('SELECT * FROM tasks WHERE id=?').get(row.supervision.support_task_id),me),
      state:active.some(action=>action.state==='excluded')?'excluded'
      :active.some(action=>action.state==='unresolved')?'needed':active.length?'assigned':'none'};
    if(hiddenScope) {
      const reason=active.length ? 'One supervisor must cover the Task’s entire remaining supervised scope. Some requirements are not visible to you; ask the creator or a household administrator for help.' : null;
      row.supervision={...row.supervision,blocked_requirements:[],supervisor_explanations:[],reason,display_reason:reason};
    }
    if(actions.length===0)row.supervision={...row.supervision,state:'none',reason:null,display_reason:null};
    // The convenience projection must use the same sanitized objects; keeping
    // attachTaskSupervision's original reference would leak aggregate reasons.
    row.supervision_action=row.supervision.actions.find(action=>action.action_task_id===row.id||action.counterpart_task_id===row.id)||null;
  }
  attachTaskActivityBindings(db.get(),[task]);attachTaskLocations(db.get(),[task]);attachTaskActionLinks([task]);
  const isSupport=task.supervision?.support_task_id===task.id;
  const structural=task.subtasks.filter(child=>!child.archived_at&&(isSupport||!child.is_supervision_projection));
  const operational=structural.filter(child=>!child.is_optional&&(isSupport||!child.is_delegated_action));
  task.subtask_total=operational.length;task.subtask_done=operational.filter(child=>child.status==='done').length;
  task.waiting_on_helper=!isSupport && !['done','expired','skipped','closed_incomplete'].includes(task.status)
    && operational.every(child=>child.status==='done')
    && (structural.some(child=>!child.is_optional&&child.is_delegated_action&&child.status!=='done')
      || task.supervision_action?.action_task_id===task.id && task.supervision_action?.state!=='not_required');
  task.is_offer=offer.visible;
  task.offer_reason=offer.reason;
  task.permissions.accept=offer.claimable;
  attachTripTaskProjection(db.get(),task,me);
  const scoringIds=[task.id,...task.subtasks.filter(row=>!row.is_supervision_projection).map(row=>row.id)];
  attachScoring(task,me,scoringIds,true);
  for(const child of task.subtasks)attachScoring(child,me,[child.id]);
  attachTaskHelperViewMetadata(db.get(),[task,...task.subtasks]);
  // An unfinished helper container shares its source's closed window without
  // rewriting its physical checkbox/progress records.
  if(task.is_supervision_projection&&task.status!=='done') {
    const closed=taskWindowAncestors(db.get(),task.id).find(row=>row.status==='closed_incomplete');
    if(closed){task.status='closed_incomplete';task.closed_incomplete_at=closed.closed_incomplete_at;}
  }
  return task;
}

/**
 * Tags dürfen fehlen oder ein Array/kommaseparierter String sein. Zahl und Länge
 * begrenzt normalizeTags still - abgelehnt wird nur, was gar keine Tag-Liste ist,
 * damit ein Tippfehler im Client nicht als leere Liste durchgeht und die
 * vorhandenen Tags löscht.
 */
function validateTags(value) {
  if (value === undefined || value === null) return {};
  if (Array.isArray(value) || typeof value === 'string') return {};
  return { error: 'tags must be an array or a comma-separated string.' };
}

/**
 * Eingabe-Validierung für Task-Felder (zentralisiert über validate.js).
 *
 * `currentRule` ist die gespeicherte Wiederholungsregel beim Aktualisieren. Kommt
 * sie unverändert zurück, entfällt ihre Prüfung: Sie steht bereits so in der
 * Datenbank, und der Validator kennt nur das Vokabular dieser Oberfläche. Eine
 * per CalDAV eingelesene Aufgabe (#617) trägt regelmäßig mehr - Präfix, WKST,
 * BYMONTHDAY - und ohne die Ausnahme scheiterte jede Änderung an einem anderen
 * Feld an einer Regel, die niemand angefasst hat (#756, Kalender-Gegenstück).
 */
function validateTaskInput(body, isCreate = true, currentRule = undefined) {
  if(body.card_color_choice!==undefined){try{validateCardColorChoice(body.card_color_choice);}catch(error){return[error.message];}}
  const ruleUnchanged = !isCreate
    && body.recurrence_rule !== undefined
    && body.recurrence_rule === currentRule;
  return v.collectErrors([
    v.str(body.title,       'title',       { required: isCreate }),
    v.str(body.description, 'description', { required: false, max: v.MAX_TEXT }),
    v.oneOf(body.priority,  VALID_PRIORITIES, 'priority'),
    v.oneOf(body.status,    VALID_STATUSES,   'status'),
    v.oneOf(body.assignment_mode, VALID_ASSIGNMENT_MODES, 'assignment_mode'),
    v.oneOf(body.category,  validTaskCategoryKeys(), 'category'),
    v.date(body.start_date, 'start_date'),
    v.date(body.due_date,   'due_date'),
    v.time(body.due_time,   'due_time'),
    v.time(body.start_time, 'start_time'),
    v.oneOf(body.expiration_policy, EXPIRATION_POLICIES, 'expiration_policy'),
    v.oneOf(body.is_optional, [true,false,0,1], 'is_optional'),
    ruleUnchanged ? {} : v.rrule(body.recurrence_rule, 'recurrence_rule'),
    v.num(body.points,      'points'),
    validateTags(body.tags),
  ]);
}

function validateTaskWindow(task) {
  if(!EXPIRATION_POLICIES.includes(task.expiration_policy))return 'Choose a valid expiration policy.';
  if(task.start_time && !task.start_date)return 'Start Time requires a Start Date.';
  if(task.expiration_policy==='expire_incomplete' && !task.due_date)return 'Expire incomplete requires a Due Date.';
  const start=taskStartMs(db.get(),task),deadline=taskDeadlineMs(db.get(),task);
  if((task.start_time||task.expiration_policy==='expire_incomplete')&&start!=null&&deadline!=null&&start>=deadline)return 'Due Time must be after the Task start.';
  return null;
}

// --------------------------------------------------------
// Kategorie-Verwaltung (#494, #357)
// Statische /categories-Pfade MÜSSEN vor den dynamischen /:id-Routen stehen,
// sonst matcht Express „categories" als :id.
// --------------------------------------------------------

// GET /api/v1/tasks/categories → { data: TaskCategory[] }
router.get('/categories', (_req, res) => {
  try {
    res.json({ data: loadTaskCategories() });
  } catch (err) {
    if (err.status && typeof res !== 'undefined') return res.status(err.status).json({ error: err.message, code: err.status, ...err.details });
    log.error('GET /categories error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// GET /api/v1/tasks/sync-targets (#695)
// → { data: { caldav: [{ accountId, accountName, listUrl, listName }] } }
//
// Die Auswahlliste des "Sync-Ziel"-Feldes im Aufgaben-Dialog, nach dem Vorbild
// von /calendar/sync-targets (#618): für ALLE angemeldeten Nutzer, und nur das,
// was das Dropdown braucht. Keine Server-URLs, keine Zugangsdaten - die
// Kontenverwaltung bleibt admin-only.
//
// Angeboten wird ausschließlich, was der Haushalt für Aufgaben freigegeben hat.
// Eine Liste, die auf den Einkauf zeigt, gehört nicht in dieses Feld: eine
// Aufgabe dorthin zu schieben hieße, sie als Einkaufsposten zurückzubekommen.
// Muss wie /categories vor den /:id-Routen stehen, sonst matcht „sync-targets" als :id.
// --------------------------------------------------------
router.get('/sync-targets', (_req, res) => {
  try {
    const caldav = db.get().prepare(`
      SELECT s.account_id AS accountId, a.name AS accountName,
             s.list_url   AS listUrl,   s.list_name AS listName
        FROM caldav_reminder_selection s
        JOIN caldav_accounts a ON a.id = s.account_id
       WHERE s.enabled = 1 AND s.target_module = 'tasks'
       ORDER BY a.name, s.list_name
    `).all();
    res.json({ data: { caldav } });
  } catch (err) {
    if (err.status && typeof res !== 'undefined') return res.status(err.status).json({ error: err.message, code: err.status, ...err.details });
    log.error('GET /sync-targets error:', err);
    res.status(500).json({ error: 'Failed to list sync targets.', code: 500 });
  }
});

// --------------------------------------------------------
// GET /api/v1/tasks/completions
// Der Verlauf der erledigten Aufgaben, neueste zuerst (#791).
// Query: limit? (1..200, Default 50), user_id?, before_at? + before_id? (Cursor)
// Response: { data: [Eintrag], has_more, next_cursor }
//
// Muss wie /categories und /tags vor den /:id-Routen stehen, sonst matcht
// „completions" als :id.
//
// Kein Datumsbereich in der Abfrage: welcher Kalendertag ein Zeitpunkt ist,
// entscheidet die Anzeigezone (public/utils/timezone.js), und die liest die
// Oberfläche. Der Server liefert Zeitpunkte und blättert über einen Cursor;
// gruppiert wird dort, wo die Uhr steht.
// --------------------------------------------------------
router.get('/completions', (req, res) => {
  try {
    const me = req.authUserId || req.session.userId;
    const { entries, hasMore } = occurrenceFeed(db.get(), {
      me,
      limit: req.query.limit,
      userId: req.query.user_id ? Number(req.query.user_id) : null,
      beforeAt: req.query.before_at || null,
      beforeId: req.query.before_id || null,
    });
    const last = entries[entries.length - 1];
    res.json({
      data: entries,
      has_more: hasMore,
      // Der Cursor kommt vom Server, damit die Oberfläche nicht wissen muss,
      // woraus er sich zusammensetzt - er ist ein Paar, kein Zeitstempel.
      next_cursor: hasMore && last ? { before_at: last.occurred_at, before_id: last.id } : null,
    });
  } catch (err) {
    if (err.status && typeof res !== 'undefined') return res.status(err.status).json({ error: err.message, code: err.status, ...err.details });
    log.error('GET /completions error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// GET /api/v1/tasks/tags → { data: [{ tag, count }] }
// Die sichtbaren Tags für Filterleiste und Vorschläge (#586). Anders als
// Kategorien gibt es keine Registry - die Liste ergibt sich aus dem Bestand,
// und zwar aus dem Teil davon, den die fragende Person sehen darf: ein Tag ist
// Freitext und verriete sonst den Inhalt einer privaten Aufgabe (#474).
// Muss wie /categories vor den /:id-Routen stehen, sonst matcht „tags" als :id.
router.get('/tags', (req, res) => {
  try {
    res.json({ data: allTags(db.get(), req.authUserId || req.session.userId) });
  } catch (err) {
    if (err.status && typeof res !== 'undefined') return res.status(err.status).json({ error: err.message, code: err.status, ...err.details });
    log.error('GET /tags error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * Merkt geänderte Aufgaben für den CalDAV-Push vor und stößt ihn an (#586).
 * Die Tags reisen als kanonischer Schlüssel mit: sie liegen in task_tags, der
 * Feldvergleich in markTodoOutbound sieht aber nur die Zeile selbst.
 */
function pushTagChanges(changed, what) {
  if (!changed.length) return;
  const rows = db.get().prepare(
    `SELECT * FROM tasks WHERE id IN (${changed.map(() => '?').join(',')})`
  ).all(...changed.map((c) => c.id));
  const byId = new Map(rows.map((r) => [r.id, r]));

  let pending = 0;
  for (const { id, before, after } of changed) {
    const row = byId.get(id);
    if (!row) continue;
    if (markTodoOutbound('tasks',
      { ...row, tags_key: tagsKey(before) },
      { ...row, tags_key: tagsKey(after) })) pending++;
  }
  if (pending) pushToCalDAV(what);
}

/** Aus einer Liste von IDs die, die `me` sehen darf. */
function visibleTaskIds(ids, me) {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.get().prepare(`
    SELECT t.id AS id FROM tasks t
    WHERE t.id IN (${placeholders})
      AND ${taskVisibilityWhere(db.get(),me,'t','@me')}
  `).all(...ids, { me }).map((r) => r.id);
}

// Obergrenze für eine Bulk-Vergabe. Die Auswahl entsteht per Hand in der Liste,
// alles darüber ist ein Skript - und ein Skript soll die Aufgaben einzeln
// anfassen statt einen Sync-Lauf mit einem Schlag zu füllen.
const MAX_BULK_TASKS = 500;

// POST /api/v1/tasks/tags/apply  Body: { ids, add?, remove? }
// Vergibt oder entfernt Tags an mehreren Aufgaben auf einmal (#586). Eigener
// Endpunkt statt einer Schleife über PUT /:id im Client: zum Anhängen müsste der
// Client jede Aufgabe erst lesen, die Liste mischen und die ganze Aufgabe
// zurückschreiben - und überschriebe dabei jede parallele Änderung.
router.post('/tags/apply', (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
    if (!ids.length)
      return res.status(400).json({ error: 'ids must be a non-empty array of task IDs.', code: 400 });
    if (ids.length > MAX_BULK_TASKS)
      return res.status(400).json({ error: `At most ${MAX_BULK_TASKS} tasks at a time.`, code: 400 });

    const errors = v.collectErrors([validateTags(req.body.add), validateTags(req.body.remove)]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const add    = normalizeTags(req.body.add ?? []);
    const remove = normalizeTags(req.body.remove ?? []);
    if (!add.length && !remove.length)
      return res.status(400).json({ error: 'Nothing to add or remove.', code: 400 });

    const me = req.authUserId || req.session.userId;
    // Gesperrte Aufgaben fallen aus der Auswahl (#830), statt den ganzen Aufruf
    // abzuweisen: 40 Aufgaben zu taggen, von denen eine gesperrt ist, soll die
    // anderen 39 nicht kosten. Was wegfiel, steht als `skipped` in der Antwort -
    // eine stille Teilausfuehrung waere schlimmer als ein Fehler.
    const targets = visibleTaskIds(ids, me);
    const allowed = editableTaskIds(targets, req);
    const changed = db.get().transaction(() =>
      applyTagChanges(db.get(), { taskIds: allowed, add, remove }))();

    res.json({ data: { updated: changed.length, skipped: targets.length - allowed.length, tags: allTags(db.get(), me) } });
    pushTagChanges(changed, 'Tag-Vergabe');
  } catch (err) {
    if (err.status && typeof res !== 'undefined') return res.status(err.status).json({ error: err.message, code: err.status, ...err.details });
    log.error('POST /tags/apply error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// PUT /api/v1/tasks/tags/:tag  Body: { name }
// Benennt einen Tag auf allen sichtbaren Aufgaben um. Zielt der neue Name auf
// einen vorhandenen Tag, führt das die beiden zusammen - das ist gewollt und der
// übliche Weg, ein versehentliches Duplikat einzusammeln.
router.put('/tags/:tag', (req, res) => {
  try {
    // Als Array-Element, nicht als String: die String-Form von normalizeTags
    // trennt am Komma, und ein Umbenennen auf "Haus, Hof" behielte nur "Haus" -
    // bei gemeldetem Erfolg. Denselben Fehler hatte der Filter eine Funktion
    // weiter oben.
    const [to] = normalizeTags([req.body.name ?? '']);
    if (!to) return res.status(400).json({ error: 'name must be a non-empty tag.', code: 400 });

    const me = req.authUserId || req.session.userId;
    if (!taskIdsWithTag(db.get(), req.params.tag, me).length)
      return res.status(404).json({ error: 'Tag not found.', code: 404 });

    // Umbenennen fasst jede Aufgabe an, die den Tag traegt - auch die
    // gesperrten. Die bleiben aussen vor (#830); der alte Name haelt sich dort
    // also, und das ist die ehrliche Auskunft: geaendert wurde, was geaendert
    // werden durfte.
    const affected = [...new Set([
      ...taskIdsWithTag(db.get(), req.params.tag, me),
      ...taskIdsWithTag(db.get(), to, me),
    ])];
    const allowed = editableTaskIds(affected, req);
    const changed = db.get().transaction(() =>
      renameTag(db.get(), { from: req.params.tag, to, me, ids: allowed }))();

    res.json({ data: { updated: changed.length, skipped: affected.length - allowed.length, tag: to, tags: allTags(db.get(), me) } });
    pushTagChanges(changed, 'Tag-Umbenennung');
  } catch (err) {
    if (err.status && typeof res !== 'undefined') return res.status(err.status).json({ error: err.message, code: err.status, ...err.details });
    log.error('PUT /tags/:tag error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// DELETE /api/v1/tasks/tags/:tag
// Nimmt den Tag von allen sichtbaren Aufgaben. Anders als bei Kategorien gibt es
// keine 409-Sperre "noch in Benutzung": ein Tag IST nur seine Verwendungen, und
// ihn zu löschen heißt genau, sie zu lösen. Die Aufgaben selbst bleiben.
router.delete('/tags/:tag', (req, res) => {
  try {
    const me = req.authUserId || req.session.userId;
    const affected = taskIdsWithTag(db.get(), req.params.tag, me);
    if (!affected.length)
      return res.status(404).json({ error: 'Tag not found.', code: 404 });

    // Wie beim Umbenennen: an gesperrten Aufgaben bleibt der Tag haengen (#830).
    const allowed = editableTaskIds(affected, req);
    const changed = db.get().transaction(() =>
      removeTagEverywhere(db.get(), { tag: req.params.tag, me, ids: allowed }))();

    res.json({ data: { updated: changed.length, skipped: affected.length - allowed.length, tags: allTags(db.get(), me) } });
    pushTagChanges(changed, 'Tag-Löschung');
  } catch (err) {
    if (err.status && typeof res !== 'undefined') return res.status(err.status).json({ error: err.message, code: err.status, ...err.details });
    log.error('DELETE /tags/:tag error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// POST /api/v1/tasks/categories  Body: { name } → { data: TaskCategory }
router.post('/categories', (req, res) => {
  try {
    const maxAssignees=Object.hasOwn(req.body,'max_assignees')?parseCategoryAssigneeLimit(req.body.max_assignees):null;
    const vName = v.str(req.body.name, 'Name', { max: v.MAX_SHORT });
    if (vName.error) return res.status(400).json({ error: vName.error, code: 400 });

    const conflict = db.get().prepare(`
      SELECT key FROM task_categories WHERE COALESCE(name, key) = ? COLLATE NOCASE
    `).get(vName.value);
    if (conflict) return res.status(409).json({ error: 'Category already exists.', code: 409, reason: 'category_exists' });

    const maxOrder = db.get().prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM task_categories').get().m;
    const key = uniqueKey(db.get(), 'task_categories', vName.value);
    db.get().prepare(
      'INSERT INTO task_categories (key, name, label_key, sort_order, max_assignees) VALUES (?, ?, NULL, ?, ?)'
    ).run(key, vName.value, maxOrder + 1,maxAssignees);

    const cat = db.get().prepare('SELECT key, name, label_key, sort_order, max_assignees FROM task_categories WHERE key = ?').get(key);
    res.status(201).json({ data: cat });
  } catch (err) {
    if (err.status && typeof res !== 'undefined') return res.status(err.status).json({ error: err.message, code: err.status, ...err.details });
    log.error('POST /categories error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// PATCH /api/v1/tasks/categories/reorder  Body: { order: string[] }
router.patch('/categories/reorder', (req, res) => {
  try {
    const order = Array.isArray(req.body.order) ? req.body.order : [];
    const update = db.get().prepare('UPDATE task_categories SET sort_order = ? WHERE key = ?');
    db.get().transaction(() => order.forEach((key, i) => update.run(i, key)))();
    res.json({ data: loadTaskCategories() });
  } catch (err) {
    if (err.status && typeof res !== 'undefined') return res.status(err.status).json({ error: err.message, code: err.status, ...err.details });
    log.error('PATCH /categories/reorder error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// PUT /api/v1/tasks/categories/:key  Body: { name } → benennt um (Key bleibt stabil,
// label_key wird gelöscht → der Custom-Name gilt fortan).
router.put('/categories/:key', (req, res) => {
  try {
    const cat = db.get().prepare('SELECT * FROM task_categories WHERE key = ?').get(req.params.key);
    if (!cat) return res.status(404).json({ error: 'Category not found.', code: 404 });

    const maxAssignees=Object.hasOwn(req.body,'max_assignees')?parseCategoryAssigneeLimit(req.body.max_assignees):cat.max_assignees;
    const rename=Object.hasOwn(req.body,'name');
    if(!rename&&!Object.hasOwn(req.body,'max_assignees'))return res.status(400).json({error:'Choose a name or assignee limit.',code:400});
    const vName = rename?v.str(req.body.name, 'Name', { max: v.MAX_SHORT }):{value:cat.name};
    if (vName.error) return res.status(400).json({ error: vName.error, code: 400 });

    const conflict = db.get().prepare(`
      SELECT key FROM task_categories WHERE COALESCE(name, key) = ? COLLATE NOCASE AND key != ?
    `).get(vName.value, cat.key);
    if (rename&&conflict) return res.status(409).json({ error: 'Category already exists.', code: 409, reason: 'category_exists' });

    db.get().prepare('UPDATE task_categories SET name=?, label_key=?, max_assignees=? WHERE key=?').run(vName.value,rename?null:cat.label_key,maxAssignees,cat.key);
    const updated = db.get().prepare('SELECT key, name, label_key, sort_order, max_assignees FROM task_categories WHERE key = ?').get(cat.key);
    res.json({ data: updated });
  } catch (err) {
    if (err.status && typeof res !== 'undefined') return res.status(err.status).json({ error: err.message, code: err.status, ...err.details });
    log.error('PUT /categories/:key error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// DELETE /api/v1/tasks/categories/:key → 409 wenn in Benutzung oder letzte Kategorie.
router.delete('/categories/:key', (req, res) => {
  try {
    const cat = db.get().prepare('SELECT * FROM task_categories WHERE key = ?').get(req.params.key);
    if (!cat) return res.status(404).json({ error: 'Category not found.', code: 404 });

    const inUse = taskCategoryInUseCount(cat.key);
    if (inUse > 0) {
      return res.status(409).json({ error: `Category is in use by ${inUse} task${inUse === 1 ? '' : 's'}.`, code: 409, count: inUse, reason: 'category_in_use' });
    }
    const total = db.get().prepare('SELECT COUNT(*) AS n FROM task_categories').get().n;
    if (total <= 1) return res.status(409).json({ error: 'Cannot delete the last category.', code: 409, reason: 'category_last' });

    db.get().prepare('DELETE FROM task_categories WHERE key = ?').run(cat.key);
    res.status(204).end();
  } catch (err) {
    if (err.status && typeof res !== 'undefined') return res.status(err.status).json({ error: err.message, code: err.status, ...err.details });
    log.error('DELETE /categories/:key error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// GET /api/v1/tasks
// Listet Top-Level-Aufgaben mit optionalen Filtern.
// Query-Parameter: status, priority, assigned_to, category, archived
// Response: { data: Task[] }  (jede Task enthält subtask_progress)
// --------------------------------------------------------
router.get('/', (req, res) => {
  try {
    const me = req.authUserId || req.session.userId;
    if(req.query.offers==='1'){
      const payload=withTaskReadSnapshot(db.get(),me,()=>{
        const candidates=listTaskOffers(db.get(),req,{includeFuture:true,query:req.query});
        const starts=taskStartProjection(db.get(),{tasks:candidates});
        const hydrated=candidates.filter(starts.visible).slice(0,500).map(task=>hydrateTask(task,me,new Map(),starts));
        return {data:hydrated.map(starts.project),visibility:starts.metadata([...candidates,...hydrated])};
      });
      return res.set('Cache-Control','private, no-store').json(payload);
    }
    const payload = withTaskReadSnapshot(db.get(),me,()=>{
    const { status, priority, assigned_to, category, tag, include_future, archived } = req.query;

    let sql = `
      SELECT
        t.*,
        u.display_name AS assigned_name,
        u.avatar_color AS assigned_color,
        u.avatar_data AS assigned_avatar,
        ${ASSIGNED_USERS_SQL},
        EXISTS(SELECT 1 FROM tasks child WHERE child.parent_task_id=t.id) AS has_any_children,
        -- Unteraufgaben tragen eine EIGENE Sichtbarkeit, und diese Liste hing nie
        -- an ihr: unter einer geteilten Elternaufgabe lief eine private
        -- Unteraufgabe samt Titel mit, und Zähler wie Fortschrittsbalken zählten
        -- sie mit. loadSubtasks() (Detailansicht) filtert seit jeher richtig -
        -- dieselbe Regel fehlte hier. Ohne den Filter zeigt die Zeile fremde
        -- private Titel und bietet Aktionen darauf an.
        (SELECT COUNT(*) FROM tasks s WHERE s.parent_task_id = t.id AND s.archived_at IS NULL AND s.is_optional=0
           AND ${taskVisibilityWhere(db.get(), me, 's')})                         AS subtask_total,
        (SELECT COUNT(*) FROM tasks s WHERE s.parent_task_id = t.id AND s.archived_at IS NULL AND s.is_optional=0 AND s.status = 'done'
           AND ${taskVisibilityWhere(db.get(), me, 's')})                         AS subtask_done,
        (SELECT json_group_array(json_object(
                  'id', s.id, 'title', s.title, 'description', s.description,
                  'status', s.status, 'priority', s.priority, 'is_optional', s.is_optional,
                  'due_date', s.due_date, 'due_time', s.due_time,
                  'points', s.points, 'assigned_to', s.assigned_to,
                  'assigned_name', s.assigned_name,
                  'assigned_users', json(s.assigned_users_json)
                ))
           FROM (SELECT s.id, s.title, s.description, s.status, s.priority, s.is_optional,
                        s.due_date, s.due_time, s.points, s.assigned_to,
                        su.display_name AS assigned_name,
                        (SELECT json_group_array(json_object(
                          'id', au.id, 'display_name', au.display_name,
                          'color', au.avatar_color, 'avatar_data', au.avatar_data
                        ))
                           FROM task_assignments sta
                           JOIN users au ON au.id = sta.user_id
                          WHERE sta.task_id = s.id) AS assigned_users_json
                   FROM tasks s
                   LEFT JOIN users su ON su.id = s.assigned_to
                  WHERE s.parent_task_id = t.id AND s.archived_at IS NULL
                    AND ${taskVisibilityWhere(db.get(), me, 's')}
                  ORDER BY s.created_at ASC) s) AS subtasks
      FROM tasks t
      LEFT JOIN users u ON t.assigned_to = u.id
      WHERE ${taskScopeWhere('t', { includeFuture: true, includeSupervision:true })}
    `;
    const params = [];

    // Scheduled visibility is applied below using household-local instants and
    // source/ancestor windows. Keep future candidates for authorized wakeup metadata.

    // Status, Priorität und Person nehmen mehrere Werte entgegen und verknüpfen
    // sie ODER (#671). Anders als bei den Tags unten ist das keine Geschmacks-
    // frage: eine Aufgabe trägt genau EINE Priorität, ein UND über zwei Werte
    // wäre also garantiert leer. Gemeldet wurde genau das - "medium und high
    // zugleich" ging nicht, weil jede Reihe nur einen Wert zuließ.
    // Zwischen den Gruppen bleibt es UND: jede Reihe engt weiter ein.
    // Ein einzelner Wert kommt weiterhin als String an (API-Token, Bookmarks).
    const asList = (v) => (v === undefined ? [] : [v].flat().filter((x) => x !== ''));

    // Archiv (#688): eine eigene Achse, kein Status. Ohne Zutun bleibt es
    // ausgeblendet - eine abgelegte Aufgabe soll sich wie gelöscht anfühlen und
    // nicht mit ihrem Status („offen") durch jede Liste wandern.
    //   ?archived=1     - zusätzlich zeigen (Kanban: die Ablage ist dort eine Spalte)
    //   ?archived=only  - nur das Archiv
    //   ?status=archived - für Bestandsclients und den Filterchip: das Archiv ist
    //                      dort ein Wert neben den Status. Es bleibt deshalb auch
    //                      ODER-verknüpft wie jeder andere Wert dieser Achse -
    //                      „offen und archiviert" muss beides zeigen, nicht den
    //                      Schnitt aus beidem.
    const rawStatuses  = asList(status);
    const statuses     = rawStatuses.filter((s) => s !== ARCHIVE_STATUS);
    const statusArchiv = rawStatuses.includes(ARCHIVE_STATUS);
    const archiveQuery = archived === 'only' ? 'only'
      : (archived === '1' || archived === 'true' ? 'include' : null);

    if (statuses.length && statusArchiv) {
      sql += ` AND (t.status IN (${statuses.map(() => '?').join(', ')}) OR t.archived_at IS NOT NULL)`;
      params.push(...statuses);
    } else {
      if (statuses.length) {
        sql += ` AND t.status IN (${statuses.map(() => '?').join(', ')})`;
        params.push(...statuses);
      }
      if (statusArchiv || archiveQuery === 'only') sql += ' AND t.archived_at IS NOT NULL';
      else if (!archiveQuery)                      sql += ' AND t.archived_at IS NULL';
    }

    if(!rawStatuses.length && !archiveQuery)sql += " AND t.status NOT IN ('expired','skipped')";
    if(!archiveQuery&&!rawStatuses.some(status=>['done','expired','skipped','closed_incomplete'].includes(status)))sql+=` AND ${taskUnskippedWhere(db.get())}`;

    const priorities = asList(priority);
    if (priorities.length) {
      sql += ` AND t.priority IN (${priorities.map(() => '?').join(', ')})`;
      params.push(...priorities);
    }

    const assignees = asList(assigned_to).map(Number).filter(Number.isInteger);
    if (assignees.length) {
      sql += ` AND EXISTS (SELECT 1 FROM task_assignments ta WHERE ta.task_id = t.id
                             AND ta.user_id IN (${assignees.map(() => '?').join(', ')}))`;
      params.push(...assignees);
    }
    // MEHRERE KATEGORIEN, ODER-verknüpft - dieselbe Regel wie bei Status,
    // Priorität und Person (#671), und seit #814 dasselbe Fragment wie in der
    // Übersicht. Vorher band `?category=a&category=b` das Array von Express in
    // einen einzigen Platzhalter: der zweite Wert war nicht etwa unwirksam,
    // die Abfrage kam gar nicht mehr durch.
    const categories = normalizeCategoryFilter(category);
    const categoryFragment = taskCategoryWhere('t', categories);
    if (categoryFragment) { sql += ` AND ${categoryFragment}`; params.push(...categories); }
    // Tag-Filter ohne Rücksicht auf Groß-/Kleinschreibung: die Werte kommen von
    // fremden Servern, dort ist „Garten" und „garten" dasselbe Etikett.
    //
    // Mehrere Tags verbinden sich mit UND, nicht mit ODER: jeder weitere Filter
    // in dieser Leiste engt ein (Status UND Priorität UND Person), und ein Tag,
    // der die Liste plötzlich wachsen ließe, wäre in derselben Reihe ein Bruch.
    // Jedes `tag`-Vorkommen ist genau EIN Tag, nie eine kommaseparierte Liste.
    // Der frühere CSV-Komfort war ein Fehler: Express liefert bei einem einzigen
    // `?tag=` einen String statt eines Arrays, und "Haus, Hof" - ein Tag, den
    // CATEGORIES ausdrücklich erlaubt - zerfiel dabei in zwei, sodass die Suche
    // nach ihm garantiert leer ausging.
    const tagFilters = normalizeTags(tag === undefined ? [] : [tag].flat());
    for (const value of tagFilters) {
      sql += ' AND EXISTS (SELECT 1 FROM task_tags tt WHERE tt.task_id = t.id AND tt.tag_key = ?)';
      params.push(tagKey(value));
    }

    // Sichtbarkeit (#474): eigene + für alle sichtbare + zugewiesene-sichtbare.
    sql += ` AND ${taskVisibilityWhere(db.get(), me, 't')}`;
    params.push(me, me);

    // Die drei Unteraufgaben-Subqueries oben tragen dieselbe Bedingung und damit
    // je zwei Platzhalter. Sie stehen in der SELECT-Klausel, also VOR jedem
    // anderen Platzhalter dieser Anfrage - deshalb unshift und nicht push. Die
    // SELECT-Klausel bindet sonst nichts; wer dort einen Platzhalter ergänzt,
    // muss diese Reihenfolge mitziehen.
    params.unshift(me, me, me, me, me, me);

    sql += `
      ORDER BY
        CASE t.status WHEN 'done' THEN 1 ELSE 0 END,
        CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
                        WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
        t.due_date ASC NULLS LAST,
        t.created_at DESC
    `;

    const candidates = db.get().prepare(sql).all(...params).map(task => ({ ...task, subtasks: JSON.parse(task.subtasks || '[]') })).map(addAssignedUsers);
    const startProjection = taskStartProjection(db.get(),{tasks:candidates});
    const rows = include_future ? candidates : candidates.filter(startProjection.visible);
    attachTaskActivityBindings(db.get(), rows);
    attachTaskLocations(db.get(), rows);
    attachTaskActionLinks(rows);
    const supervisionViews=new Map(); // One synchronous, read-only response.
    const hydrated = withTaskReadProjection(db.get(),me,()=>attachDocumentCounts(rows.map(row=>hydrateTask(row,me,supervisionViews,startProjection)),me));
    return { data: include_future ? hydrated : hydrated.map(startProjection.project),
      visibility:startProjection.metadata([...candidates,...hydrated],{includeFuture:!!include_future}) };
    });
    res.json(payload);
  } catch (err) {
    if (err.status && typeof res !== 'undefined') return res.status(err.status).json({ error: err.message, code: err.status, ...err.details });
    log.error('GET / error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// GET /api/v1/tasks/:id
// Einzelne Aufgabe mit Subtasks.
// Response: { data: Task & { subtasks: Task[] } }
// --------------------------------------------------------
router.get('/:id/acceptance',(req,res)=>{
  try{
    const data=withTaskReadSnapshot(db.get(),req,()=>{
      const options=acceptanceOptions(db.get(),req,Number(req.params.id),req.query.primary_user_id);
      return {...options,task:hydrateTask({id:Number(req.params.id)},req.authUserId||req.session.userId)};
    });
    res.set('Cache-Control','private, no-store').json({data});
  }catch(error){res.status(error.status||500).json({error:error.status?error.message:'Could not load acceptance options.',code:error.status||500,reason:error.reason});}
});
router.post('/:id/accept',(req,res)=>{
  try{
    const result=acceptTask(db.get(),req,Number(req.params.id),req.body);
    const data=hydrateTask({id:result.task_id},req.authUserId||req.session.userId);
    res.set('Cache-Control','private, no-store').json({data,replayed:result.replayed});
    if(!result.replayed)pushToCalDAV('Task acceptance');
  }catch(error){res.status(error.status||500).json({error:error.status?error.message:'Could not accept this Task.',code:error.status||500,reason:error.reason,...error.details});}
});
router.get('/:id', (req, res) => {
  try {
    const me = req.authUserId || req.session.userId;
    const payload = withTaskReadSnapshot(db.get(),me,()=>{
      const task = db.get().prepare(`
        SELECT t.*, u.display_name AS assigned_name, u.avatar_color AS assigned_color,
          u.avatar_data AS assigned_avatar, ${ASSIGNED_USERS_SQL}
        FROM tasks t
        LEFT JOIN users u ON t.assigned_to = u.id
        WHERE t.id = ?
          AND ${taskVisibilityWhere(db.get(), me, 't')}
      `).get(req.params.id, me, me);

      if (!task) return null;

      addAssignedUsers(task);
      attachDocumentCounts([task], me);
      // Die verknüpften Dokumente beim Namen, nicht nur gezählt (#733). Die
      // Detailansicht zeigte hier seit jeher eine Zeile „Dokumente" an, las dafür
      // aber ein Feld, das die API nie gefüllt hat - die Zeile war deshalb immer
      // leer, egal wie viele Dokumente an der Aufgabe hingen. Die Liste kommt aus
      // derselben Funktion wie GET /:id/documents, also mit derselben
      // Sichtbarkeitsprüfung.
      task.documents = loadTaskDocuments(task.id, me);
      attachTaskActivityBindings(db.get(), [task]);
      attachTaskLocations(db.get(), [task]);
      attachTaskActionLinks([task]);
      attachTags([task]);
      const data={...task,...hydrateTask(task,me)},cache=new Map();
      data.rotations=data.rotations.map(context=>({...context,recorded_completions:context.occurrence.id
        ?rotationCompletionEvidence(db.get(),context.occurrence.id,{viewer:me,cache}):[]}));
      if(data.rotations.length)data.workflow_rotation_operations=workflowRotationOperations(db.get(),task,me);
      return data;
    });
    if (!payload) return res.status(404).json({ error: 'Task not found.', code: 404 });
    res.json({data:payload});
  } catch (err) {
    if (err.status && typeof res !== 'undefined') return res.status(err.status).json({ error: err.message, code: err.status, ...err.details });
    log.error('GET /:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/:id/location/promote', requireAdmin, (req, res) => {
  try {
    const task = db.get().prepare('SELECT * FROM tasks WHERE id = ? AND parent_task_id IS NULL').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found.', code: 404 });
    assertTaskMutation(db.get(),req,task,{location:{}},{operation:'update'});
    assertTaskRevision(db.get(),task,req.body,{required:true});
    res.json({ data: promoteTaskGoogleLocation(db.get(), task.id, req.body || {}, req.authUserId || req.session.userId) });
  } catch (err) {
    if (err.status && typeof res !== 'undefined') return res.status(err.status).json({ error: err.message, code: err.status, ...err.details });
    const missing = /does not have/i.test(err.message);
    res.status(missing ? 404 : 400).json({ error: err.message, code: missing ? 404 : 400 });
  }
});

// --------------------------------------------------------
// POST /api/v1/tasks
// Neue Aufgabe erstellen.
// Body: { title, description?, category?, tags?, priority?, due_date?, due_time?,
//         assigned_to?, parent_task_id? }
// Response: { data: Task }
// --------------------------------------------------------
router.post('/template-launch/preview',(req,res)=>{
  try {res.json({data:previewTemplateLaunch(db.get(),req,req.body)});}
  catch(error){res.status(error.status||400).json({error:error.message,code:error.status||400,...error.details});}
});
router.post('/template-launch/create',(req,res)=>{
  try {
    const result=createTemplateLaunch(db.get(),req,req.body,{
      createTask(body,snapshot){
        // Reuse the single canonical creator: its nested savepoint belongs to
        // the launch transaction, including skills, scoring, recurrence and
        // notification records. A failed member aborts the entire launch.
        const childRequest=Object.create(req);childRequest.body={...body};childRequest[templateLaunchSnapshot]=snapshot;
        let status=200,response;
        createTaskDefinition(childRequest,{status(value){status=value;return this;},json(value){response=value;return this;}});
        if(status!==201||!response?.data)throw new TemplateLaunchError(response?.error||'The Activity could not be created.',status===201?500:status);
        return response.data;
      },
      hydrateTask:task=>hydrateTask(task,req.authUserId||req.session.userId),
    });
    res.status(result.replayed?200:201).json({data:result});
  }catch(error){res.status(error.status||500).json({error:error.status?error.message:'The Activity launch could not be completed.',code:error.status||500,...error.details});}
});

export function createTaskDefinition(req, res) {
  try {
    validateScoringInput(req.body);
    if(req.body.parent_task_id&&req.body.scoring_mode!==undefined)throw new TaskStateError('Choose the scoring mode on the original executable Task.',{reason:'scoring_owner_required'},400);
    const bindingRequest = parseTaskActivityBinding(req.body);
    if (bindingRequest.error) return res.status(400).json({ error: bindingRequest.error, code: 400 });
    const activityBinding = bindingRequest.binding;
    let activityDraft = null;
    if (activityBinding) {
      try {
        activityDraft = resolveActivityTemplate(db.get(), activityBinding.activityTemplateId, {
          inputs: req.body.activity_inputs ?? {}, subjectUserId: activityBinding.subjectUserId, includeLabels: true,
          actorId:req.authUserId||req.session.userId,
          assignmentOverrideUserId:activityBinding.assignmentOverrideUserId,task:req.body,
        });
      } catch (error) { return res.status(400).json({ error: error.message, code: 400, reason: error.code || 'invalid_input' }); }
      // Resolving again at Save validates current inputs without overwriting edits.
      if (req.body.title === undefined) req.body.title = activityDraft.data.title;
      if (req.body.description === undefined) req.body.description = activityDraft.data.description;
    } else if (req.body.activity_inputs !== undefined) {
      return res.status(400).json({ error: 'Choose an Activity Template before supplying its inputs.', code: 400 });
    }
    const errors = validateTaskInput(req.body, true);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const templateDefaults = req.body.activity_template_id
      ? db.get().prepare('SELECT * FROM activity_templates WHERE id = ?').get(req.body.activity_template_id)
      : null;
    const rotationBindings = normalizeRotationBindings(db.get(), req.body.rotation_bindings ?? templateDefaults?.rotation_bindings_json);
    assertRotationBindingsChange(db.get(),req,[],rotationBindings);
    if (req.body.parent_task_id && rotationBindings.length) return res.status(400).json({error:'Configure shared rotations on the parent Activity. Its subtasks inherit the same occurrence.',code:400});
    const { start_date, start_time, due_date, due_time, due_date_offset_days } = resolveActivitySchedule(templateDefaults, req.body);
    if (templateDefaults?.due_date_offset_days != null && !start_date && req.body.due_date === undefined) {
      return res.status(400).json({ error: 'Choose a Start Date to resolve this Activity Template\'s Due setting.', code: 400 });
    }

    const {
      title,
      description     = templateDefaults?.description ?? null,
      category        = templateDefaults?.category ?? FALLBACK_CATEGORY,
      priority        = templateDefaults?.priority ?? 'none',
      expiration_policy = templateDefaults?.expiration_policy ?? 'keep_overdue',
      parent_task_id  = null,
      is_optional     = 0,
      is_recurring    = templateDefaults?.recurrence_rule ? 1 : 0,
      recurrence_rule = templateDefaults?.recurrence_rule ?? null,
      recurrence_from_completion = templateDefaults?.recurrence_from_completion ?? 0,
      countdown       = 0,
    } = req.body;
    if (is_optional && !parent_task_id) return res.status(400).json({error:'Only subtasks can be optional.',code:400});
    // Ohne expliziten Wert greift der Haushalt-Standard (#578) — aber nur für
    // Hauptaufgaben: Subtasks sind Checklisten-Punkte der Elternaufgabe und
    // würden den Punktewert sonst vervielfachen. Eine ausdrückliche 0 bleibt 0.
    const points = req.body.points === undefined && !parent_task_id
      ? (templateDefaults?.points ?? defaultTaskPoints())
      : clampPoints(req.body.points);
    const visibility = normalizeVisibility(req.body.visibility);

    const skillIds = taskSkillInput(req.body, null, activityBinding?.activityTemplateId);
    const assignmentGroup=activityBinding?null:normalizeGroupAssignment(db.get(),req.body.assignment_group);
    if(req.body.assignment_group&&!activityBinding&&parent_task_id)return res.status(400).json({error:'Choose the Group in the parent subtask editor.',code:400});
    if(assignmentGroup){
      if(assignmentGroup.member_order&&sharedGroupOnDate(db.get(),assignmentGroup.group_id,due_date||todayInHouseholdZone()))
        return res.status(400).json({error:'This shared Group uses its Group-owned order.',code:400});
      assertCapability(db.get(),req,'rotations.view');
    }
    let activitySkillSnapshot=activityBinding?instanceActivitySkillSnapshot(db.get(),activityBinding.activityTemplateId,
      skillIds,req[templateLaunchSnapshot]||null):null;
    if(activityBinding){
      activitySkillSnapshot=instanceGroupSnapshot(db.get(),activitySkillSnapshot||captureActivityTemplateDefinition(db.get(),activityBinding.activityTemplateId),
        req.body.assignment_group,{newInstance:true});
      if(req.body.assignment_group){const config=JSON.parse(activitySkillSnapshot.assignment_group_json||'null');
        if(config&&sharedGroupOnDate(db.get(),config.group_id,due_date||todayInHouseholdZone())&&config.member_order)
          return res.status(400).json({error:'This shared Group uses its Group-owned order.',code:400});}
      if(req.body.assignment_group)assertCapability(db.get(),req,'rotations.view');
    }
    const initialSubtasks = initialSubtasksInput(req.body);
    if(initialSubtasks?.some(child=>child.assignmentGroup))assertCapability(db.get(),req,'rotations.view');
    for (const child of initialSubtasks || []) assertTaskMutation(db.get(), req, null, {points:child.points}, {operation:'create'});
    if (activityBinding && parent_task_id) {
      return res.status(400).json({ error: 'Activity templates can only be attached to top-level tasks.', code: 400 });
    }
    const bindingError = validateTaskActivityBindingRequest(activityBinding, due_date || todayInHouseholdZone(), { task: { category,start_date, start_time, due_date, due_time },
      activitySnapshot:activitySkillSnapshot,assigneePolicy:categoryAssigneePolicy(db.get(),category) });
    if (bindingError) return res.status(400).json({ error: bindingError, code: 400 });

    const taskLocation = req.body.location === undefined
      ? undefined
      : normalizeTaskLocation(db.get(), req.body.location);
    if (taskLocation !== undefined && parent_task_id) {
      return res.status(400).json({ error: 'Locations can only be attached to top-level tasks.', code: 400 });
    }

    const assignmentMode = activityBinding||assignmentGroup ? 'fixed' : (req.body.assignment_mode ?? 'fixed');
    const rotationUserIds = activityBinding ? [] : parseRotationUserIds(req.body.rotation_user_ids);
    const rotationError = roundRobinConfigError(db.get(), {
      assignmentMode, isRecurring: !!is_recurring, recurrenceRule: recurrence_rule,
      parentTaskId: parent_task_id, rotationUserIds,
    });
    if (rotationError) return res.status(400).json({ error: rotationError, code: 400 });

    const rotationGroup = assignmentMode === 'round_robin'
      ? normalizeRotationGroup(req.body.rotation_group)
      : null;
    const rotationSlot = rotationGroup ? parseRotationSlot(req.body.rotation_slot) : 0;
    const groupState = currentRotationGroupState(db.get(), rotationGroup);
    const groupError = rotationGroupConfigError(db.get(), {
      joining: !!rotationGroup && groupState.peers.length > 0,
      assignmentMode, rotationGroup, rotationSlot, rotationUserIds,
      recurrenceRule: recurrence_rule,
      recurrenceFromCompletion: recurrence_from_completion,
      dueDate: due_date, dueTime: due_time,
      startDate: start_date, dueDateOffset: due_date_offset_days,
    });
    if (groupError) return res.status(400).json({ error: groupError, code: 400 });

    const requestedUserIds = activityBinding||assignmentGroup ? [] : parseAssignedTo(req.body.assigned_to);
    const rotationIndex = rotationGroup ? groupState.rotationIndex : 0;
    const rotationCycle = rotationGroup ? groupState.rotationCycle : 0;
    const activeRotationPosition = assignmentMode === 'round_robin'
      ? (rotationIndex + (rotationGroup ? rotationSlot : 0)) % rotationUserIds.length
      : 0;
    const userIds = assignmentMode === 'round_robin'
      ? [rotationUserIds[activeRotationPosition]]
      : requestedUserIds;
    const firstUid = userIds[0] ?? null;
    if(!activityBinding&&!assignmentGroup)proposedTaskAssigneePolicy(db.get(),null,req.body,{category,directIds:userIds});
    if (!activityBinding&&!assignmentGroup) assertTaskSkillAssignments(db.get(), skillIds,
      assignmentMode === 'round_robin' ? rotationUserIds : userIds, due_date || todayInHouseholdZone(), {allowDelegation:!!parent_task_id});

    // Sync-Ziel (#695). Unteraufgaben bekommen keines: sie gehören zu ihrer
    // Elternaufgabe, und als eigenständiges VTODO stünden sie gleichrangig
    // daneben. Ein mitgeschicktes Ziel wird dort still verworfen statt
    // abgewiesen - der Dialog bietet es gar nicht erst an, und ein 400 mitten im
    // Anlegen einer Checkliste wäre für den Aufrufer nicht nachvollziehbar.
    let syncTarget = null;
    if (req.body.sync_target !== undefined && !parent_task_id) {
      const resolved = resolveTaskSyncTarget(req.body.sync_target);
      if (!resolved.ok) return res.status(400).json({ error: resolved.error, code: 400 });
      syncTarget = resolved.target;
    }

    // Tiefe begrenzen: Subtasks dürfen keine eigenen Subtasks haben (max. 2 Ebenen)
    if (parent_task_id) {
      const parent = db.get().prepare('SELECT id, parent_task_id, locked, created_by FROM tasks WHERE id = ?')
        .get(parent_task_id);
      if (!parent) return res.status(404).json({ error: 'Parent task not found.', code: 404 });
      // A generated workflow activity is already a child of the workflow's
      // grouping task. Its Activity Template checklist is the one intentional
      // exception to the normal one-level checklist limit.
      if (parent.parent_task_id) {
        const isWorkflowActivity = db.get().prepare(`
          SELECT 1
            FROM workflow_instance_tasks
           WHERE task_id = ? AND role = 'primary'
        `).get(parent.id);
        if (!isWorkflowActivity) {
          return res.status(400).json({ error: 'Maximal 2 Verschachtelungsebenen erlaubt.', code: 400 });
        }
      }
      // Einen Punkt an eine gesperrte Checkliste zu haengen aendert, was die
      // Aufgabe verlangt - der offensichtlichste Weg um die Sperre herum (#830).
      if (!mayEditTaskDefinition(parent, req)) return res.status(403).json(LOCKED_ERROR);
    }

    const windowError = validateTaskWindow({start_date,start_time,due_date,due_time,expiration_policy});
    if(windowError)return res.status(400).json({error:windowError,code:400});
    assertTaskMutation(db.get(),req,null,{...req.body,expiration_policy},{operation:'create'});
    const taskId = db.get().transaction(() => {
      const authoredRotationFields = new Map();
      req.validateDeviceDefinition?.({points,assigned_to:userIds,start_date,start_time,due_date,due_time,expiration_policy,is_recurring,recurrence_rule,recurrence_from_completion});
      if(parent_task_id){
        const parent=db.get().prepare('SELECT * FROM tasks WHERE id=?').get(Number(parent_task_id));
        assertTaskRevision(db.get(),parent,{expected_revision:req.body.expected_parent_revision},{required:true});
        assertTaskMutation(db.get(),req,parent,{subtasks:[]},{operation:'update'});
        assertTaskWindowAction(db.get(),Number(parent_task_id));
        if(taskWindowAncestors(db.get(),Number(parent_task_id)).some(row=>row.status==='done'))
          throw new TaskStateError('Reopen the completed parent Task before adding checklist steps.',{reason:'optional_parent_completed'});
      }
      const result = db.get().prepare(`
        INSERT INTO tasks
          (title, description, category, priority, start_date, due_date, due_time,
           assigned_to, created_by, parent_task_id, is_recurring, recurrence_rule,
           recurrence_from_completion, assignment_mode, rotation_index, rotation_group, rotation_slot, rotation_cycle,
           points, visibility, countdown, locked, start_time, expiration_policy, is_optional, due_date_offset_days)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        title.trim(), description, category, priority,
        start_date, due_date, due_time, firstUid, req.authUserId || req.session.userId, parent_task_id,
        is_recurring ? 1 : 0, recurrence_rule, recurrence_from_completion ? 1 : 0,
        assignmentMode, rotationIndex, rotationGroup, rotationSlot || 0, rotationCycle,
        points, visibility, countdown ? 1 : 0, req.body.locked ? 1 : 0, start_time, expiration_policy, is_optional ? 1 : 0, due_date_offset_days
      );
      const groupSeriesId=is_recurring&&!parent_task_id?registerRecurrenceOccurrence(db.get(),Number(result.lastInsertRowid))?.series_id:null;
      assignNewTaskCardColor(db.get(),result.lastInsertRowid,req.body.card_color_choice?{choice:req.body.card_color_choice}:parent_task_id?{inheritFrom:parent_task_id}:{});
      setAssignments(db.get(), result.lastInsertRowid, userIds);
      if(!activityBinding)persistNewTaskAssignees(db.get(),result.lastInsertRowid,userIds);
      authoredRotationFields.set(Number(result.lastInsertRowid),{title,description});
      db.get().prepare('UPDATE tasks SET rotation_bindings_json=? WHERE id=?').run(JSON.stringify(rotationBindings),result.lastInsertRowid);
      setTaskSkills(db.get(), result.lastInsertRowid, skillIds);
      setRotationMembers(db.get(), result.lastInsertRowid, assignmentMode === 'round_robin' ? rotationUserIds : []);
      if(rotationGroup)refreshLegacyRotationGroupMapping(db.get(),rotationGroup);
      if (req.body.tags !== undefined) setTags(db.get(), result.lastInsertRowid, req.body.tags);
      else if (templateDefaults) setTags(db.get(), result.lastInsertRowid, JSON.parse(templateDefaults.tags_json));
      if (activityBinding) {
        applyTaskActivityBinding(db.get(), Number(result.lastInsertRowid), {
          activityTemplateId: activityBinding.activityTemplateId,
          subjectUserId: activityBinding.subjectUserId,
          assignmentOverrideUserId: activityBinding.assignmentOverrideUserId,
          adoptAssigneePolicy: true,
          commitRotation: true,
          activitySnapshot:(activitySkillSnapshot.assignment_policy||activitySkillSnapshot.assignment_strategy)==='group_rotation'
            ?{...activitySkillSnapshot,rotation_scope:groupSeriesId?`series:${groupSeriesId}`:`task:${result.lastInsertRowid}`}
            :activitySkillSnapshot,
          dateKey: due_date || todayInHouseholdZone(),
          materializeChecklist: initialSubtasks === undefined,
          variableLabels: activityDraft?.variable_labels,
        });
      }
      if (initialSubtasks !== undefined) {
        const insertChild = db.get().prepare(`INSERT INTO tasks
          (title, category, created_by, parent_task_id, start_date, due_date, due_time, visibility, start_time, is_optional, points)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
        for (const child of initialSubtasks) {
          const childId = Number(insertChild.run(child.title, category, req.authUserId || req.session.userId,
            result.lastInsertRowid, start_date, due_date, due_time, visibility, start_time, child.isOptional ?? 0, child.points ?? 0).lastInsertRowid);
          assignNewTaskCardColor(db.get(),childId,{inheritFrom:result.lastInsertRowid});
          persistNewTaskAssignees(db.get(),childId,child.assignedUsers??[]);
          authoredRotationFields.set(childId,{title:child.title});
          setTaskSkills(db.get(), childId, child.skillIds);
          if(child.assignmentGroup){
            const selected=selectTaskGroupMember(childId,child.assignmentGroup,child.skillIds,
              {consumerKey:groupSeriesId?`series:${groupSeriesId}:action:${childId}`:`subtask:${result.lastInsertRowid}:${child.templateItemId||childId}`});
            assertTaskMutation(db.get(),req,null,{parent_task_id:Number(result.lastInsertRowid),assigned_to:[selected],skill_ids:child.skillIds},{operation:'create'});
            child.assignedUsers=[selected];recordGroupAssignment(db.get(),childId,child.assignmentGroup,selected);
            persistNewTaskAssignees(db.get(),childId,[selected]);
          }
          if(child.templateItemId)db.get().prepare('UPDATE tasks SET activity_template_checklist_item_id=? WHERE id=?').run(child.templateItemId,childId);
          if(child.assignedUsers!==undefined) {
            assertTaskMutation(db.get(),req,null,{parent_task_id:Number(result.lastInsertRowid),assigned_to:child.assignedUsers,skill_ids:child.skillIds},{operation:'create'});
            assertTaskSkillAssignments(db.get(),child.skillIds,child.assignedUsers,due_date||todayInHouseholdZone(),{allowDelegation:true});
            assertTaskAssignmentAvailability(db.get(),childId,child.assignedUsers);
            db.get().prepare('UPDATE tasks SET assigned_to=? WHERE id=?').run(child.assignedUsers[0]??null,childId);
            setAssignments(db.get(),childId,child.assignedUsers);
          }
        }
      }
      if(!parent_task_id) {
        const source=db.get().prepare('SELECT * FROM tasks WHERE id=?').get(result.lastInsertRowid);
        const children=ordinaryActivitySubtasks(db.get(),Number(result.lastInsertRowid));
        const childPositive=children.some(child=>child.points>0);
        const configuredMode=req.body.scoring_mode??templateDefaults?.scoring_mode;
        if(configuredMode==null&&source.points>0&&childPositive)
          throw new TaskStateError('Choose a scoring mode when both task and subtask amounts are configured.',{reason:'scoring_mode_required'},400);
        const mode=configuredMode??(childPositive?'subtasks':'whole_task');
        assertTaskMutation(db.get(),req,null,{...req.body,points:source.points},{operation:'create'});
        db.get().prepare('UPDATE tasks SET scoring_mode=?,scoring_review_required=0 WHERE id=?').run(mode,result.lastInsertRowid);
      }
      if (syncTarget) {
        db.get().prepare(
          'UPDATE tasks SET target_caldav_account_id = ?, target_caldav_list_url = ? WHERE id = ?'
        ).run(syncTarget.accountId, syncTarget.listUrl, result.lastInsertRowid);
      }
      if (taskLocation !== undefined) {
        setTaskLocation(db.get(), Number(result.lastInsertRowid), taskLocation, req.authUserId || req.session.userId);
      }
      if(assignmentGroup){
        const selected=selectTaskGroupMember(Number(result.lastInsertRowid),assignmentGroup,skillIds,
          {consumerKey:groupSeriesId?`series:${groupSeriesId}:root`:`task:${result.lastInsertRowid}`,allowDelegation:false});
        assertTaskMutation(db.get(),req,null,{...req.body,assigned_to:[selected]},{operation:'create'});
        db.get().prepare('UPDATE tasks SET assigned_to=? WHERE id=?').run(selected,result.lastInsertRowid);
        setAssignments(db.get(),result.lastInsertRowid,[selected]);
        persistNewTaskAssignees(db.get(),result.lastInsertRowid,[selected]);
        recordGroupAssignment(db.get(),Number(result.lastInsertRowid),assignmentGroup,selected);
      }
      bindTaskRotations(db.get(),Number(result.lastInsertRowid),{actorId:req.authUserId||req.session.userId});
      initializeTaskRotationRendering(db.get(),Number(result.lastInsertRowid),{draft:activityDraft?.data,inputs:req.body.activity_inputs||{},authoredFields:authoredRotationFields,actor:req.authUserId||req.session.userId});
      const actual = db.get().prepare('SELECT assigned_to FROM tasks WHERE id=?').get(result.lastInsertRowid);
      if (actual.assigned_to) assertTaskSupervisionAssignee(db.get(),Number(result.lastInsertRowid),actual.assigned_to);
      reconcileTaskSupervision(db.get(),Number(result.lastInsertRowid),{actorId:req.authUserId||req.session.userId});
      notifyTaskAssignments(db.get(), Number(result.lastInsertRowid));
      if(is_recurring) {
        const series=ensureSeriesDefinition(db.get(),Number(result.lastInsertRowid));
        if(series)recordOccurrenceDefinition(db.get(),Number(result.lastInsertRowid),{definitionId:series.definition.id,baseline:true});
      }
      return result.lastInsertRowid;
    })();

    const task = db.get().prepare(`
      SELECT t.*, u.display_name AS assigned_name, u.avatar_color AS assigned_color,
        u.avatar_data AS assigned_avatar, ${ASSIGNED_USERS_SQL}
      FROM tasks t LEFT JOIN users u ON t.assigned_to = u.id
      WHERE t.id = ?
    `).get(taskId);

    addAssignedUsers(task);
    attachTaskActivityBindings(db.get(), [task]);
    attachTaskLocations(db.get(), [task]);
    attachTags([task]);
    res.status(201).json({ data: req.projectDeviceTask ? req.projectDeviceTask(task) : hydrateTask(task,req.authUserId||req.session.userId) });
    if (syncTarget) pushToCalDAV('Neue Aufgabe');
  } catch (err) {
    if (err.status && typeof res !== 'undefined') return res.status(err.status).json({ error: err.message, code: err.status, ...err.details });
    if (err instanceof TaskActivityBindingError || err instanceof TaskLocationError || err instanceof TaskSkillError || err instanceof TaskAssignmentAvailabilityError) {
      return res.status(400).json({ error: err.message, code: 400 });
    }
    log.error('POST / error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
}
router.post('/',createTaskDefinition);

router.post('/:id/scoring-preview',(req,res)=>{
  try {
    const data=withTaskReadSnapshot(db.get(),req,()=>{
      const task=db.get().prepare('SELECT * FROM tasks WHERE id=?').get(Number(req.params.id));
      if(!task)throw new TaskStateError('Task not found.',{},404);
      const capabilities=taskCapabilities(db.get(),req,task);
      if(!capabilities.view)throw new TaskStateError('Task not found.',{},404);
      if(!capabilities.edit||!capabilities.change_points)throw new TaskStateError('Your permissions do not allow previewing scoring changes.',{},403);
      validateScoringInput(req.body);assertScoringOwner(task,req.body);
      const scope=req.body.edit_scope??'occurrence';
      if(!['occurrence','future','future_only'].includes(scope))throw new TaskStateError('Choose where to apply these changes.',{},400);
      const viewerId=req.authUserId||req.session.userId,hydrated=hydrateTask(task,viewerId),authorizedTaskIds=authorizedScoringHistoryIds(task,viewerId,[task.id,...hydrated.subtasks.filter(row=>!row.is_supervision_projection).map(row=>row.id)]);
      let preview;
      if(scope==='future_only') {
        const {state,before,definition}=futureEditContext(req,task);
        preview=previewFutureDefinitions(req,task,before,definition,{scope,viewerId,authorizedTaskIds});
        if(req.body.include_edit_definition)preview.edit_definition=futureEditProjection(req,task,before,state);
      } else {
        const errors=validateTaskInput(req.body,false,task.recurrence_rule);if(errors.length)throw new TaskStateError(errors.join(' '),{},400);
        assertTaskMutation(db.get(),req,task,req.body,{operation:'update'});
        const historical=scope==='future'&&(!!task.archived_at||['done','expired','skipped','closed_incomplete'].includes(task.status));
        const series=scope==='future'?taskSeriesState(db.get(),task.id):null;
        if(series)assertSeriesEdit(db.get(),req,task,series,req.body.expected_series_revision);
        else if(scope==='future')assertSeriesEdit(db.get(),req,task,series,req.body.expected_series_revision);
        const edited=editedSubtasksInput(task,req.body,req,{definitionOnly:historical});
        if(!getTaskActivityBinding(db.get(),task.id)&&!req.body.activity_template_id)proposedTaskAssigneePolicy(db.get(),task,req.body,{directIds:scoringAssignmentIntent(task,req.body).assigned});
        const currentBinding=getTaskActivityBinding(db.get(),task.id);if(currentBinding&&sameTaskActivityBinding(parseTaskActivityBinding(req.body,currentBinding).binding,currentBinding))proposedBoundTaskCategoryPolicy(db.get(),task,req.body,readTaskActivityDefinition(db.get(),task.id),currentBinding);
        for(const child of edited?.next||[]){const previous=child.id?db.get().prepare('SELECT * FROM tasks WHERE id=?').get(child.id):null;proposedTaskAssigneePolicy(db.get(),previous,child.assignedUsers===undefined?{}:{assigned_to:child.assignedUsers},{category:previous?.category??req.body.category??task.category,directIds:child.assignedUsers??[]});}
        assertScoringProgressIntent(task,req.body,edited);
        let proposed;
        if(series){
          const currentDefinition=captureSeriesDefinition(db.get(),task.id,{registerActions:false});
          const intent=compatibleFutureDefinition(req,task,series,currentDefinition,edited,{normalizeSchedule:false});
          proposed=compatiblePreviewNoop(task,req.body,series,currentDefinition,intent)
            ?effectiveSeriesScoringDefinition(db.get(),seriesDefinitionForGeneration(db.get(),series.series_id,series.occurrence.generation+1)).data
            :normalizeSeriesSchedule(intent,series.occurrence);
          const before=assertCompatibleFutureDefinition(req,task,series,proposed);
          if(historical)preview=previewFutureDefinitions(req,task,before,proposed,{scope,viewerId,authorizedTaskIds});
        }
        if(!historical){
        const wire=scoringMutationWire(req.body,edited,task);
        const assignment=scoringAssignmentIntent(task,req.body);
        if(assignment.changed||assignment.bindingChanged)wire.assigned_to=draftVisibilityAssignees(task,req.body,assignment.assigned,edited);
        // A full editor sends [] for policy-managed assignments. When Save
        // preserves current responsibility, that placeholder is not a removal.
        else if(!Object.hasOwn(req.body,'assigned_to')||!parseAssignedTo(req.body.assigned_to).length)delete wire.assigned_to;
        const prepareAfterExecution=currentScoringExecutionChanged(task,req.body,edited,assignment)
          ?ctx=>prepareCurrentScoringExecution(task,req.body,edited,assignment,ctx):null;
        preview=previewTaskScoring(db.get(),task.id,wire,{scope,viewerId,authorizedTaskIds,includeUnits:true,prepareAfterExecution});
        const rows=taskScoringRows(db.get(),taskScoringRoot(db.get(),task.id)).filter(row=>authorizedTaskIds.includes(row.id));
        const before=new Map(rows.map(row=>[row.id,row])),after=new Map(before);
        for(const child of edited?.next||[])if(child.id)after.set(child.id,{title:child.title,is_optional:child.isOptional});
        const drafts=(edited?.next||[]).map((child,index)=>{
          const key=req.body.subtasks[index]?.client_key;
          if(key!==undefined&&(typeof key!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(key)))throw new TaskStateError('Choose a valid draft work key.',{},400);
          return {title:child.title,is_optional:child.isOptional,client_key:key};
        });
        after.set(task.id,{...task,title:req.body.title===undefined?task.title:String(req.body.title).trim(),is_optional:req.body.is_optional===undefined?task.is_optional:Number(!!req.body.is_optional)});
        decorateScoringUnits(preview,before,after,{drafts});
        }
      }
      if(!preview.settlements)preview.settlements=hydrated.scoring?.settlements??[];
      decorateScoringSettlements(preview,req);
      return preview;
    });res.json({data});
  }catch(error){const status=error.status||(error instanceof TaskSkillError?400:500);res.status(status).json({error:error.message,code:status,...(error.reason?{reason:error.reason}:{}),...error.details});}
});

// --------------------------------------------------------
// PUT /api/v1/tasks/:id
// Aufgabe vollständig aktualisieren.
// Body: { title, description?, category?, tags?, priority?, status?,
//         due_date?, due_time?, assigned_to? }
// Response: { data: Task }
// tags fehlt → bleiben unangetastet; tags: [] → alle entfernt.
// --------------------------------------------------------
export function updateTaskDefinition(req, res) {
  try {
    const task = db.get().prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found.', code: 404 });
    // 404 statt 403: ob es die Aufgabe gibt, ist selbst schon eine Auskunft.
    if (!mayAccessTask(task, req.devicePrincipal || req.authUserId || req.session.userId)) {
      return res.status(404).json({ error: 'Task not found.', code: 404 });
    }

    const editScope=req.body.edit_scope??'occurrence';
    if(!['occurrence','future','future_only'].includes(editScope))return res.status(400).json({error:'Choose where to apply these changes.',code:400});
    validateScoringInput(req.body);assertScoringOwner(task,req.body);
    if(editScope==='future_only')return saveFutureTaskDefinition(req,res,task);
    const rotationBindings = req.body.rotation_bindings === undefined ? parseRotationBindings(task.rotation_bindings_json)
      : normalizeRotationBindings(db.get(),req.body.rotation_bindings);
    const rotationBindingsJson = JSON.stringify(rotationBindings);
    const rotationsChanged = rotationBindingsJson !== (task.rotation_bindings_json || '[]');
    assertRotationBindingsChange(db.get(),req,task.rotation_bindings_json,rotationBindings);
    if(rotationsChanged && !taskCapabilities(db.get(),req,task).edit) return res.status(403).json({error:'Your household permissions do not allow editing this Activity.',code:403});
    if (task.parent_task_id && rotationsChanged) return res.status(400).json({error:'Configure shared rotations on the parent Activity. Its subtasks inherit the same occurrence.',code:400});
    const historical=!!task.archived_at||['done','expired','skipped','closed_incomplete'].includes(task.status);
    const historicalSeriesOnly=editScope==='future'&&historical;
    if(!historicalSeriesOnly)assertTaskWindowAction(db.get(),task.id);
    const errors = validateTaskInput(req.body, false, task.recurrence_rule);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const {
      title           = task.title,
      description     = task.description,
      category        = task.category,
      priority        = task.priority,
      start_date      = task.start_date,
      start_time      = task.start_time,
      expiration_policy = task.expiration_policy,
      is_optional     = task.is_optional,
      due_date        = task.due_date,
      due_time        = task.due_time,
      is_recurring    = task.is_recurring,
      recurrence_rule = task.recurrence_rule,
      recurrence_from_completion = task.recurrence_from_completion,
      // Nicht mitgeschickt heisst „nicht angefasst" (#647): ein PATCH aus einer
      // Liste oder ein Modul, das das Feld nicht kennt, darf eine gesetzte
      // Markierung nicht stillschweigend löschen.
      countdown       = task.countdown,
    } = req.body;
    if (is_optional && !task.parent_task_id) return res.status(400).json({error:'Only subtasks can be optional.',code:400});
    assertOptionalityEdit(task,is_optional);
    const windowError = validateTaskWindow({start_date,start_time,due_date,due_time,expiration_policy});
    if(windowError)return res.status(400).json({error:windowError,code:400});
    // Relative occurrence scheduling is an internal snapshot, never a client
    // lifecycle switch. Concrete date edits preserve their permitted window;
    // legacy Tasks retain their original recurrence anchor.
    const dueDateOffset = task.due_date_offset_days == null
      ? editScope==='future'&&calendarDayOffset(start_date,due_date)!==calendarDayOffset(task.start_date,task.due_date)
        ? calendarDayOffset(start_date,due_date) : null
      : calendarDayOffset(start_date, due_date);
    const points = req.body.points !== undefined ? Number(req.body.points) : task.points;
    const scoringMode=req.body.scoring_mode??task.scoring_mode;
    const visibility = req.body.visibility !== undefined
      ? normalizeVisibility(req.body.visibility, task.visibility)
      : task.visibility;
    const taskLocation = req.body.location === undefined
      ? undefined
      : normalizeTaskLocation(db.get(), req.body.location);
    if (taskLocation !== undefined && task.parent_task_id && !isTripStep(db.get(),task.id)) {
      return res.status(400).json({ error: 'Locations can only be attached to top-level tasks.', code: 400 });
    }

    // `status: 'archived'` aus einem Bestandsclient legt ab, statt den Status zu
    // überschreiben (#688). Das Statusfeld selbst kennt den Wert nicht mehr.
    const archiveRequested = req.body.status === ARCHIVE_STATUS;
    const status = (req.body.status === undefined || archiveRequested)
      ? task.status
      : req.body.status;

    if(historicalSeriesOnly&&status!==task.status)return res.status(409).json({error:'Historical progress is preserved. Reopen the occurrence separately before changing its status.',code:409});
    if(status!==task.status)assertTaskWindowAction(db.get(),task.id);
    if (status === 'done' && task.status !== 'done') {
      const blockedBy = unresolvedDependencies(db.get(), task.id);
      if (blockedBy.length) {
        return res.status(409).json({
          error: 'Complete required earlier activities first.', code: 409,
          dependencies: blockedBy.filter(item => mayAccessTask(db.get().prepare('SELECT * FROM tasks WHERE id=?').get(item.id), req.authUserId || req.session.userId)),
        });
      }
    }

    const existingActivityBinding = getTaskActivityBinding(db.get(), task.id);
    const bindingRequest = parseTaskActivityBinding(req.body, existingActivityBinding);
    if (bindingRequest.error) return res.status(400).json({ error: bindingRequest.error, code: 400 });
    const desiredActivityBinding = bindingRequest.binding;
    const skillsBefore = existingActivityBinding?.definition_snapshot_json
      ? JSON.parse(existingActivityBinding.definition_snapshot_json).required_skill_ids : loadTaskSkillIds(db.get(), task.id);
    const skillIds = taskSkillInput(req.body, task.id, desiredActivityBinding?.activityTemplateId);
    let activitySkillSnapshot=desiredActivityBinding?instanceActivitySkillSnapshot(db.get(),desiredActivityBinding.activityTemplateId,
      skillIds,existingActivityBinding?.activity_template_id===desiredActivityBinding.activityTemplateId&&existingActivityBinding.definition_snapshot_json
        ?readTaskActivityDefinition(db.get(),task.id):null):null;
    const editedSubtasks = editedSubtasksInput(task,req.body,req,{definitionOnly:historicalSeriesOnly});
    const bindingChanged = !sameTaskActivityBinding(desiredActivityBinding, existingActivityBinding);
    const incomingGroup=req.body.assignment_group===undefined?task.assignment_group_json:req.body.assignment_group;
    const priorGroup=task.assignment_group_json?JSON.parse(task.assignment_group_json):null;
    const incomingGroupId=(typeof incomingGroup==='string'?JSON.parse(incomingGroup):incomingGroup)?.group_id;
    const assignmentGroup=desiredActivityBinding&&bindingChanged?null:desiredActivityBinding&&priorGroup
      ?normalizeGroupAssignment(db.get(),incomingGroup||priorGroup,{allowInactive:true,allowImported:true})
      :desiredActivityBinding?null:normalizeGroupAssignment(db.get(),incomingGroup,
      {allowInactive:!!priorGroup&&Number(incomingGroupId)===Number(priorGroup.group_id),
        allowImported:!!priorGroup&&Number(incomingGroupId)===Number(priorGroup.group_id)});
    if(desiredActivityBinding&&!bindingChanged&&assignmentGroup&&Number(assignmentGroup.group_id)!==Number(priorGroup?.group_id))
      return res.status(400).json({error:'Choose the Group configured on this Activity.',code:400});
    if(desiredActivityBinding&&bindingChanged){
      activitySkillSnapshot=instanceGroupSnapshot(db.get(),activitySkillSnapshot||captureActivityTemplateDefinition(db.get(),desiredActivityBinding.activityTemplateId),
        req.body.assignment_group,{newInstance:true});
      if(req.body.assignment_group){const config=JSON.parse(activitySkillSnapshot.assignment_group_json||'null');
        if(config&&sharedGroupOnDate(db.get(),config.group_id,due_date||todayInHouseholdZone())&&config.member_order)
          return res.status(400).json({error:'This shared Group uses its Group-owned order.',code:400});
        assertCapability(db.get(),req,'rotations.view');}
    }
    const groupConfigurationChanged=JSON.stringify(assignmentGroup)!==(task.assignment_group_json||'null');
    if(groupConfigurationChanged&&assignmentGroup&&sharedGroupOnDate(db.get(),assignmentGroup.group_id,due_date||todayInHouseholdZone())
      &&(assignmentGroup.member_order||priorGroup&&Number(priorGroup.group_id)===Number(assignmentGroup.group_id)))
      return res.status(400).json({error:'This shared Group uses its Group-owned order and rotation settings.',code:400});
    if(groupConfigurationChanged){if(assignmentGroup)assertCapability(db.get(),req,'rotations.view');
      const groupPermissions=taskCapabilities(db.get(),req,task);
      if(!groupPermissions.change_assignment||!groupPermissions.reassign)return res.status(403).json({error:'Your permissions do not allow changing this assignment.',code:403});}
    if(assignmentGroup&&task.parent_task_id)return res.status(400).json({error:'Choose the Group in the parent subtask editor.',code:400});
    if (bindingChanged && desiredActivityBinding && task.rotation_group) {
      return res.status(409).json({
        error: 'Remove this task from its rotation group before attaching an Activity Template.', code: 409,
      });
    }
    if (bindingChanged && desiredActivityBinding) {
      const bindingError = validateTaskActivityBindingRequest(desiredActivityBinding, due_date || todayInHouseholdZone(), {
        task: { category,start_date, start_time, due_date, due_time },assigneePolicy:categoryAssigneePolicy(db.get(),category),
        activitySnapshot:activitySkillSnapshot });
      if (bindingError) return res.status(400).json({ error: bindingError, code: 400 });
    }
    const taskWindowChanged = start_time !== task.start_time || start_date !== task.start_date || due_date !== task.due_date || due_time !== task.due_time;

    const assignedBefore = db.get().prepare('SELECT user_id FROM task_assignments WHERE task_id = ?')
      .all(task.id).map((r) => r.user_id);
    if(desiredActivityBinding&&!bindingChanged&&!historicalSeriesOnly&&!sameIdOrder(skillIds,skillsBefore))
      assertTaskSkillAssignments(db.get(),skillIds,assignedBefore,due_date||todayInHouseholdZone());
    const rotationBefore = loadRotationUserIds(db.get(), task.id);
    const assignmentMode = desiredActivityBinding||assignmentGroup
      ? 'fixed'
      : (req.body.assignment_mode !== undefined ? req.body.assignment_mode : (task.assignment_mode || 'fixed'));
    const rotationUserIds = desiredActivityBinding
      ? []
      : (req.body.rotation_user_ids !== undefined ? parseRotationUserIds(req.body.rotation_user_ids) : rotationBefore);
    const rotationError = roundRobinConfigError(db.get(), {
      assignmentMode, isRecurring: !!is_recurring, recurrenceRule: recurrence_rule,
      parentTaskId: task.parent_task_id, rotationUserIds,
    });
    if (rotationError) return res.status(400).json({ error: rotationError, code: 400 });

    const requestedRotationGroup = req.body.rotation_group !== undefined
      ? normalizeRotationGroup(req.body.rotation_group)
      : normalizeRotationGroup(task.rotation_group);
    const rotationGroup = assignmentMode === 'round_robin' ? requestedRotationGroup : null;
    if (task.rotation_group && rotationGroup
        && task.rotation_group.localeCompare(rotationGroup, undefined, { sensitivity: 'accent' }) !== 0) {
      return res.status(400).json({ error: 'Move a grouped task by removing it from the group first.', code: 400 });
    }
    const rotationSlot = rotationGroup
      ? (req.body.rotation_slot !== undefined ? parseRotationSlot(req.body.rotation_slot) : Number(task.rotation_slot || 0))
      : 0;
    const joiningGroup = !!rotationGroup && !task.rotation_group;
    const groupState = currentRotationGroupState(db.get(), rotationGroup, task.rotation_group ? task.id : null);
    const groupError = rotationGroupConfigError(db.get(), {
      taskId: task.rotation_group ? task.id : null,
      joining: joiningGroup,
      assignmentMode, rotationGroup, rotationSlot, rotationUserIds,
      recurrenceRule: recurrence_rule,
      recurrenceFromCompletion: recurrence_from_completion,
      dueDate: due_date, dueTime: due_time,
      startDate: start_date, dueDateOffset,
    });
    if (groupError) return res.status(400).json({ error: groupError, code: 400 });
    if (task.rotation_group && Number(task.rotation_slot || 0) !== rotationSlot
        && groupState.peers.some((peer) => peer.status !== 'open')) {
      return res.status(409).json({ error: 'Cannot change a rotation-group position after its current cycle has started.', code: 409 });
    }

    const groupSelected=assignmentGroup&&desiredActivityBinding?Number(task.assigned_to)||null:assignmentGroup?(groupConfigurationChanged
      ?selectTaskGroupMember(task.id,assignmentGroup,skillIds,{consumerKey:taskSeriesState(db.get(),task.id)?.series_id?`series:${taskSeriesState(db.get(),task.id).series_id}:root`:`task:${task.id}`,
        commit:false,allowDelegation:false})
      :Number(task.assigned_to)||null):null;
    if(assignmentGroup&&groupSelected)req.body.assigned_to=[groupSelected];
    const requestedUserIds = desiredActivityBinding
      ? assignedBefore
      : (req.body.assigned_to !== undefined ? parseAssignedTo(req.body.assigned_to) : assignedBefore);
    let rotationIndex = 0;
    let rotationCycle = 0;
    let userIds;
    if (desiredActivityBinding) {
      userIds = assignedBefore;
    } else if (assignmentMode === 'round_robin') {
      if (rotationGroup) {
        rotationIndex = groupState.rotationIndex;
        rotationCycle = groupState.rotationCycle;
        userIds = [rotationUserIds[(rotationIndex + rotationSlot) % rotationUserIds.length]];
      } else {
        const oldCurrent = Number(task.assigned_to);
        const oldPosition = rotationUserIds.indexOf(oldCurrent);
        rotationIndex = task.assignment_mode === 'round_robin' && oldPosition >= 0 ? oldPosition : 0;
        userIds = [rotationUserIds[rotationIndex]];
      }
    } else {
      userIds = requestedUserIds;
    }
    if(editScope!=='future'&&taskSeriesState(db.get(),task.id)) {
      // Assignment overrides belong to this occurrence. The durable series
      // still advances from its existing rotation position and cohort cycle.
      rotationIndex=Number(task.rotation_index||0);
      rotationCycle=Number(task.rotation_cycle||0);
    }
    const firstUid = desiredActivityBinding || req.body.assigned_to === undefined && assignmentMode === 'fixed'
      ? task.assigned_to : (userIds[0] ?? null);
    const directSelection=taskDirectAssignmentSelection(db.get(),task,req.body);
    const directChanged=!desiredActivityBinding&&!sameIdOrder(directSelection.previous,directSelection.selected);
    const independentIds=directChanged?directSelection.selected:independentlyAssignedTaskMembers(task.id,userIds,assignedBefore,firstUid);
    if (!desiredActivityBinding && (!sameIdOrder(skillIds, skillsBefore) || !sameIdOrder(userIds, assignedBefore)
        || firstUid !== task.assigned_to || !sameIdOrder(rotationUserIds, rotationBefore)
        || directChanged || bindingChanged || due_date !== task.due_date)) {
      assertTaskSkillAssignments(db.get(), skillIds,
        assignmentMode === 'round_robin' ? rotationUserIds
          : independentIds,
        due_date || todayInHouseholdZone(), {allowDelegation:!!task.parent_task_id});
    }
    const performersChanged = !desiredActivityBinding && (directChanged || !sameIdOrder(userIds, assignedBefore) || firstUid !== task.assigned_to);
    if (!historicalSeriesOnly && !bindingChanged && status !== 'done' && (taskWindowChanged || performersChanged)) {
      // Keep the occurrence's policy, including authored supervisor Tasks
      // without an Activity binding. Reapplying an Activity would advance its
      // rotation; validate the resulting people/window without rewriting work.
      assertTaskAssignmentAvailability(db.get(), task.id,
        performersChanged ? independentIds : null,
        { task: { start_date, start_time, due_date, due_time, assigned_to: firstUid } });
    }

    // Sperre der Aufgabe (#830). Nicht mitgeschickt heisst "nicht angefasst".
    const lockedRequested = req.body.locked !== undefined ? (req.body.locked ? 1 : 0) : null;
    const locked = lockedRequested ?? task.locked;

    // Vor dem Update festhalten: die Rückrichtung vergleicht damit, ob sich die
    // Tags wirklich geändert haben (#586).
    const tagsBefore = loadTags(db.get(), task.id);

    // Sync-Ziel nachträglich setzen oder zurücknehmen (#695). Nur solange die
    // Aufgabe noch lokal ist: ist sie erst hochgeladen, wäre das ein Umzug
    // zwischen Listen, und den gibt es bewusst nicht. Das Feld wird dann still
    // ignoriert statt abgewiesen - der Dialog zeigt es in diesem Zustand als
    // festen Wert, ein 400 träfe also niemanden, der es geändert hätte.
    let syncTarget;
    const targetEditable = task.external_source !== 'caldav';
    if (req.body.sync_target !== undefined && targetEditable && !task.parent_task_id) {
      const resolved = resolveTaskSyncTarget(req.body.sync_target);
      if (!resolved.ok) return res.status(400).json({ error: resolved.error, code: 400 });
      syncTarget = resolved.target;
    }

    // GESPERRTE AUFGABE (#830): die Definition ist zu, die Interaktion nicht.
    //
    // Verglichen wird das AUFGELOESTE Ergebnis gegen den Bestand, nicht die
    // blosse Anwesenheit eines Feldes im Rumpf. Der Dialog schickt die ganze
    // Aufgabe zurueck, und "Feld mitgeschickt = Aenderungsversuch" wuerde
    // deshalb genau das abweisen, was offen bleiben soll: das Abhaken aus dem
    // Bearbeiten-Formular schickt Titel und Termin unveraendert mit.
    if (!mayEditTaskDefinition(task, req)) {
      const wanted = {
        title: title.trim(), description, category, priority,
        start_date, start_time, expiration_policy, due_date, due_time,
        is_recurring: is_recurring ? 1 : 0, recurrence_rule,
        recurrence_from_completion: recurrence_from_completion ? 1 : 0,
        assignment_mode: assignmentMode,
        rotation_group: rotationGroup, rotation_slot: rotationSlot || 0,
        countdown: countdown ? 1 : 0, points, scoring_mode:scoringMode, visibility, rotation_bindings_json: rotationBindingsJson,
      };
      let touchesDefinition = Object.keys(wanted).some((k) => !sameFieldValue(wanted[k], task[k]));

      if (req.body.tags !== undefined
          && tagsKey(normalizeTags(req.body.tags)) !== tagsKey(tagsBefore)) touchesDefinition = true;
      if (!sameIdOrder(rotationUserIds, rotationBefore)) touchesDefinition = true;
      if (!sameIdOrder(skillIds, skillsBefore)) touchesDefinition = true;
      if (bindingChanged) touchesDefinition = true;
      if(groupConfigurationChanged)touchesDefinition=true;
      if (taskLocation !== undefined
          && JSON.stringify(taskLocation) !== JSON.stringify(storedTaskLocation(db.get(), task.id))) {
        touchesDefinition = true;
      }

      if (syncTarget !== undefined
          && (!sameFieldValue(syncTarget?.accountId ?? null, task.target_caldav_account_id)
           || !sameFieldValue(syncTarget?.listUrl   ?? null, task.target_caldav_list_url))) touchesDefinition = true;

      // Ablegen nimmt die Aufgabe allen aus der Ansicht - das ist eine
      // Aenderung an ihr, kein Umgang mit ihr.
      if (archiveRequested && !task.archived_at) touchesDefinition = true;

      // Die Sperre selbst zu loesen ist der erste Zug, den jemand versuchen
      // wuerde, der sie umgehen will.
      if (lockedRequested !== null && lockedRequested !== task.locked) touchesDefinition = true;

      // Die EIGENE Zuweisung ist Interaktion - eine offene Aufgabe an sich zu
      // nehmen oder wieder abzugeben. Die FREMDE ist Definition: sonst schoebe
      // ein Kind die Aufgabe einfach seinem Geschwister zu, und die Sperre
      // haette den Fall nicht gehalten, um den es hier geht.
      const me = req.authUserId || req.session.userId;
      const direct=taskDirectAssignmentSelection(db.get(),task,req.body);
      const othersBefore = direct.previous.filter((id) => id !== me);
      const othersAfter  = direct.selected.filter((id) => id !== me);
      if (othersBefore.length !== othersAfter.length
          || othersBefore.some((id) => !othersAfter.includes(id))) touchesDefinition = true;

      if (touchesDefinition) return res.status(403).json(LOCKED_ERROR);
    }

    const definitionFields={title:title.trim(),description,category,priority,start_date,start_time,due_date,due_time,
      due_date_offset_days:dueDateOffset,is_recurring:is_recurring?1:0,recurrence_rule,
      recurrence_from_completion:recurrence_from_completion?1:0,assignment_mode:assignmentMode,
      rotation_group:rotationGroup,rotation_slot:rotationSlot||0,rotation_bindings_json:rotationBindingsJson,points,scoring_mode:scoringMode,
      assignment_group_json:assignmentGroup?JSON.stringify(assignmentGroup):null,
      scoring_review_required:req.body.scoring_mode===undefined?task.scoring_review_required:0,visibility,countdown:countdown?1:0,locked,expiration_policy,is_optional:is_optional?1:0};
    const currentChildren=editedSubtasks?ordinaryActivitySubtasks(db.get(),task.id).filter(row=>!row.archived_at):null;
    const childrenChanged=editedSubtasks&&(editedSubtasks.remove.length||editedSubtasks.next.length!==currentChildren.length
      ||editedSubtasks.next.some((child,index)=>child.id!==currentChildren[index]?.id||child.title!==currentChildren[index]?.title
        ||JSON.stringify(child.assignmentGroup)!==(currentChildren[index]?.assignment_group_json||'null')
        ||child.isOptional!==Number(currentChildren[index]?.is_optional||0)
        ||child.points!==Number(currentChildren[index]?.points||0)
        ||child.assignedUsers!==undefined&&!sameIdOrder(child.assignedUsers,db.get().prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(child.id).map(row=>row.user_id))
        ||!sameIdOrder(child.skillIds,loadTaskSkillIds(db.get(),child.id))));
    const countProposal=!desiredActivityBinding?proposedTaskAssigneePolicy(db.get(),task,req.body,{category,directIds:userIds}):!bindingChanged?proposedBoundTaskCategoryPolicy(db.get(),task,req.body,readTaskActivityDefinition(db.get(),task.id),existingActivityBinding):null;
    const definitionChanged=groupConfigurationChanged||!!countProposal||req.body.card_color_choice!==undefined||Object.entries(definitionFields).some(([key,value])=>!sameFieldValue(value,task[key]))
      ||childrenChanged||bindingChanged||!sameIdOrder(skillIds,skillsBefore)
      ||!sameIdOrder(userIds,assignedBefore)||!sameIdOrder(rotationUserIds,rotationBefore)
      ||req.body.tags!==undefined&&tagsKey(normalizeTags(req.body.tags))!==tagsKey(tagsBefore)
      ||taskLocation!==undefined&&JSON.stringify(taskLocation)!==JSON.stringify(storedTaskLocation(db.get(),task.id));
    const syncChanged=syncTarget!==undefined&&(!sameFieldValue(syncTarget?.accountId,task.target_caldav_account_id)
      ||!sameFieldValue(syncTarget?.listUrl,task.target_caldav_list_url));
    const noOccurrenceChange=!definitionChanged&&status===task.status&&!(archiveRequested&&!task.archived_at)&&!syncChanged;
    assertScoringProgressIntent(task,req.body,editedSubtasks,{performersChanged:performersChanged||bindingChanged});
    if(noOccurrenceChange&&editScope!=='future')
      return res.json({data:hydrateTask(task,req.authUserId||req.session.userId),unchanged:true});
    if(historical&&editScope!=='future'&&definitionChanged&&taskSeriesState(db.get(),task.id))
      return res.status(409).json({error:'This historical occurrence is preserved. Apply definition changes to future occurrences instead.',code:409});

    // Wie in PATCH umfasst die Transaktion auch die Serien-Bewegung: eine
    // gespeicherte Aufgabe ohne die Folgeinstanz, die zu ihr gehört, wäre
    // derselbe stille Serienabbruch, den dieser Weg gerade erst verloren hat.
    let pending = false;
    let undone  = 0;
    let updated;
    let seriesEdit;
    let unchanged=false;
    let rotationChanges={preserved:[]};
    db.get().transaction(() => {
      const current=db.get().prepare('SELECT * FROM tasks WHERE id=?').get(task.id);
      if(!current)throw new TaskStateError('Task not found.',{},404);
      assertTaskRevision(db.get(),current,req.body,{required:true,requireParent:true});
      assertTaskMutation(db.get(),req,current,req.body,{operation:'update'});
      req.validateDeviceDefinition?.({points,assigned_to:userIds,start_date,start_time,due_date,due_time,expiration_policy,is_recurring,recurrence_rule,recurrence_from_completion});
      if(req.body.card_color_choice!==undefined)freezeSeriesCardColorPolicy(db.get(),current.id);
      const series=ensureSeriesDefinition(db.get(),current.id);
      if(editScope==='future')assertSeriesEdit(db.get(),req,current,series,req.body.expected_series_revision);
      const beforeDefinition=series?captureSeriesDefinition(db.get(),current.id):null;
      if(noOccurrenceChange&&series&&definitionEqual(series.definition.data,beforeDefinition)) {
        updated=current;unchanged=true;return;
      }
      if(historicalSeriesOnly) {
        const definition=compatibleFutureDefinition(req,current,series,beforeDefinition,editedSubtasks);
        assertCompatibleFutureDefinition(req,current,series,definition,{deferRandomBinding:true});
        const createdActions=finalizeFutureActionKeys(definition);
        const revised=appendSeriesDefinition(db.get(),current.id,{expectedRevision:req.body.expected_series_revision,
          actorId:req.authUserId||req.session.userId,definition});
        if(!revised.changed){updated=current;unchanged=true;return;}
        seriesEdit={...reconcileSeriesFuture(db.get(),revised,{actor:req}),current_preserved:true};
        if(createdActions.length)seriesEdit.created_actions=createdActions;
        if(revised.changed)recordTaskActivity(db.get(),current.id,'series_edited',req.authUserId||req.session.userId,
          {title:definitionFields.title,series_id:revised.series_id,series_revision:revised.revision,
            updated_count:seriesEdit.updated.length,preserved_count:seriesEdit.preserved.length,current_preserved:true});
        updated=current;return;
      }
      if(series&&editScope==='occurrence'&&scoringMode!==current.scoring_mode) {
        const oldFuture=seriesDefinitionForGeneration(db.get(),series.series_id,series.occurrence.generation+1);
        if(!['whole_task','subtasks','legacy'].includes(oldFuture?.data.task.scoring_mode)) {
          assertSeriesEdit(db.get(),req,current,series,req.body.expected_series_revision);
          const enriched=effectiveSeriesScoringDefinition(db.get(),oldFuture).data;
          assertSeriesDefinitionMutation(db.get(),req,current,oldFuture.data,enriched);
          appendSeriesDefinition(db.get(),current.id,{expectedRevision:req.body.expected_series_revision,actorId:req.authUserId||req.session.userId,
            definition:enriched,effectiveGeneration:series.occurrence.generation+1});
        }
      }
      assertTaskScoringMutation(db.get(),current.id,scoringMutationWire(req.body,editedSubtasks,current),{scope:editScope});
      const proposal=!desiredActivityBinding?proposedTaskAssigneePolicy(db.get(),current,req.body,{category,directIds:userIds}):!bindingChanged?proposedBoundTaskCategoryPolicy(db.get(),current,req.body,readTaskActivityDefinition(db.get(),current.id),existingActivityBinding):null;
      if(proposal)persistTaskAssigneePolicy(db.get(),current.id,proposal,proposal.direct_assignee_ids);
      assertTaskWindowAction(db.get(),current.id);
      if(tripTaskState(db.get(),current.id)&&(is_recurring||desiredActivityBinding||rotationBindings.length))
        throw new TaskStateError('Trip work uses an ordinary one-off Task. Manage its schedule in Trips.',{},400);
      assertOptionalityEdit(current,is_optional);
      const tripChangedFields=Object.keys(req.body).filter(key=>['title','description','priority','due_date','due_time','is_optional'].includes(key)&&req.body[key]!==current[key]);
      if(performersChanged)tripChangedFields.push('assigned_to');
      if(taskLocation!==undefined)tripChangedFields.push('location');
      markTripTaskOverrides(db.get(),current.id,tripChangedFields);
      db.get().prepare(`
        UPDATE tasks SET
          title = ?, description = ?, category = ?, priority = ?,
          status = ?, start_date = ?, due_date = ?, due_time = ?, assigned_to = ?,
          is_recurring = ?, recurrence_rule = ?, recurrence_from_completion = ?,
          assignment_mode = ?, rotation_index = ?, rotation_group = ?, rotation_slot = ?, rotation_cycle = ?,
          points = ?, visibility = ?, countdown = ?, locked = ?, start_time = ?, expiration_policy = ?, is_optional = ?, due_date_offset_days = ?
        WHERE id = ?
      `).run(title.trim(), description, category, priority,
             task.status, start_date, due_date, due_time, firstUid,
             is_recurring ? 1 : 0, recurrence_rule, recurrence_from_completion ? 1 : 0,
             assignmentMode, rotationIndex, rotationGroup, rotationSlot || 0, rotationCycle,
             points, visibility, countdown ? 1 : 0, locked, start_time, expiration_policy, is_optional ? 1 : 0, dueDateOffset, req.params.id);
      if(req.body.card_color_choice!==undefined)setTaskCardColor(db.get(),current.id,req.body.card_color_choice);
      if(req.body.scoring_mode!==undefined)db.get().prepare('UPDATE tasks SET scoring_mode=?,scoring_review_required=0 WHERE id=?').run(scoringMode,current.id);
      applyEditedSubtasks({...task,start_date,start_time,due_date,due_time},editedSubtasks,req.authUserId||req.session.userId);
      if(rotationsChanged)db.get().prepare('UPDATE tasks SET rotation_bindings_json=? WHERE id=?').run(rotationBindingsJson,task.id);
      setAssignments(db.get(), task.id, userIds);
      if(assignmentGroup&&groupSelected){
        if(groupConfigurationChanged&&!desiredActivityBinding){const committed=selectTaskGroupMember(task.id,assignmentGroup,skillIds,
          {consumerKey:taskSeriesState(db.get(),task.id)?.series_id?`series:${taskSeriesState(db.get(),task.id).series_id}:root`:`task:${task.id}`,allowDelegation:false});
          if(committed!==groupSelected)throw new TaskSkillError('The Group changed while saving. Retry this edit.');}
        recordGroupAssignment(db.get(),task.id,assignmentGroup,groupSelected);
      }else if(assignmentGroup&&groupConfigurationChanged){
        db.get().prepare('UPDATE tasks SET assignment_group_json=? WHERE id=?').run(JSON.stringify(assignmentGroup),task.id);
      }else if(groupConfigurationChanged){
        db.get().prepare('UPDATE tasks SET assignment_group_json=NULL WHERE id=?').run(task.id);
        db.get().prepare("UPDATE task_group_assignment_decisions SET superseded_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE task_id=? AND superseded_at IS NULL").run(task.id);
      }
      setTaskSkills(db.get(), task.id, skillIds);
      updateTaskActivitySnapshotSkills(db.get(),task.id,skillIds);
      if(groupConfigurationChanged&&desiredActivityBinding&&!bindingChanged&&assignmentGroup){
        const snapshot=activitySkillSnapshot||readTaskActivityDefinition(db.get(),task.id);
        if(snapshot){snapshot.assignment_group_json=JSON.stringify(assignmentGroup);
          db.get().prepare('UPDATE task_activity_bindings SET definition_snapshot_json=? WHERE task_id=?').run(JSON.stringify(snapshot),task.id);}
      }
      if(desiredActivityBinding&&!bindingChanged&&activitySkillSnapshot&&!existingActivityBinding?.definition_snapshot_json&&!groupConfigurationChanged)
        db.get().prepare('UPDATE task_activity_bindings SET definition_snapshot_json=? WHERE task_id=?')
          .run(JSON.stringify(activitySkillSnapshot),task.id);
      setRotationMembers(db.get(), task.id, assignmentMode === 'round_robin' ? rotationUserIds : []);
      if(rotationGroup!==task.rotation_group||assignmentMode!==task.assignment_mode
        ||Number(rotationSlot||0)!==Number(task.rotation_slot||0)||Number(!!is_recurring)!==Number(!!task.is_recurring)
        ||!sameIdOrder(rotationUserIds,rotationBefore)){
        if(task.rotation_group)refreshLegacyRotationGroupMapping(db.get(),task.rotation_group);
        if(rotationGroup&&rotationGroup!==task.rotation_group)refreshLegacyRotationGroupMapping(db.get(),rotationGroup);
      }
      if (taskWindowChanged) {
        // Checklist dates copied from the parent follow its edit. Explicit
        // child-specific dates/times retain their independent meaning.
        db.get().prepare(`UPDATE tasks SET
          start_time=CASE WHEN start_time IS ? THEN ? ELSE start_time END,
          start_date=CASE WHEN start_date IS ? THEN ? ELSE start_date END,
          due_date=CASE WHEN due_date IS ? THEN ? ELSE due_date END,
          due_time=CASE WHEN due_time IS ? THEN ? ELSE due_time END
          WHERE parent_task_id=? AND archived_at IS NULL
            AND NOT EXISTS(SELECT 1 FROM trip_task_steps s WHERE s.task_id=tasks.id)
            AND NOT EXISTS(SELECT 1 FROM task_activity_support_tasks s WHERE s.task_id=tasks.id)
            AND NOT EXISTS(SELECT 1 FROM task_supervision_actions a WHERE a.counterpart_task_id=tasks.id)`)
          .run(task.start_time,start_time,task.start_date,start_date,task.due_date,due_date,task.due_time,due_time,task.id);
        const dueAt = due_date ? `${due_date}T${due_time || '23:59'}:00` : null;
        // Move the default response deadline with its due time. An earlier,
        // custom, or absent deadline remains an independent choice.
        db.get().prepare(`UPDATE planning_obligations SET due_at = ?,
          response_deadline = CASE WHEN response_deadline = due_at THEN ? ELSE response_deadline END,
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
          WHERE task_id = ? AND status IN ('pending', 'accepted')`).run(dueAt, dueAt, task.id);
      }
      if (req.body.tags !== undefined) setTags(db.get(), task.id, req.body.tags);
      if (bindingChanged) {
        if (desiredActivityBinding) {
          applyTaskActivityBinding(db.get(), task.id, {
            activityTemplateId: desiredActivityBinding.activityTemplateId,
            subjectUserId: desiredActivityBinding.subjectUserId,
            assignmentOverrideUserId: desiredActivityBinding.assignmentOverrideUserId,
            assignmentOverrideUserIds: desiredActivityBinding.assignmentOverrideUserIds,
            adoptAssigneePolicy: true,
            commitRotation: true,
            dateKey: due_date || todayInHouseholdZone(),
            activitySnapshot:(activitySkillSnapshot.assignment_policy||activitySkillSnapshot.assignment_strategy)==='group_rotation'
              ?{...activitySkillSnapshot,rotation_scope:activitySkillSnapshot.rotation_scope
                ||(taskSeriesState(db.get(),task.id)?.series_id?`series:${taskSeriesState(db.get(),task.id).series_id}`:`task:${task.id}`)}
              :activitySkillSnapshot,
          });
        } else {
          clearTaskActivityBinding(db.get(), task.id);
        }
      }
      if (syncTarget !== undefined) {
        db.get().prepare(
          'UPDATE tasks SET target_caldav_account_id = ?, target_caldav_list_url = ? WHERE id = ?'
        ).run(syncTarget?.accountId ?? null, syncTarget?.listUrl ?? null, task.id);
      }
      if (archiveRequested && !task.archived_at) setArchived(task.id, true);
      if (taskLocation !== undefined) {
        setTaskLocation(db.get(), task.id, taskLocation, req.authUserId || req.session.userId);
      }
      if(isTripStep(db.get(),task.id))refreshTripStepReminders(db.get(),task.id);

      reconcileTaskSupervision(db.get(),task.id,{actorId:req.authUserId||req.session.userId});
      const sharedWindowChanged=taskWindowChanged&&parseRotationBindings(rotationBindingsJson).length>0;
      if(rotationsChanged||sharedWindowChanged){
        rotationChanges=bindTaskRotations(db.get(),task.id,{actorId:req.authUserId||req.session.userId,scope:editScope,previousConfig:task.rotation_bindings_json,onlyMissing:!rotationsChanged});
      }
      if(rotationsChanged||sharedWindowChanged||performersChanged||editedSubtasks||bindingChanged)refreshTaskRotationRendering(db.get(),task.id);
      if(performersChanged||editedSubtasks||!sameIdOrder(skillIds,skillsBefore)) {
        const actualAssignee=db.get().prepare('SELECT assigned_to FROM tasks WHERE id=?').get(task.id)?.assigned_to;
        if(actualAssignee)assertTaskSupervisionAssignee(db.get(),task.id,actualAssignee);
      }
      if(series) {
        if(editScope==='future') {
          const definition=normalizeSeriesSchedule(captureSeriesDefinition(db.get(),task.id),series.occurrence);
          const colorBase=seriesDefinitionForGeneration(db.get(),series.series_id,series.occurrence.generation+1)?.data||series.definition.data;
          preserveFutureCardColorPolicies(definition,colorBase,req.body.card_color_choice);
          assertCompatibleFutureDefinition(req,current,series,definition,{capturedDirectIds:definition.assignee_policy?.direct_assignee_ids??null});
          const convertedFuture=convertedLegacyFutureDefinition(db.get(),task.rotation_group,
            series.series_id,series.occurrence.generation+1,definition);
          const revised=appendSeriesDefinition(db.get(),task.id,{expectedRevision:req.body.expected_series_revision,
            actorId:req.authUserId||req.session.userId,definition});
          const occurrence=recordOccurrenceDefinition(db.get(),task.id,{definitionId:revised.definition.id,
            startDate:definition.task.start_date,dueDate:definition.task.due_date});
          // A current legacy Task and its converted future definition are two
          // intentional series boundaries. Reapply the latter after this edit,
          // since the newest definition otherwise wins at every generation.
          let futureDefinition=revised.definition;
          if(revised.changed&&convertedFuture){
            db.get().prepare(`INSERT INTO task_recurrence_definitions
              (series_id,effective_generation,definition_json,actor_user_id,source_task_id)
              VALUES(?,?,?,?,?)`).run(series.series_id,series.occurrence.generation+1,JSON.stringify(convertedFuture),
                req.authUserId||req.session.userId,task.id);
            futureDefinition=seriesDefinitionForGeneration(db.get(),series.series_id,series.occurrence.generation+1);
          }
          seriesEdit=revised.changed?reconcileSeriesFuture(db.get(),{...revised,occurrence,
            definition:futureDefinition,currentDefinitionId:revised.definition.id},{actor:req})
            :{scope:'occurrence',series_id:revised.series_id,revision:revised.revision,updated:[],preserved:[]};
        } else db.get().prepare("UPDATE task_recurrence_occurrences SET exception_reason='occurrence_edit' WHERE task_id=?").run(task.id);
      } else if(is_recurring) {
        const createdSeries=ensureSeriesDefinition(db.get(),task.id);
        if(createdSeries)recordOccurrenceDefinition(db.get(),task.id,{definitionId:createdSeries.definition.id,baseline:true});
      }
      if(status!==task.status) {
        const operation=changeTaskStatus(db.get(),task.id,status,{actorId:req.authUserId||req.session.userId,
          // The adapter checked the submitted revision before this atomic edit.
          // Its definition changes above have already advanced that revision.
          requireRevision:false,
          body:{complete_remaining:req.body.complete_remaining,reset_progress:req.body.reset_progress}});
        pending=operation.pending;undone=operation.undone;
      }
      recordTaskActivity(db.get(),task.id,series ? seriesEdit?.scope==='future'?'series_edited':'occurrence_edited':'edited',
        req.authUserId||req.session.userId,{title:title.trim(),...(req.devicePrincipal?{source_device:{id:req.devicePrincipal.id,name:req.devicePrincipal.name}}:{}),...(seriesEdit?{series_id:seriesEdit.series_id,
          series_revision:seriesEdit.revision,updated_count:seriesEdit.updated.length,preserved_count:seriesEdit.preserved.length}:{})});

      // Nur was die Schreibarbeit unten braucht, liegt in der Transaktion: die
      // frische Zeile und ihre Tags (der Feldvergleich kennt tags_key). Das
      // Ausschmücken für die Antwort wartet draußen, damit die Schreibsperre
      // nicht über Lesearbeit gehalten wird.
      updated = db.get().prepare(`
        SELECT t.*, u.display_name AS assigned_name, u.avatar_color AS assigned_color,
          u.avatar_data AS assigned_avatar, ${ASSIGNED_USERS_SQL}
        FROM tasks t LEFT JOIN users u ON t.assigned_to = u.id
        WHERE t.id = ?
      `).get(req.params.id);
      attachTags([updated]);

      // Änderung an einer gespiegelten Aufgabe auf dem CalDAV-Server nachziehen (#617).
      // Die Tags reisen als kanonischer Schlüssel mit, weil sie in einer eigenen
      // Tabelle liegen und der Feldvergleich nur die Zeile selbst sieht (#586).
      pending = markTodoOutbound(
        'tasks',
        { ...task,    tags_key: tagsKey(tagsBefore) },
        { ...updated, tags_key: tagsKey(updated.tags) },
      );

      // Das Status-Dropdown im Bearbeiten-Formular hakt genauso ab wie die Checkbox -
      // also muss es die Serie genauso weiterschreiben. Grundlage ist die frisch
      // gelesene Zeile, damit im selben Zug geänderte Regel/Fälligkeit schon zählen.

      notifyTaskAssignments(db.get(), task.id, assignedBefore);
    }).immediate();

    addAssignedUsers(updated);
    attachTaskActivityBindings(db.get(), [updated]);
    attachTaskLocations(db.get(), [updated]);
    res.json({ data: req.projectDeviceTask ? req.projectDeviceTask(updated) : hydrateTask(updated,req.authUserId||req.session.userId),...(seriesEdit?{series_edit:seriesEdit}:{}),...(unchanged?{unchanged:true}:{}),
      ...(rotationChanges.preserved.length?{rotation_warning:'The current rotation order is preserved. The new configuration applies when future occurrences resolve.'}: {}) });

    if (pending || undone || syncTarget) pushToCalDAV('Änderung');
  } catch (err) {
    if (err.status && typeof res !== 'undefined') return res.status(err.status).json({ error: err.message, code: err.status, ...(err.reason?{reason:err.reason}:{}), ...err.details });
    if (err instanceof TaskActivityBindingError || err instanceof TaskLocationError || err instanceof TaskSkillError || err instanceof TaskAssignmentAvailabilityError) {
      return res.status(400).json({ error: err.message, code: 400 });
    }
    log.error('PUT /:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
}
router.put('/:id',updateTaskDefinition);

/**
 * Die Folgeinstanz, die beim Erledigen dieser Aufgabe entstanden ist (#650) -
 * oder null. Es gibt höchstens eine: der Spawn legt nur an, wenn hier nichts
 * steht.
 *
 * `parent_task_id IS NULL` ist keine Beschleunigung, sondern die Bedingung
 * selbst: `recurrence_origin_id` trägt seit #742 zwei Bedeutungen. An einer
 * Wurzelaufgabe heißt es "ich bin der nächste Durchlauf von X", an einer
 * Unteraufgabe nur "ich bin die Kopie von Y in diesem Durchlauf". Ohne die
 * Einschränkung fand das Enthaken einer Unteraufgabe der erledigten Instanz
 * deren Kopie im neuen Durchlauf, hielt sie für die Folgeinstanz und löschte
 * sie - die nächste Instanz verlor lautlos eine Unteraufgabe (#924). Nur die
 * erste Bedeutung ist eine Folgeinstanz.
 */
function recurrenceFollowupOf(taskId) {
  return db.get().prepare(
    `SELECT t.* FROM tasks t LEFT JOIN task_recurrence_occurrences o ON o.task_id=t.id
      WHERE t.recurrence_origin_id = ? AND t.parent_task_id IS NULL
        AND COALESCE(o.state,'materialized')='materialized'
      ORDER BY t.id LIMIT 1`
  ).get(taskId) ?? null;
}

/**
 * Prüft, ob Unteraufgaben einer Folgeinstanz durch den Benutzer verändert wurden
 * (editiert, erledigt, hinzugefügt oder gelöscht).
 */
function isFollowupSubtasksTouched(followup) {
  const durableBaseline=db.get().prepare('SELECT materialized_state_json FROM task_recurrence_occurrences WHERE task_id=?').get(followup.id);
  if(durableBaseline?.materialized_state_json) {
    const rows=db.get().prepare(`WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT t.id FROM tasks t JOIN tree p ON t.parent_task_id=p.id)
      SELECT t.id,t.revision,t.status,t.archived_at FROM tasks t JOIN tree ON tree.id=t.id ORDER BY t.id`).all(followup.id);
    return JSON.stringify({tasks:rows})!==durableBaseline.materialized_state_json;
  }
  // A baseline is recorded only after the complete generated tree, assignment
  // and supervision have settled. Any later revision can contain user work.
  // Older occurrences have no reliable baseline, so preserve them conservatively.
  const baseline = db.get().prepare(`SELECT details_json FROM task_activity_events
    WHERE task_id=? AND action_task_id=? AND event_type='recurrence_generated'
    ORDER BY id DESC LIMIT 1`).get(followup.id,followup.id);
  let generatedRevision;
  try { generatedRevision=JSON.parse(baseline?.details_json||'null')?.revision; } catch { return true; }
  if(!Number.isSafeInteger(generatedRevision)||generatedRevision!==followup.revision)return true;
  const originTaskId = followup.recurrence_origin_id;
  if (originTaskId && !sameIdOrder(loadTaskSkillIds(db.get(), followup.id), loadTaskSkillIds(db.get(), originTaskId))) return true;
  const originSubtasks = originTaskId ? ordinaryActivitySubtasks(db.get(), originTaskId) : [];
  const currentSubtasks = ordinaryActivitySubtasks(db.get(), followup.id);

  if (currentSubtasks.length !== originSubtasks.length) return true;

  // Supervision is regenerated from current proficiency for each occurrence.
  // It therefore must not be compared by assignee against the previous cycle,
  // but completed/edited generated work still makes undo conservative.
  const supportTasks = activitySupportTasks(db.get(), followup.id)
    .filter((support) => support.role === 'supervisor');
  const activeSupervisors = db.get().prepare(`
    SELECT user_id
      FROM task_responsibilities
     WHERE task_id = ? AND role = 'supervisor' AND status = 'active'
  `).all(followup.id);
  // The parent responsibility survives when somebody deletes generated
  // support work, giving recurrence undo a durable deletion signal.
  if (supportTasks.length !== activeSupervisors.length) return true;
  for (const support of supportTasks) {
    if (support.status !== 'open') return true;
    if (!support.recurrence_origin_id) return true;
    const origin = db.get().prepare('SELECT * FROM tasks WHERE id = ?').get(support.recurrence_origin_id);
    if (!origin) return true;

    // Normal -> supervised has no prior support Task. copyTaskActivityBinding
    // points this first support row at the prior root occurrence, while the
    // binding/responsibility data supplies its deterministic baseline.
    if (!origin.parent_task_id) {
      if (Number(origin.id) !== Number(originTaskId)
          || !matchesGeneratedActivitySupportTask(
            db.get(), followup.id, support, originTaskId,
          )) return true;
      continue;
    }
    if (
      support.title !== origin.title ||
      (support.description || '') !== (origin.description || '') ||
      support.category !== origin.category ||
      support.priority !== origin.priority ||
      support.points !== origin.points ||
      support.visibility !== origin.visibility ||
      support.due_time !== origin.due_time
    ) return true;
  }

  const originTask = originTaskId
    ? db.get().prepare('SELECT start_date,due_date,due_date_offset_days FROM tasks WHERE id = ?').get(originTaskId)
    : null;

  for (const sub of currentSubtasks) {
    if (sub.status !== 'open' || !sub.recurrence_origin_id) return true;
    const origin = originSubtasks.find((o) => o.id === sub.recurrence_origin_id);
    if (!origin) return true;
    if (!sameIdOrder(loadTaskSkillIds(db.get(), sub.id), loadTaskSkillIds(db.get(), origin.id))) return true;

    if (
      sub.title !== origin.title ||
      (sub.description || '') !== (origin.description || '') ||
      sub.category !== origin.category ||
      sub.priority !== origin.priority ||
      sub.assigned_to !== origin.assigned_to ||
      sub.points !== origin.points ||
      sub.visibility !== origin.visibility ||
      sub.due_time !== origin.due_time
    ) {
      return true;
    }

    const relativeSchedule = originTask?.due_date_offset_days != null && !!originTask.start_date;
    const subAnchorDate = (relativeSchedule ? originTask.start_date : originTask?.due_date) || origin.due_date;
    const followupAnchorDate = relativeSchedule ? followup.start_date : followup.due_date;
    const expectedStart = shiftedStartDate(origin.start_date, subAnchorDate, followupAnchorDate) ?? origin.start_date;
    const expectedDue = origin.due_date
      ? (shiftedStartDate(origin.due_date, subAnchorDate, followupAnchorDate) ?? followup.due_date)
      : null;

    if (sub.start_date !== expectedStart || sub.due_date !== expectedDue) {
      return true;
    }
  }

  return false;
}

/**
 * Nimmt die Folgeinstanz zurück, wenn ein Abhaken rückgängig gemacht wird (#650).
 * Nur unangetastete Instanzen verschwinden: hat jemand sie selbst erledigt (und
 * damit die Serie weitergeschrieben) oder ihr Unteraufgaben gegeben/erledigt/bearbeitet, steckt dort
 * Arbeit, die ein Klick auf die Vorgängerin nicht wegwerfen darf.
 * Rückgabe: Anzahl vorgemerkter CalDAV-Löschungen.
 */
function discardRecurrenceFollowupSingle(taskId) {
  const followup = recurrenceFollowupOf(taskId);
  if (!followup || followup.status !== 'open') return 0;

  if (isFollowupSubtasksTouched(followup) || recurrenceFollowupOf(followup.id)) return 0;

  // Vor dem DELETE vormerken, wie in DELETE /:id: danach sind UID und Objekt-URL
  // weg. Lokal erzeugte Folgeinstanzen sind nicht gespiegelt, dann ist das ein No-op.
  const queued = queueTodoDeletion('tasks', followup) ? 1 : 0;
  db.get().prepare('DELETE FROM tasks WHERE id = ?').run(followup.id);
  return queued;
}

function discardRecurrenceFollowup(taskId) {
  if(db.get().prepare('SELECT 1 FROM task_incomplete_closures WHERE task_id=?').get(taskId))return 0;
  const task = db.get().prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  const source = task && recurringCohortMember(task);
  if (!source?.rotation_group) return discardRecurrenceFollowupSingle(taskId);

  const cohort = recurringCohort(source);
  const followups = cohort.map((member) => recurrenceFollowupOf(member.id));
  // Group deletion is all-or-nothing. A missing or touched next occurrence means
  // the whole generated cohort is preserved.
  if (!cohort.length || followups.some((f) => !f || f.status !== 'open')) return 0;
  if (followups.some((f) => isFollowupSubtasksTouched(f) || recurrenceFollowupOf(f.id))) return 0;

  let queued = 0;
  db.get().transaction(() => {
    for (const followup of followups) queued += queueTodoDeletion('tasks', followup) ? 1 : 0;
    const placeholders = followups.map(() => '?').join(',');
    db.get().prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`).run(...followups.map((f) => f.id));
  })();
  return queued;
}

/**
 * Der Vorlauf gehört zum Durchlauf, nicht zum Kalender: beginnt eine Aufgabe
 * drei Tage vor ihrer Fälligkeit, tut sie das auch beim nächsten Mal.
 *
 * Ohne Start- oder Fälligkeitsdatum gibt es nichts zu verschieben (NULL). Der
 * zweite Fall ist erreichbar: eine erledigungsverankerte Serie (#658) läuft
 * auch ohne Fälligkeitsdatum weiter, und dann fehlt der Bezugspunkt, an dem ein
 * Vorlauf gemessen wäre.
 */
function shiftedStartDate(startDate, dueDate, nextDue) {
  if (!startDate || !dueDate) return null;
  const lead = Date.parse(`${dueDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`);
  if (!Number.isFinite(lead)) return null;
  return new Date(Date.parse(`${nextDue}T00:00:00Z`) - lead).toISOString().slice(0, 10);
}

/**
 * Schreibt die Serie weiter: nächste Instanz anlegen, wenn eine wiederkehrende
 * Aufgabe erledigt wurde. Erwartet die bereits auf 'done' gesetzte Zeile.
 *
 * Beide Wege zum Haken müssen hier durch - die Checkbox (PATCH /:id/status) und
 * das Status-Dropdown im Bearbeiten-Dialog (PUT /:id). Lag der Spawn nur im
 * einen, beendete der andere die Serie lautlos.
 *
 * Ohne Rückgabewert, anders als discardRecurrenceFollowup: die Folgeinstanz
 * entsteht ohne external_uid/external_source, markTodoOutbound lässt sie
 * deshalb liegen. Es gibt nichts zu pushen.
 *
 * Beide Aufrufer halten bereits eine Transaktion, die eigene läuft darin als
 * Savepoint. Sie bleibt trotzdem stehen: sie hält Aufgabe, Zuweisungen und Tags
 * auch dann zusammen, wenn später jemand von außerhalb einer Transaktion ruft.
 */
function spawnRecurrenceFollowupSingle(task, {expirationAnchor=false}={}) {
  if (!task || task.parent_task_id) return;
  const closure=db.get().prepare('SELECT * FROM task_incomplete_closures WHERE task_id=? AND recurrence_closed_at IS NOT NULL').get(task.id);
  if(closure?.recurrence_handled)return;
  const series=ensureSeriesDefinition(db.get(),task.id);
  if(!series)return;
  if (!isRecurrenceFrontier(db.get(),task.id)) return;
  // Höchstens eine Folgeinstanz je Erledigung - sonst legt doppeltes Abhaken nach.
  if (recurrenceFollowupOf(task.id)) {
    if(closure)db.get().prepare('UPDATE task_incomplete_closures SET recurrence_handled=1 WHERE task_id=?').run(task.id);
    return;
  }

  // Relative template occurrences recur from their own Start Date, then
  // resolve Due from the snapshotted calendar-day span. NULL deliberately
  // retains the legacy due-anchored behavior for all pre-existing Tasks.
  // Completion-relative mode still obtains its next date from completion;
  // expiration continues to supply no completion-relative anchor.
  const completedOn = closure ? todayKey(db.get(),new Date(closure.recurrence_closed_at)) : todayInHouseholdZone();
  const plan=seriesMaterializationPlan(db.get(),task,{completedOn,expirationAnchor});
  if(!plan){if(closure)db.get().prepare('UPDATE task_incomplete_closures SET recurrence_handled=1 WHERE task_id=?').run(task.id);return;}
  const sourceTask=task;
  const definition=plan.definition.data;
  task={...sourceTask,...definition.task,assigned_to:definition.assigned_user_ids[0]??null};
  const relativeSchedule=plan.relative;
  const nextStartDate=plan.start_date,nextDate=plan.due_date;
  if (!nextDate) throw new TaskStateError('The next occurrence has an invalid date window.', { reason: 'invalid_recurrence_window' });
  const occurrence=registerRecurrenceOccurrence(db.get(),task.id);
  // An early completion-relative action can calculate the very same date as
  // the occurrence being completed. Do not silently strand the series or
  // create a duplicate: reject and roll back the whole operational mutation.
  if(db.get().prepare(`SELECT 1 FROM task_recurrence_occurrences
    WHERE series_id=? AND occurrence_key=? AND state='materialized'`).get(occurrence.series_id,nextDate))throw new TaskStateError(
      'This completion would repeat an already materialized recurrence date. Complete this occurrence later or review its recurrence dates.',
      {reason:'recurrence_date_conflict',occurrence_date:nextDate});

  const rotationUserIds = definition.rotation_user_ids;
  const groupResolver=({sourceTaskId,configuration,skills,window:groupWindow,previousUserId,actionKey},commit)=>
    actionKey==='root'&&definition.binding?null:selectTaskGroupMember(sourceTaskId||sourceTask.id,configuration,skills,
      {consumerKey:`series:${occurrence.series_id}:${actionKey}`,commit,previousUserId,window:groupWindow,allowDelegation:actionKey!=='root'});
  const prepared=prepareSeriesOccurrenceWork(sourceTask,definition,plan,{qualify:qualifySeriesAssignments,asOfDate:completedOn,
    resolveGroupAssignment:context=>groupResolver(context,false)});
  const nextRotationIndex=prepared.rotation_index,followupAssignments=prepared.assigned_user_ids,nextAssignedTo=prepared.primary_user_id;
  // Die Tags gehören zur Aufgabe, nicht zum einzelnen Durchlauf (#586).
  // Ohne das Mitnehmen verlöre eine wöchentliche Aufgabe ihre Etiketten
  // beim ersten Abhaken - und zwar lautlos, weil die Folgeinstanz sonst
  // vollständig aussieht.
  const existingTags = definition.tags;
  // Unteraufgaben gehören ebenfalls zur Aufgabenstruktur (#742).
  // Beim Folgedurchlauf werden sie mit zurückgesetztem Status ('open') kopiert.
  const taskActivityBinding = definition.binding;
  const existingSubtasks = definition.subtasks;

  return db.get().transaction(() => {
    for(const context of [
      {sourceTaskId:sourceTask.id,configuration:definition.task.assignment_group_json,skills:definition.skill_ids,
        window:prepared.window,previousUserId:definition.assigned_user_ids?.[0],actionKey:'root'},
      ...definition.subtasks.map(action=>({sourceTaskId:action.source_task_id,configuration:action.task.assignment_group_json,
        skills:action.skill_ids,window:prepared.actions.find(row=>row.action_key===action.action_key)?.window,
        previousUserId:action.assigned_user_ids?.[0],actionKey:action.action_key}))
    ])if(context.configuration&&!(context.actionKey==='root'&&definition.binding)){
      const chosen=groupResolver(context,true),expected=context.actionKey==='root'?prepared.primary_user_id
        :prepared.actions.find(row=>row.action_key===context.actionKey)?.primary_user_id;
      if(chosen!==expected)throw new TaskSkillError('The Rotation Group changed while generating this occurrence. Retry.');
    }
    const newTask = db.get().prepare(`
      INSERT INTO tasks (title, description, category, priority, status,
        start_date, due_date, due_time, assigned_to, created_by, is_recurring, recurrence_rule,
        assignment_mode, rotation_index, rotation_group, rotation_slot, rotation_cycle,
        points, visibility, recurrence_from_completion, countdown, recurrence_origin_id, start_time, expiration_policy, due_date_offset_days, locked)
      VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.title, task.description, task.category, task.priority,
      nextStartDate,
      nextDate, task.due_time, nextAssignedTo, task.created_by,
      task.recurrence_rule, task.assignment_mode || 'fixed', nextRotationIndex,
      task.rotation_group || null, Number(task.rotation_slot || 0),
      Number(task.rotation_cycle || 0) + (task.rotation_group ? 1 : 0),
      task.points, task.visibility,
      // Ohne das Mitnehmen fiele die Serie ab der zweiten Instanz auf die
      // Fälligkeitsrechnung zurück - lautlos, weil die Folgeinstanz sonst
      // vollständig aussieht (wie bei den Tags oben).
      task.recurrence_from_completion ? 1 : 0,
      // Und aus demselben Grund die Countdown-Markierung (#647). Sie ist bei
      // dieser Sorte Aufgabe sogar der Anlass: „immer wieder N Jahre" (Führer-
      // schein) oder „N Tage ab Reinigung" (Luftfilter) ist eine Serie, die ab
      // Erledigung rechnet - der Countdown, der genau davon lebt, dürfte beim
      // ersten Zurücksetzen nicht verschwinden.
      task.countdown ? 1 : 0,
      task.id, task.start_time, task.expiration_policy || 'keep_overdue', task.due_date_offset_days ?? null,task.locked||0
    );
    const colorPolicy=normalizeCardColorChoice(task.card_color_policy);
    if(colorPolicy)assignNewTaskCardColor(db.get(),newTask.lastInsertRowid,{choice:colorPolicy});else assignNewTaskCardColor(db.get(),newTask.lastInsertRowid,{legacySlot:null});
    if(task.source_device_id||task.source_device_name) db.get().prepare('UPDATE tasks SET source_device_id=?,source_device_name=? WHERE id=?')
      .run(task.source_device_id??null,task.source_device_name??null,newTask.lastInsertRowid);
    db.get().prepare('UPDATE tasks SET scoring_mode=?,scoring_review_required=? WHERE id=?')
      .run(task.scoring_mode,Number(!!task.scoring_review_required),newTask.lastInsertRowid);
    registerRecurrenceOccurrence(db.get(),Number(newTask.lastInsertRowid),{predecessorId:task.id});
    db.get().prepare('UPDATE tasks SET rotation_bindings_json=? WHERE id=?').run(task.rotation_bindings_json||'[]',newTask.lastInsertRowid);
    setAssignments(db.get(), newTask.lastInsertRowid, followupAssignments);
    if(definition.task.assignment_group_json&&!definition.binding){
      if(nextAssignedTo)recordGroupAssignment(db.get(),Number(newTask.lastInsertRowid),definition.task.assignment_group_json,nextAssignedTo);
      else db.get().prepare('UPDATE tasks SET assignment_group_json=? WHERE id=?')
        .run(definition.task.assignment_group_json,Number(newTask.lastInsertRowid));
    }
    persistCapturedTaskAssignees(db.get(),newTask.lastInsertRowid,definition.assignee_policy,followupAssignments,{rotating:task.assignment_mode==='round_robin'});
    setRotationMembers(db.get(), newTask.lastInsertRowid, task.assignment_mode === 'round_robin' ? rotationUserIds : []);
    setTags(db.get(), newTask.lastInsertRowid, existingTags);
    setTaskSkills(db.get(), newTask.lastInsertRowid,definition.skill_ids);

    for (const savedSub of existingSubtasks) {
      const sub=savedSub.task;
      const preparedSub=prepared.actions.find(action=>action.action_key===savedSub.action_key);
      const subDueDate=preparedSub.window.due_date,subAssignments=preparedSub.assigned_user_ids,subAssignedTo=preparedSub.primary_user_id;
      const subTags = savedSub.tags;
      const priorAction=db.get().prepare(`SELECT t.id FROM task_recurrence_actions a JOIN tasks t ON t.id=a.task_id
        WHERE a.occurrence_task_id=? AND a.action_key=?`).get(sourceTask.id,savedSub.action_key);
      const originId=priorAction?.id??(db.get().prepare('SELECT id FROM tasks WHERE id=?').get(savedSub.source_task_id??null)?.id??null);
      const checklistItemId=sub.activity_template_checklist_item_id
        && db.get().prepare('SELECT id FROM activity_template_checklist_items WHERE id=?').get(sub.activity_template_checklist_item_id)?.id||null;
      const originalCreator=seriesActionAuthorization(db.get(),savedSub).created_by;
      const creator=originalCreator==null?null:db.get().prepare('SELECT id FROM users WHERE id=?').get(originalCreator)?.id??null;

      const newSub = db.get().prepare(`
        INSERT INTO tasks (title, description, category, priority, status,
          start_date, due_date, due_time, assigned_to, created_by, parent_task_id,
          is_recurring, recurrence_rule, points, visibility, recurrence_origin_id, activity_template_checklist_item_id, start_time, expiration_policy, is_optional,sort_order,locked)
        VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?, ?,?,?)
      `).run(
        sub.title, sub.description, sub.category, sub.priority,
        preparedSub.window.start_date,
        subDueDate,
        sub.due_time, subAssignedTo, creator, newTask.lastInsertRowid,
        sub.points, sub.visibility, originId, checklistItemId, sub.start_time, sub.expiration_policy || 'keep_overdue', sub.is_optional || 0,sub.sort_order||0,sub.locked||0
      );
      const childColor=normalizeCardColorChoice(sub.card_color_policy);
      assignNewTaskCardColor(db.get(),newSub.lastInsertRowid,childColor?{choice:childColor}:{inheritFrom:newTask.lastInsertRowid});
      registerSeriesAction(db.get(),Number(newSub.lastInsertRowid),Number(newTask.lastInsertRowid),savedSub.action_key);
      setAssignments(db.get(), newSub.lastInsertRowid, subAssignments);
      if(sub.assignment_group_json)
        recordGroupAssignment(db.get(),Number(newSub.lastInsertRowid),sub.assignment_group_json,subAssignedTo);
      persistCapturedTaskAssignees(db.get(),newSub.lastInsertRowid,savedSub.assignee_policy,subAssignments);
      setTags(db.get(), newSub.lastInsertRowid, subTags);
      setTaskSkills(db.get(),newSub.lastInsertRowid,savedSub.skill_ids);
      notifyTaskAssignments(db.get(), Number(newSub.lastInsertRowid));
    }

    if (taskActivityBinding) {
      applyTaskActivityBinding(db.get(), Number(newTask.lastInsertRowid), {
        activityTemplateId:taskActivityBinding.activity_template_id,
        subjectUserId:taskActivityBinding.subject_user_id,
        assignmentOverrideUserId:taskActivityBinding.assignment_override_user_id,
        activitySnapshot:taskActivityBinding.snapshot,
        allowInactive:true,materializeChecklist:false,
        supportOriginTaskId:activitySupportTasks(db.get(),sourceTask.id).find(row=>row.role==='supervisor')?.id??sourceTask.id,
        commitRotation: sourceTask.status!=='skipped'||!taskSkipHasRotationScope(db.get(),sourceTask),
        dateKey: nextDate,
      });
    }
    if(definition.location) {
      const location=definition.location;
      db.get().prepare(`INSERT INTO task_locations(task_id,kind,place_id,external_provider,external_place_id,user_label,manual_address,latitude,longitude,created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(newTask.lastInsertRowid,location.kind,location.place_id,location.external_provider,location.external_place_id,
        location.user_label,location.manual_address,location.latitude,location.longitude,sourceTask.created_by);
    }
    if(definition.planning && !taskActivityBinding) {
      const planning=definition.planning;
      db.get().prepare('INSERT INTO task_planning_context(task_id,place_id,presence_policy,presence_window,source) VALUES(?,?,?,?,?)')
        .run(newTask.lastInsertRowid,planning.place_id,planning.presence_policy,planning.presence_window,planning.source);
    }
    bindTaskRotations(db.get(),Number(newTask.lastInsertRowid),{actorId:task.created_by,sharedPreviewOnly:sourceTask.status==='skipped'});
    applyTaskRotationRendering(db.get(),Number(newTask.lastInsertRowid),definition.rotation_rendering);
    reconcileTaskSupervision(db.get(),Number(newTask.lastInsertRowid),{actorId:task.created_by});
    notifyTaskAssignments(db.get(), Number(newTask.lastInsertRowid));
    recordTaskActivity(db.get(),Number(newTask.lastInsertRowid),'recurrence_generated',task.created_by,
      {title:task.title,revision:db.get().prepare('SELECT revision FROM tasks WHERE id=?').get(newTask.lastInsertRowid).revision});
    recordOccurrenceDefinition(db.get(),Number(newTask.lastInsertRowid),{definitionId:plan.definition.id,startDate:nextStartDate,dueDate:nextDate,baseline:true});
    if(closure)db.get().prepare('UPDATE task_incomplete_closures SET recurrence_handled=1 WHERE task_id=?').run(sourceTask.id);
    return Number(newTask.lastInsertRowid);
  })();
}

function spawnRecurrenceFollowup(task) {
  return db.get().transaction(()=>spawnRecurrenceFollowupLocked(task?.id)).immediate();
}

function recurringCohortMember(task) {
  const state=taskSeriesState(db.get(),task.id);
  const definition=state && seriesDefinitionForGeneration(db.get(),state.series_id,state.occurrence.generation+1);
  if(!definition)return {...task,series_rotation_user_ids:loadRotationUserIds(db.get(),task.id)};
  return {...task,...definition.data.task,
    start_date:state.occurrence.planned_start_date,due_date:state.occurrence.planned_due_date,
    series_rotation_user_ids:definition.data.rotation_user_ids};
}

function recurringCohort(task) {
  // Occurrence-only group/roster/date edits do not change the durable cohort.
  // Include historical definition matches, then resolve the authoritative
  // effective version below; this keeps the ordinary non-group path small.
  return db.get().prepare(`
    SELECT t.* FROM tasks t
     WHERE t.rotation_cycle = ? AND t.parent_task_id IS NULL
       AND (t.rotation_group = ? COLLATE NOCASE OR EXISTS(
         SELECT 1 FROM task_recurrence_occurrences o JOIN task_recurrence_definitions d ON d.series_id=o.series_id
          WHERE o.task_id=t.id AND json_extract(d.definition_json,'$.task.rotation_group') = ? COLLATE NOCASE))
  `).all(task.rotation_cycle,task.rotation_group,task.rotation_group)
    .map(recurringCohortMember)
    .filter(member=>member.rotation_group?.toLowerCase()===task.rotation_group.toLowerCase())
    .sort((left,right)=>left.rotation_slot-right.rotation_slot||left.id-right.id);
}

/** Resolves already materialized work after its preceding Rotation frontier
 * settles. Existing snapshots are untouched, even when their Task is a series
 * exception. This runs only in mutation/reconciliation transactions. */
function resumePendingSeriesRotations(taskId,{all=false}={}) {
  const occurrence=registerRecurrenceOccurrence(db.get(),taskId);
  if(!occurrence)return [];
  const candidates=db.get().prepare(`SELECT o.* FROM task_recurrence_occurrences o JOIN tasks t ON t.id=o.task_id
    WHERE o.series_id=? AND o.state='materialized' AND o.generation>=? AND t.archived_at IS NULL AND t.status NOT IN ('done','expired','skipped','closed_incomplete')
    AND EXISTS(SELECT 1 FROM json_each(t.rotation_bindings_json) purpose WHERE NOT EXISTS(
      SELECT 1 FROM task_rotation_occurrences link WHERE link.task_id=t.id AND link.retired_at IS NULL
      AND link.purpose_key=json_extract(purpose.value,'$.purpose_key'))) ORDER BY o.generation,o.task_id`)
    .all(occurrence.series_id,all?0:occurrence.generation+1);
  const resolved=[];
  for(const candidate of candidates) {
    const task=db.get().prepare('SELECT * FROM tasks WHERE id=?').get(candidate.task_id);
    const pristine=!seriesOccurrencePreservationReason(db.get(),candidate,task);
    const authoritative=seriesDefinitionForGeneration(db.get(),candidate.series_id,candidate.generation);
    const exception=authoritative&&!rotationBindingsEqual(task.rotation_bindings_json,authoritative.data.task.rotation_bindings_json);
    const result=bindTaskRotations(db.get(),task.id,{actorId:task.created_by,onlyMissing:true,scope:exception?'preserved':'materialize'});
    if(result.resolved?.length) {
      applyTaskRotationRendering(db.get(),task.id);
      if(pristine)recordOccurrenceDefinition(db.get(),task.id,{definitionId:candidate.definition_id,exceptionReason:candidate.exception_reason,baseline:true});
      resolved.push(task.id);
    }
  }
  return resolved;
}

function spawnRecurrenceFollowupLocked(taskId) {
  const source=db.get().prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
  if(!source||!isTerminalRecurrenceOccurrence(source))return;
  if(source.status!=='skipped')resumePendingSeriesRotations(source.id);
  if(!isRecurrenceFrontier(db.get(),source.id))return;
  if(source.status==='skipped') {
    const unsupported=taskSkipUnsupportedReason(db.get(),source);
    if(unsupported)throw new TaskStateError(unsupported,{reason:'skip_unsupported'});
  }
  const task=recurringCohortMember(source);
  if (!task?.rotation_group) return spawnRecurrenceFollowupSingle(task);

  const cohort=recurringCohort(task);
  if (!cohort.length || cohort.some((member) => !isTerminalRecurrenceOccurrence(member))) return;
  if (cohort.some(member=>member.status==='expired'&&member.recurrence_from_completion))return;
  if (cohort.some((member) => !isRecurrenceFrontier(db.get(),member.id))) return;
  if (cohort.some((member) => recurrenceFollowupOf(member.id))) return;

  const roster = cohort[0].series_rotation_user_ids;
  if (roster.length < 2) throw new Error('Rotation group has no valid member roster.');
  for (const member of cohort) {
    if (!sameIdOrder(member.series_rotation_user_ids, roster)
        || !sameRecurrenceDateAnchor(member, cohort[0])
        || member.recurrence_rule !== cohort[0].recurrence_rule
        || Number(member.recurrence_from_completion || 0) !== Number(cohort[0].recurrence_from_completion || 0)
        || (member.due_date ?? null) !== (cohort[0].due_date ?? null)
        || (member.due_time ?? null) !== (cohort[0].due_time ?? null)
        || Number(member.rotation_index || 0) !== Number(cohort[0].rotation_index || 0)) {
      throw new Error('Rotation group cohort is inconsistent; refusing a partial advance.');
    }
  }

  // Nested transaction becomes a savepoint when called from PUT/PATCH. Either
  // every next position is generated or none are.
  db.get().transaction(() => {
    for (const member of cohort) spawnRecurrenceFollowupSingle(member,{expirationAnchor:cohort.some(row=>row.status==='expired')});
  })();
}

/** Explicit mutation/reconciliation entry point. GETs never materialize Tasks.
 * The caller may name any historical member; only its latest surviving
 * materialized frontier may advance. Archive alone never moves that frontier. */
export function reconcileTaskRecurrence(taskId) {
  return db.get().transaction(()=>{
    const resolved_rotation_task_ids=resumePendingSeriesRotations(Number(taskId),{all:true});
    const before=recurrenceFrontier(db.get(),Number(taskId));
    if(!before)return {frontier_task_id:null,generated_task_ids:[]};
    const prior=new Set(db.get().prepare('SELECT task_id FROM task_recurrence_occurrences').all().map(row=>row.task_id));
    try {spawnRecurrenceFollowupLocked(before.id);}
    catch(error) {
      if(error.details?.reason==='recurrence_date_conflict')return {frontier_task_id:before.id,generated_task_ids:[],
        reason:error.details.reason,explanation:error.message};
      throw error;
    }
    return {frontier_task_id:recurrenceFrontier(db.get(),before.id)?.id||null,resolved_rotation_task_ids,
      generated_task_ids:db.get().prepare("SELECT task_id FROM task_recurrence_occurrences WHERE state='materialized'").all().map(row=>row.task_id).filter(id=>!prior.has(id))};
  }).immediate();
}

// --------------------------------------------------------
// PATCH /api/v1/tasks/:id/status
// Status einer Aufgabe schnell wechseln (z.B. Swipe-Geste / Checkbox).
// Body: { status: 'open' | 'in_progress' | 'done' | 'archived' }
// Response: { data: { id, status, archived_at } }
// 'archived' legt die Aufgabe ab, ohne ihren Status anzufassen (#688).
// --------------------------------------------------------
router.post('/:id/skip', (req,res)=>{
  try {
    const result=skipTaskOccurrence(db.get(),Number(req.params.id),{principal:req,body:req.body});
    if(result.recurrenceError)log.warn('Skipped occurrence awaits recurrence recovery:',result.recurrenceError.message);
    res.json({data:hydrateTask(result.task,req.authUserId||req.session.userId),replayed:result.replayed,recurrence_pending:result.recurrencePending});
  } catch(error) {res.status(error.status||500).json({error:error.message,code:error.status||500,...error.details});}
});

router.post('/:id/close-incomplete', (req,res)=>{
  try {
    const result=closeIncompleteTask(db.get(),Number(req.params.id),{principal:req,body:req.body});
    res.json({data:hydrateTask(result.task,req.authUserId||req.session.userId),replayed:result.replayed});
  } catch(error) {res.status(error.status||500).json({error:error.status?error.message:'The activity could not be closed.',code:error.status||500,...error.details});}
});

router.post('/:id/reopen-incomplete', (req,res)=>{
  try {
    const result=reopenIncompleteTask(db.get(),Number(req.params.id),{principal:req,body:req.body});
    res.json({data:hydrateTask(result.task,req.authUserId||req.session.userId),replayed:result.replayed});
  } catch(error) {res.status(error.status||500).json({error:error.status?error.message:'The activity could not be reopened.',code:error.status||500,...error.details});}
});

router.post('/:id/reopen', (req,res)=>{
  try {
    const errors=validateTaskInput(req.body,false);
    if(errors.length)return res.status(400).json({error:errors.join(' '),code:400});
    const task=reopenExpiredTask(db.get(),Number(req.params.id),{actorId:req.authUserId||req.session.userId,body:req.body});
    res.json({data:hydrateTask(task,req.authUserId||req.session.userId)});
  } catch(error) {res.status(error.status||500).json({error:error.message,code:error.status||500,...error.details});}
});

router.patch('/:id/status', (req,res) => {
  try {
    const previous=db.get().prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
    if(!previous||!mayAccessTask(previous,req.authUserId||req.session.userId))
      return res.status(404).json({error:'Task not found.',code:404});
    if(req.body.status===ARCHIVE_STATUS) {
      if(!mayEditTaskDefinition(previous,req))return res.status(403).json(LOCKED_ERROR);
      assertTaskMutation(db.get(),req,previous,req.body,{operation:'archive'});
      const archived_at=db.get().transaction(()=>{
        const value=setArchived(previous.id,true);
        reconcileTaskSupervision(db.get(),previous.id,{actorId:req.authUserId||req.session.userId});
        return value;
      })();
      return res.json({data:{...previous,archived_at,revision:db.get().prepare('SELECT revision FROM tasks WHERE id=?').get(previous.id).revision}});
    }
    const result=changeTaskStatus(db.get(),Number(req.params.id),req.body.status,
      {actorId:req.authUserId||req.session.userId,body:req.body});
    const task=withTaskReadSnapshot(db.get(),req.authUserId||req.session.userId,()=>{
      if(!mayAccessTask(result.task,req.authUserId||req.session.userId))
        throw new TaskStateError('Task not found.',{},404);
      const supervisionViews=new Map();
      const task=hydrateTask(result.task,req.authUserId||req.session.userId,supervisionViews);
      if(result.parent_task && mayAccessTask(result.parent_task,req.authUserId||req.session.userId))
        task.parent_task=hydrateTask(result.parent_task,req.authUserId||req.session.userId,supervisionViews);
      // A helper checkbox mutates its linked source action. Return its visible
      // helper checklist too, so that detail can acknowledge the canonical state
      // without another read. Keep authorization on each parent independently.
      if(task.is_supervision_projection && task.supervision_action?.counterpart_task_id===task.id
        && task.parent_task_id && task.parent_task_id!==result.parent_task?.id) {
        const projectionParent=db.get().prepare('SELECT * FROM tasks WHERE id=?').get(task.parent_task_id);
        if(projectionParent && mayAccessTask(projectionParent,req.authUserId||req.session.userId))
          task.projection_parent_task=hydrateTask(projectionParent,req.authUserId||req.session.userId,supervisionViews);
      }
      return task;
    });
    res.json({data:task});
    if(result.pending||result.undone)pushToCalDAV('Statuswechsel');
  } catch(err) {
    if(err.status||err.code===409)return res.status(err.status||409).json({error:err.message,code:err.status||409,...(err.reason?{reason:err.reason}:{}),...err.details});
    log.error('PATCH /:id/status error:',err);
    res.status(500).json({error:'Internal server error.',code:500});
  }
});

// --------------------------------------------------------
// PATCH /api/v1/tasks/:id/archive
// Aufgabe ablegen oder zurückholen (#688).
// Body: { archived: boolean }  (fehlt/true = ablegen, wie bei den Dokumenten)
// Response: { data: { id, status, archived_at } }
// --------------------------------------------------------
router.patch('/:id/archive', (req, res) => {
  try {
    // Ganze Zeile statt id+status: die Sichtbarkeit und die Sperre stehen in
    // Feldern, die die schmale Auswahl nicht mitbrachte.
    const task = db.get().prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found.', code: 404 });
    // 404 statt 403: ob es die Aufgabe gibt, ist selbst schon eine Auskunft.
    // Dieser Weg hat das nie geprueft - eine geratene id genuegte, um eine
    // fremde private Aufgabe abzulegen (Muster aus #769).
    if (!mayAccessTask(task, req.authUserId || req.session.userId)) {
      return res.status(404).json({ error: 'Task not found.', code: 404 });
    }
    // Ablegen nimmt die Aufgabe allen aus der Ansicht (#830).
    if (!mayEditTaskDefinition(task, req)) return res.status(403).json(LOCKED_ERROR);

    if (req.body.archived !== undefined && typeof req.body.archived !== 'boolean')
      return res.status(400).json({ error: 'archived must be a boolean.', code: 400 });

    // Der Status bleibt unangetastet - eine zurückgeholte Aufgabe steht wieder
    // genau dort, wo sie beim Ablegen stand.
    const archivedAt = db.get().transaction(() => {
      const value = setArchived(task.id, req.body.archived !== false);
      reconcileTaskSupervision(db.get(), task.id, { actorId: req.authUserId || req.session.userId });
      return value;
    })();
    res.json({ data: { id: task.id, status: task.status, archived_at: archivedAt,
      revision: db.get().prepare('SELECT revision FROM tasks WHERE id=?').get(task.id).revision } });
  } catch (err) {
    if (err.status && typeof res !== 'undefined') return res.status(err.status).json({ error: err.message, code: err.status, ...err.details });
    log.error('PATCH /:id/archive error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

/**
 * PATCH /api/v1/tasks/:id/check
 * Einen Checklisten-Eintrag in der Beschreibung ab- oder anhaken, ohne den
 * Rest des Textes zu berühren (#917).
 *
 * DIESELBE REGEL WIE BEI DEN NOTIZEN, NICHT EINE ZWEITE. `toggleChecklistLine`
 * kommt aus public/utils/markdown-checklist.js - derselben Datei, nach der der
 * Renderer im Browser entscheidet, welche Zeile überhaupt ein Kästchen bekommt.
 * Wären das zwei Regeln, gäbe es eine Zeile, die gezeichnet, aber nicht
 * geschrieben wird (#704 hat das für die Notizen schon entschieden).
 *
 * WARUM NICHT ÜBER PUT: PUT schreibt die ganze Aufgabe. Zwei Mitglieder, die im
 * selben Moment verschiedene Punkte derselben Liste abhaken, ließen damit den
 * letzten Schreiber gewinnen - der andere Haken verschwände still. Hier ändert
 * der Server genau eine Zeile des gespeicherten Standes.
 *
 * WARUM DIE SPERRE HIER NICHT GILT (#830). Gesperrt ist, was die Aufgabe zu dem
 * macht, was sie ist - nicht der Vermerk, wie weit sie gediehen ist. Genau
 * dieselbe Grenze zieht `PATCH /:id/status`, der ebenfalls ohne
 * `mayEditTaskDefinition` auskommt: abhaken darf jeder, der die Aufgabe sieht.
 * Ein Haken in einer Checkliste ist derselbe Vorgang eine Ebene tiefer, und
 * `toggleChecklistLine` kann konstruktionsbedingt nichts anderes ändern als das
 * eine Zeichen zwischen den Klammern. Die SICHTBARKEIT gilt dagegen sehr wohl:
 * eine geratene id darf keine fremde private Aufgabe anfassen (Muster aus #769).
 *
 * Body: { line: number, checked: boolean, expect?: string }
 * Response: { data: { id, description } } | 409 { code: 409, reason }
 */
router.patch('/:id/check', (req, res) => {
  try {
    const id   = parseInt(req.params.id, 10);
    const task = db.get().prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!task) return res.status(404).json({ error: 'Task not found.', code: 404 });
    // 404 statt 403: ob es die Aufgabe gibt, ist selbst schon eine Auskunft.
    if (!mayAccessTask(task, req.authUserId || req.session.userId)) {
      return res.status(404).json({ error: 'Task not found.', code: 404 });
    }

    const { line, checked, expect } = req.body;
    if (!Number.isInteger(line) || line < 0)
      return res.status(400).json({ error: 'Invalid line number.', code: 400 });
    if (typeof checked !== 'boolean')
      return res.status(400).json({ error: 'Invalid state.', code: 400 });
    if (expect !== undefined && expect !== null && typeof expect !== 'string')
      return res.status(400).json({ error: 'Invalid line check.', code: 400 });

    let pending = false;
    const result=db.get().transaction(()=>{
      const current=db.get().prepare('SELECT * FROM tasks WHERE id=?').get(id);
      if(!current)throw new TaskStateError('Task not found.',{},404);
      assertTaskRevision(db.get(),current,req.body,{required:true,requireParent:true});
      assertTaskMutation(db.get(),req,current,req.body,{operation:'check'});
      assertTaskWindowAction(db.get(),id);
      const result=toggleChecklistLine(current.description,line,checked,expect);
      if(!result.ok)throw new TaskStateError('The task has changed in the meantime.',{reason:result.reason});
      if(result.changed) {
        db.get().prepare('UPDATE tasks SET description=? WHERE id=?').run(result.content,id);
        pending=markTodoOutbound('tasks',current,{...current,description:result.content});
      }
      return result;
    }).immediate();
    res.json({data:{id,description:result.content}});

    if (pending) pushToCalDAV('Checklisten-Haken');
  } catch (err) {
    if (err.status && typeof res !== 'undefined') return res.status(err.status).json({ error: err.message, code: err.status, ...err.details });
    log.error('PATCH /:id/check error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// DELETE /api/v1/tasks/:id
// Aufgabe löschen (Subtasks werden per CASCADE mitgelöscht).
// Response: { ok: true }
// --------------------------------------------------------
router.delete('/:id', (req, res) => {
  try {
    // Vor dem DELETE vormerken (#617): danach sind UID und Objekt-URL weg. Die
    // per CASCADE mitgelöschten Unteraufgaben gehören dazu - eine gespiegelte
    // Aufgabe kann lokal welche bekommen haben, und die stammen dann selbst aus
    // keiner Liste, aber der Fall kostet nichts.
    const victim = db.get().prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!victim) return res.status(404).json({ error: 'Task not found.', code: 404 });
    // 404 statt 403: ob es die Aufgabe gibt, ist selbst schon eine Auskunft.
    if (!mayAccessTask(victim, req.authUserId || req.session.userId)) {
      return res.status(404).json({ error: 'Task not found.', code: 404 });
    }
    // Loeschen ist der endgueltigste Eingriff in die Definition (#830).
    if (!mayEditTaskDefinition(victim, req)) return res.status(403).json(LOCKED_ERROR);

    const doomed = db.get().prepare(
      `SELECT * FROM tasks WHERE (id = ? OR parent_task_id = ?) AND external_source = 'caldav'`
    ).all(req.params.id, req.params.id);
    const queued = doomed.reduce((n, row) => n + (queueTodoDeletion('tasks', row) ? 1 : 0), 0);

    const result = db.get().transaction(() => {
      // Preserve proven series identity before ON DELETE SET NULL severs the
      // legacy predecessor chain. Older deletions never authorize hole filling.
      registerRecurrenceOccurrence(db.get(),Number(req.params.id));
      const survivingSources = deleteTaskSupervisionProjections(db.get(), Number(req.params.id));
      const removed = db.get().prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
      for (const sourceId of survivingSources) reconcileTaskSupervision(db.get(), sourceId, { actorId: req.authUserId || req.session.userId });
      return removed;
    })();
    if (result.changes === 0)
      return res.status(404).json({ error: 'Task not found.', code: 404 });
    res.json({ ok: true });

    if (queued) pushToCalDAV('Löschung');
  } catch (err) {
    if (err.status && typeof res !== 'undefined') return res.status(err.status).json({ error: err.message, code: err.status, ...err.details });
    log.error('DELETE /:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// Verknüpfte Dokumente (#503)
// Dokumente aus dem Dokumente-Modul können optional mit einer Aufgabe
// verbunden werden. Die Sichtbarkeit spiegelt documents.js: sichtbar ist ein
// Dokument nur für Ersteller:in, bei visibility='family' oder über einen
// expliziten Freigabe-Eintrag (family_document_access).
// --------------------------------------------------------

// Sichtbarkeits-Fragment für ein Dokument (Alias `d`, benannter Bind @me).
const DOC_VISIBLE_SQL = documentVisibleSql('d', 'me');

/** Aufgabe nur zurückgeben, wenn sie für die betrachtende Person sichtbar ist. */
function findVisibleTask(id, me) {
  return db.get().prepare(`
    SELECT t.* FROM tasks t
    WHERE t.id = ? AND ${taskVisibilityWhere(db.get(), me, 't')}
  `).get(id, me, me);
}

function taskMutationVersion(taskId) {
  const row=db.get().prepare(`SELECT t.revision AS task_revision,p.revision AS task_parent_revision
    FROM tasks t LEFT JOIN tasks p ON p.id=t.parent_task_id WHERE t.id=?`).get(taskId);
  return row || {};
}

/** Für die Person sichtbare, mit der Aufgabe verknüpfte Dokumente. */
function loadTaskDocuments(taskId, me) {
  return db.get().prepare(`
    SELECT d.id, d.name, d.category, d.original_name, d.mime_type, d.file_size,
           d.storage_backend, td.created_at AS linked_at
    FROM task_documents td
    JOIN family_documents d ON d.id = td.document_id
    WHERE td.task_id = @taskId AND d.status != 'archived' AND ${DOC_VISIBLE_SQL}
    ORDER BY d.name COLLATE NOCASE ASC
  `).all({ taskId, me });
}

// --------------------------------------------------------
// GET /api/v1/tasks/:id/completions
// Wann diese Aufgabe zuletzt erledigt wurde - über die ganze Wiederholungskette
// hinweg, nicht nur für die Instanz, die gerade offen daliegt (#791).
// Query: limit? (1..100, Default 20)
// Response: { data: [Eintrag] }
//
// Erst die Aufgabe selbst prüfen, dann ihre Serie: die Einträge tragen den
// Titel der Aufgabe, und eine geratene ID darf darüber nichts verraten - 404
// statt 403, weil die bloße Existenz schon eine Auskunft ist (Muster aus #769).
// --------------------------------------------------------
router.post('/:id/supervisor',(req,res)=>{
  try {
    const me=req.authUserId||req.session.userId;
    const task=db.get().prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
    if(!task||!mayAccessTask(task,me))return res.status(404).json({error:'Task not found.',code:404});
    const source=db.get().prepare('SELECT * FROM tasks WHERE id=?').get(taskSupervisionRootId(db.get(),task.id));
    if(!source||!mayAccessTask(source,me))return res.status(404).json({error:'Task not found.',code:404});
    if(!taskSupervisionManagementAllowed(db.get(),req,source.id))
      return res.status(403).json({error:'Only the Task creator or a household administrator with assignment permission can choose its supervisor.',code:403});
    if(req.body.action_task_id!==undefined) {
      const actionId=req.body.action_task_id;
      if(!Number.isSafeInteger(actionId)||actionId<1||taskSupervisionRootId(db.get(),actionId)!==source.id)
        return res.status(400).json({error:'Choose an action belonging to this Task.',code:400});
    }
    const supervisor=req.body.supervisor_user_id;
    if(supervisor!==null && (!Number.isSafeInteger(supervisor)||supervisor<1))
      return res.status(400).json({error:'Choose a household supervisor.',code:400});
    db.get().transaction(()=>{
      assertTaskRevision(db.get(),task,req.body,{required:true});
      if(source.id!==task.id)
        assertTaskRevision(db.get(),source,{expected_revision:req.body.expected_source_revision},{required:true});
      reconcileTaskSupervision(db.get(),source.id,{actorId:me,supervisorUserId:supervisor});
    })();
    res.json({data:hydrateTask(task,me)});
  }catch(error){res.status(error.status||400).json({error:error.message,code:error.status||400,...error.details});}
});

router.post('/:id/rotation/reconcile',(req,res)=>{
  try {
    const me=req.authUserId||req.session.userId;
    const task=db.get().prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
    if(!task||!mayAccessTask(task,me))return res.status(404).json({error:'Task not found.',code:404});
    assertCapability(db.get(),req,'rotations.configure');
    if(!taskCapabilities(db.get(),req,task).edit)return res.status(403).json({error:'Your household permissions do not allow editing this Activity.',code:403});
    if(task.archived_at||['done','expired','skipped','closed_incomplete'].includes(task.status))return res.status(409).json({error:'Historical rotation evidence is preserved. Resolve a current occurrence instead.',code:409});
    const result=db.get().transaction(()=>{
      assertTaskRevision(db.get(),task,req.body,{required:true});
      const result=bindTaskRotations(db.get(),task.id,{actorId:me});
      // Use this occurrence's surviving field bindings, so an explicit retry
      // cannot restore text that was manually detached by an occurrence edit.
      applyTaskRotationRendering(db.get(),task.id);
      return result;
    }).immediate();
    res.json({data:hydrateTask(task,me),...result});
  }catch(error){res.status(error.status||400).json({error:error.message,code:error.status||400,...error.details});}
});

router.get('/:id/activity',(req,res)=>{
  const me=req.authUserId||req.session.userId;
  const task=db.get().prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if(!task||!mayAccessTask(task,me))return res.status(404).json({error:'Task not found.',code:404});
  const events=taskActivity(db.get(),task.id,req.query.limit).filter(event=>
    event.action_task_id ? mayAccessTask(db.get().prepare('SELECT * FROM tasks WHERE id=?').get(event.action_task_id),me)
      : event.actor_user_id===me);
  res.json({data:events});
});

router.get('/:id/completions', (req, res) => {
  try {
    const me = req.authUserId || req.session.userId;
    const task = db.get().prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!task || !mayAccessTask(task, me)) {
      return res.status(404).json({ error: 'Task not found.', code: 404 });
    }
    res.json({ data: occurrenceHistory(db.get(), { me, taskId: Number(req.params.id), limit: req.query.limit }) });
  } catch (err) {
    if (err.status && typeof res !== 'undefined') return res.status(err.status).json({ error: err.message, code: err.status, ...err.details });
    log.error('GET /:id/completions error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// GET /api/v1/tasks/:id/documents → { data: LinkedDocument[] }
router.get('/:id/documents', (req, res) => {
  try {
    const me = req.authUserId || req.session.userId;
    const task = findVisibleTask(req.params.id, me);
    if (!task) return res.status(404).json({ error: 'Task not found.', code: 404 });
    res.json({ data: loadTaskDocuments(task.id, me), ...taskMutationVersion(task.id) });
  } catch (err) {
    if (err.status && typeof res !== 'undefined') return res.status(err.status).json({ error: err.message, code: err.status, ...err.details });
    log.error('GET /:id/documents error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// PUT /api/v1/tasks/:id/documents  Body: { document_ids: number[] }
// Replace-Set: setzt die Verknüpfungen neu. Es werden nur für die Person
// sichtbare Dokumente verknüpft; ebenso werden nur sichtbare Alt-Verknüpfungen
// ersetzt — unsichtbare (z.B. private Dokumente anderer) bleiben unberührt.
router.put('/:id/documents', (req, res) => {
  try {
    const me = req.authUserId || req.session.userId;
    const task = findVisibleTask(req.params.id, me);
    if (!task) return res.status(404).json({ error: 'Task not found.', code: 404 });
    // Angehaengte Dokumente sind Teil der Anweisung - die Anleitung, das
    // Formular, der Zettel, auf den die Aufgabe verweist (#830).
    if (!mayEditTaskDefinition(task, req)) return res.status(403).json(LOCKED_ERROR);

    const requested = Array.isArray(req.body.document_ids)
      ? [...new Set(req.body.document_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
      : [];

    const canSee = db.get().prepare(`SELECT 1 FROM family_documents d WHERE d.id = @id AND ${DOC_VISIBLE_SQL}`);
    const visibleIds = requested.filter((id) => canSee.get({ id, me }));

    db.get().transaction(() => {
      // Nur die für diese Person sichtbaren Alt-Verknüpfungen entfernen.
      db.get().prepare(`
        DELETE FROM task_documents
        WHERE task_id = @taskId AND document_id IN (
          SELECT d.id FROM family_documents d WHERE ${DOC_VISIBLE_SQL}
        )
      `).run({ taskId: task.id, me });
      const ins = db.get().prepare(
        'INSERT OR IGNORE INTO task_documents (task_id, document_id, created_by) VALUES (?, ?, ?)'
      );
      for (const id of visibleIds) ins.run(task.id, id, me);
    })();

    res.json({ data: loadTaskDocuments(task.id, me), ...taskMutationVersion(task.id) });
  } catch (err) {
    if (err.status && typeof res !== 'undefined') return res.status(err.status).json({ error: err.message, code: err.status, ...err.details });
    log.error('PUT /:id/documents error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// Kommentare an Aufgaben (#734)
//
// Über eine Aufgabe wird geredet - bisher woanders, weshalb die Absprache dazu
// nirgends neben der Sache stand, um die es ging. Wer die Aufgabe sieht, darf
// mitreden; ändern und entfernen darf nur, wer geschrieben hat (Admins dürfen
// entfernen, weil sonst niemand einen Beitrag moderieren könnte).
//
// Erwähnungen (@Name) werden aus dem TEXT gelesen und nicht aus einem zweiten
// Feld: sonst wären das Hervorgehobene und das Benachrichtigte zwei Wahrheiten,
// die auseinanderlaufen, sobald jemand den Namen tippt statt ihn zu wählen.
// --------------------------------------------------------

/** Kommentare einer Aufgabe, ältester zuerst - eine Unterhaltung liest sich vorwärts. */
function loadTaskComments(taskId) {
  return db.get().prepare(`
    SELECT c.id, c.task_id, c.user_id, c.comment, c.created_at, c.updated_at,
           u.display_name AS author_name, u.avatar_color AS author_color
    FROM task_comments c
    LEFT JOIN users u ON u.id = c.user_id
    WHERE c.task_id = ?
    ORDER BY c.id ASC
  `).all(taskId);
}

/**
 * Erwähnte Personen benachrichtigen - nach der Antwort, ohne sie aufzuhalten.
 *
 * Benachrichtigt wird nur, wer die Aufgabe auch sehen darf: eine Erwähnung ist
 * kein Weg, jemandem den Titel einer privaten Aufgabe zuzustellen. Sich selbst
 * zu erwähnen löst nichts aus.
 */
function notifyMentions(task, commentRow, authorId, previousComment = '') {
  const comment = commentRow.comment;
  // DIESELBE Personenliste, die `meta/options` an den Browser gibt: dort sind
  // Haushaltshilfen ausgenommen, und der Client hebt deshalb nur diese Namen
  // hervor. Ohne den Ausschluss haette der Server jemanden benachrichtigt, den
  // die Ansicht gar nicht als erwaehnt markiert - mit dem Titel der Aufgabe und
  // dem Kommentartext in der Meldung.
  const users = db.get().prepare(`
    SELECT id, display_name FROM users u
    WHERE NOT EXISTS (SELECT 1 FROM housekeeping_workers hw WHERE hw.user_id = u.id)
  `).all();
  // Beim Nachbessern zaehlen nur die NEU dazugekommenen Namen: wer schon in der
  // ersten Fassung stand, ist benachrichtigt und bekaeme sonst bei jedem Tippfehler
  // dieselbe Meldung noch einmal.
  const schon = previousComment ? mentionedUserIds(previousComment, users) : [];
  const ids = mentionedUserIds(comment, users)
    .filter((id) => id !== authorId && !schon.includes(id));
  if (!ids.length) return;

  const author = users.find((u) => u.id === authorId)?.display_name || '';
  for (const id of ids) {
    enqueueNotification(db.get(), {
      userId: id, sourceKey: `task-comment:${commentRow.id}:mention`, category: 'tasks', entityType: 'task', entityId: task.id,
      title: task.title, body: `${author}: ${comment}`.slice(0, 300),
    });
  }
}

/** Ein Kommentar samt Aufgabe, wenn die Person ihn ändern bzw. entfernen darf. */
function commentForWrite(req, { allowAdmin = false } = {}) {
  const me = req.authUserId || req.session.userId;
  const found = findVisibleTask(req.params.id, me);
  if (!found) return { error: 404 };
  // Mit Titel, weil eine Erwaehnung beim Nachbessern dieselbe Meldung schickt
  // wie beim Schreiben - und die nennt die Aufgabe.
  const task = db.get().prepare('SELECT id, title FROM tasks WHERE id = ?').get(found.id);

  const row = db.get().prepare('SELECT * FROM task_comments WHERE id = ? AND task_id = ?')
    .get(req.params.commentId, task.id);
  if (!row) return { error: 404 };

  const mayWrite = row.user_id === me || (allowAdmin && req.authRole === 'admin');
  if (!mayWrite) return { error: 403 };
  return { task, row, me };
}

// GET /api/v1/tasks/:id/comments → { data: Comment[] }
router.get('/:id/comments', (req, res) => {
  try {
    const me = req.authUserId || req.session.userId;
    const task = findVisibleTask(req.params.id, me);
    if (!task) return res.status(404).json({ error: 'Task not found.', code: 404 });
    res.json({ data: loadTaskComments(task.id), ...taskMutationVersion(task.id) });
  } catch (err) {
    if (err.status && typeof res !== 'undefined') return res.status(err.status).json({ error: err.message, code: err.status, ...err.details });
    log.error('GET /:id/comments error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// POST /api/v1/tasks/:id/comments  Body: { comment }
router.post('/:id/comments', (req, res) => {
  try {
    const me = req.authUserId || req.session.userId;
    const task = db.get().prepare(`
      SELECT t.id, t.title FROM tasks t
      WHERE t.id = ? AND ${taskVisibilityWhere(db.get(), me, 't')}
    `).get(req.params.id, me, me);
    if (!task) return res.status(404).json({ error: 'Task not found.', code: 404 });

    // `v.str` trimmt und weist einen Kommentar aus lauter Leerzeichen ab.
    const comment = v.str(req.body.comment, 'comment', { max: v.MAX_TEXT, required: true });
    if (comment.error) return res.status(400).json({ error: comment.error, code: 400 });

    const result = db.get().prepare(
      'INSERT INTO task_comments (task_id, user_id, comment) VALUES (?, ?, ?)'
    ).run(task.id, me, comment.value);

    const row = db.get().prepare(`
      SELECT c.id, c.task_id, c.user_id, c.comment, c.created_at, c.updated_at,
             u.display_name AS author_name, u.avatar_color AS author_color
      FROM task_comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.id = ?
    `).get(result.lastInsertRowid);

    res.status(201).json({ data: row, ...taskMutationVersion(task.id) });
    notifyMentions(task, row, me);
  } catch (err) {
    if (err.status && typeof res !== 'undefined') return res.status(err.status).json({ error: err.message, code: err.status, ...err.details });
    log.error('POST /:id/comments error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// PATCH /api/v1/tasks/:id/comments/:commentId  Body: { comment }
router.patch('/:id/comments/:commentId', (req, res) => {
  try {
    const found = commentForWrite(req);
    if (found.error) {
      return res.status(found.error).json({
        error: found.error === 403 ? 'Not authorized.' : 'Comment not found.', code: found.error,
      });
    }

    const comment = v.str(req.body.comment, 'comment', { max: v.MAX_TEXT, required: true });
    if (comment.error) return res.status(400).json({ error: comment.error, code: 400 });

    db.get().prepare(`
      UPDATE task_comments
         SET comment = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = ?
    `).run(comment.value, found.row.id);

    const row = db.get().prepare(`
      SELECT c.id, c.task_id, c.user_id, c.comment, c.created_at, c.updated_at,
             u.display_name AS author_name, u.avatar_color AS author_color
      FROM task_comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.id = ?
    `).get(found.row.id);
    res.json({ data: row, ...taskMutationVersion(found.task.id) });
    // Wer beim Korrigieren jemanden dazuholt, meint ihn genauso wie beim
    // Schreiben - ohne diesen Aufruf staende der Name farbig da und niemand
    // erfuehre davon.
    notifyMentions(found.task, row, found.me, found.row.comment);
  } catch (err) {
    if (err.status && typeof res !== 'undefined') return res.status(err.status).json({ error: err.message, code: err.status, ...err.details });
    log.error('PATCH /:id/comments/:commentId error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// DELETE /api/v1/tasks/:id/comments/:commentId
router.delete('/:id/comments/:commentId', (req, res) => {
  try {
    const found = commentForWrite(req, { allowAdmin: true });
    if (found.error) {
      return res.status(found.error).json({
        error: found.error === 403 ? 'Not authorized.' : 'Comment not found.', code: found.error,
      });
    }
    db.get().prepare('DELETE FROM task_comments WHERE id = ?').run(found.row.id);
    res.json({ data: { id: found.row.id }, ...taskMutationVersion(found.task.id) });
  } catch (err) {
    if (err.status && typeof res !== 'undefined') return res.status(err.status).json({ error: err.message, code: err.status, ...err.details });
    log.error('DELETE /:id/comments/:commentId error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// GET /api/v1/tasks/meta/options
// Liefert Filteroptionen: alle User + gültige Werte für Dropdowns.
// Response: { users, priorities, statuses, categories, tags }
// --------------------------------------------------------
router.get('/meta/options', (req, res) => {
  try {
    const users = db.get().prepare(
      `SELECT id, display_name, avatar_color, avatar_data, family_role,
         (SELECT phone FROM contacts c WHERE c.family_user_id = u.id LIMIT 1) AS phone,
         (SELECT email FROM contacts c WHERE c.family_user_id = u.id LIMIT 1) AS email
       FROM users u
       WHERE NOT EXISTS (SELECT 1 FROM housekeeping_workers hw WHERE hw.user_id = u.id)
       ORDER BY display_name`
    ).all();
    res.json({
      users,
      priorities: VALID_PRIORITIES,
      statuses: VALID_STATUSES,
      categories: loadTaskCategories(),
      // Sichtbare Tags für Filterleiste und Vorschläge - beim Seitenaufbau
      // mitgeliefert, damit dafür kein zweiter Aufruf nötig ist (#586).
      tags: allTags(db.get(), req.authUserId || req.session.userId),
      default_points: defaultTaskPoints(),
    });
  } catch (err) {
    if (err.status && typeof res !== 'undefined') return res.status(err.status).json({ error: err.message, code: err.status, ...err.details });
    log.error('GET /meta/options error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// Standard-Punkte nachziehen (#578)
// Zweisegmentige Pfade — kollidieren nicht mit der /:id-Route.
// --------------------------------------------------------

// GET /api/v1/tasks/points/affected?points=N
// Wie viele nicht erledigte Hauptaufgaben stehen exakt auf diesem Punktwert?
// Vorschau für die Einstellungsseite, bevor sie den Wechsel anbietet — deshalb
// dasselbe Admin-Gate wie beim Setzen des Standards und beim Nachziehen.
router.get('/points/affected', (req, res) => {
  try {
    if (req.authRole !== 'admin') {
      return res.status(403).json({ error: 'Admin access required.', code: 403 });
    }
    const points = Number(req.query.points);
    if (!Number.isInteger(points) || points < 0 || points > MAX_POINTS) {
      return res.status(400).json({ error: `points must be an integer between 0 and ${MAX_POINTS}`, code: 400 });
    }
    res.json({ data: { count: rebasableTasks(points,req).length } });
  } catch (err) {
    if (err.status && typeof res !== 'undefined') return res.status(err.status).json({ error: err.message, code: err.status, ...err.details });
    log.error('GET /points/affected error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// POST /api/v1/tasks/points/rebase  Body: { from, to } → { data: { updated } }
// Hebt alle nicht erledigten Hauptaufgaben, die auf dem alten Standard stehen,
// auf den neuen. „Steht noch auf dem Standard" wird bewusst über den Zahlenwert
// bestimmt statt über ein verstecktes Flag: eine Aufgabe, der jemand von Hand
// exakt den alten Standardwert gegeben hat, wandert deshalb mit. Die Anzahl
// steht vorab im Bestätigungsdialog, der Wechsel ist also nie verdeckt.
router.post('/points/rebase', (req, res) => {
  try {
    if (req.authRole !== 'admin') {
      return res.status(403).json({ error: 'Admin access required.', code: 403 });
    }
    const from = Number(req.body.from);
    const to   = Number(req.body.to);
    validateScoringInput({points:req.body.from});validateScoringInput({points:req.body.to});
    const inRange = (n) => Number.isInteger(n) && n >= 0 && n <= MAX_POINTS;
    if (!inRange(from) || !inRange(to)) {
      return res.status(400).json({ error: `from and to must be integers between 0 and ${MAX_POINTS}`, code: 400 });
    }
    // 0 als Quelle würde jede punktelose Aufgabe erfassen — das ist kein
    // „nutzt noch den Standard", sondern schlicht „hat keine Punkte".
    if (from === 0) {
      return res.status(400).json({ error: 'from must be greater than 0.', code: 400 });
    }
    if (from === to) return res.json({ data: { updated: 0 } });

    const updated=db.get().transaction(()=>{
      const targets=rebasableTasks(from,req);
      for(const task of targets){assertTaskScoringMutation(db.get(),task.id,{points:to});db.get().prepare('UPDATE tasks SET points=? WHERE id=?').run(to,task.id);}
      return targets.length;
    }).immediate();
    res.json({ data: { updated } });
  } catch (err) {
    if (err.status && typeof res !== 'undefined') return res.status(err.status).json({ error: err.message, code: err.status, ...err.details });
    log.error('POST /points/rebase error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
