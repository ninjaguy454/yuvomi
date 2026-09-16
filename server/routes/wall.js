/** Wall adapters reuse canonical mutations; only identity and display projection differ. */
import express from 'express';
import rateLimit from 'express-rate-limit';
import * as db from '../db.js';
import { isPasswordLoginEnabled } from '../auth.js';
import { verifyPassword } from '../utils/password.js';
import * as twoFactor from '../services/two-factor.js';
import { hydrateTask } from './tasks.js';
import { assertTaskMutation } from '../services/task-access.js';
import { actionableSubtasks, assertTaskRevision, changeTaskStatus } from '../services/task-lifecycle.js';
import { claimTask } from '../services/assignment-responsibilities.js';
import { createRedemption } from '../services/rewards.js';
import { flushOutbound } from '../services/caldav-todo-outbound.js';
import weatherRouter from './weather.js';
import { WALL_EXIT_VERIFIED } from '../services/wall-session.js';
import { WALL_DEFAULTS,WALL_ACTIONS,WALL_IDENTITY_SECONDS,wallConfig,saveWallConfig,wallDashboard,
  householdMember,wallPermissions,assertWallModule,wallTaskVisible,publicTaskProjection,publicMember,
  wallCalendarVisible,publicCalendarEvent,wallMeal,wallShopping,wallError,
  issueWallActor,verifiedWallActor,forgetWallActor } from '../services/wall.js';

const router=express.Router();
const identifyLimit=rateLimit({windowMs:10*60_000,max:20,standardHeaders:true,legacyHeaders:false});
const DUMMY_HASH='$2b$12$invalidhashfortimingprotection000000000000000000000';
const actorToken=req=>req.get('X-Wall-Actor');
const host=req=>Number(req.authUserId);
export function wallErrorResponse(error) {
  // Canonical errors can contain an entire authenticated supervision/Availability
  // scope, including private siblings the actor owns. Wall must not serialize it.
  const details=Object.fromEntries(['reason','confirmation_required','remaining','task_id','revision']
    .filter(key=>error.details?.[key]!==undefined).map(key=>[key,error.details[key]]));
  let message=error.status?error.message:'The Wall action could not be completed.';
  if(error.details?.supervision) {
    const unresolved=error.details.supervision.actions?.some(action=>['unresolved','excluded'].includes(action.state));
    message=unresolved?'A single qualified helper is still needed before this step can be completed.'
      :'The assigned helper needs to complete this step. Use your personal Tasks view for any private requirement details.';
  }
  if(error.constructor?.name==='TaskAssignmentAvailabilityError')message='This member is not available for the Task’s completion window. Review their Availability on a personal device.';
  return {error:message,code:error.status||500,...(error.reason?{reason:error.reason}:{}),...details};
}
const guarded=handler=>(req,res,next)=>Promise.resolve().then(()=>handler(req,res,next)).catch(error=>
  res.status(error.status||500).json(wallErrorResponse(error)));
router.use((req,res,next)=>{
  res.set('Cache-Control','private, no-store');
  if(req.authMethod!=='session'||!req.sessionID||!req.session?.userId)return res.status(403).json({error:'Wall Mode requires a household browser session.',code:403});
  try{wallPermissions(db.get(),host(req));next();}catch(error){res.status(403).json({error:error.message,code:403});}
});
function actor(req) {return verifiedWallActor(db.get(),{sessionId:req.sessionID,hostId:host(req),token:actorToken(req)});}
function adminActor(req) {
  const user=actor(req);
  if(!wallPermissions(db.get(),host(req)).admin||!wallPermissions(db.get(),user.id).admin)throw wallError('A verified household administrator is required.',403);
  return user;
}
function actionActor(req,action,module) {
  const config=wallConfig(db.get());
  if(config.interaction.mode!=='interactive'||!config.interaction.actions.includes(action))throw wallError('This action is disabled on the Wall.',403);
  const user=actor(req);
  assertWallModule(db.get(),host(req),module,user.id,true);
  return user;
}
const saveSession=req=>new Promise((resolve,reject)=>typeof req.session.save==='function'?req.session.save(err=>err?reject(err):resolve()):resolve());
router.post('/enter',guarded(async(req,res)=>{req.session.wallMode=true;await saveSession(req);res.json({data:{wallMode:true}});}));
router.post('/exit',guarded(async(req,res)=>{adminActor(req);req.session[WALL_EXIT_VERIFIED]=true;delete req.session.wallMode;forgetWallActor(actorToken(req));await saveSession(req);res.json({data:{wallMode:false}});}));
router.get('/config',guarded((req,res)=>res.json({data:{config:wallConfig(db.get()),defaults:WALL_DEFAULTS,
  canConfigure:wallPermissions(db.get(),host(req)).admin,supportedActions:WALL_ACTIONS,
  identity:{method:'password',secondFactorSupported:true,expiresInSeconds:WALL_IDENTITY_SECONDS,pinSupported:false}}})));
router.put('/config',guarded((req,res)=>{adminActor(req);res.json({data:{config:saveWallConfig(db.get(),req.body)}});}));
router.post('/identify',identifyLimit,guarded(async(req,res)=>{
  const d=db.get(),password=req.body?.password;
  if(typeof password!=='string'||!password||password.length>1024)throw wallError('Enter this member’s account password.',400);
  if(!isPasswordLoginEnabled(d))throw wallError('Password identification is disabled. Use a personal signed-in device for protected actions.',403);
  const user=householdMember(d,req.body.user_id);
  const checked=await verifyPassword(password,user?.password_hash||DUMMY_HASH);
  if(!user||!checked.valid)throw wallError('The member or password is incorrect.',403,'wall_identity_invalid');
  if(twoFactor.isEnabled(d,user.id)) {
    const code=String(req.body.code||'');
    if(!code)throw wallError('Enter this member’s authenticator or recovery code.',403,'wall_second_factor_required');
    if(!twoFactor.verifySecondFactor(d,user.id,code).valid)throw wallError('That verification code is invalid or already used.',403,'wall_second_factor_invalid');
  } else if(twoFactor.isRequiredForHousehold(d))throw wallError('Set up this member’s required two-factor authentication on a personal device first.',403);
  const actor_token=issueWallActor(d,{sessionId:req.sessionID,hostId:host(req),user});
  res.json({data:{actor_token,member:publicMember(user),isAdmin:wallPermissions(d,user.id).admin,expires_in:WALL_IDENTITY_SECONDS}});
}));
router.post('/forget',guarded((req,res)=>{forgetWallActor(actorToken(req));res.json({data:{forgotten:true}});}));
router.get('/dashboard',guarded((req,res)=>res.json({data:wallDashboard(db.get(),host(req),hydrateTask)})));
router.get('/weather',guarded((req,res,next)=>{
  assertWallModule(db.get(),host(req),'weather');
  if(!wallConfig(db.get()).widgets.some(w=>w.id==='weather'&&w.visible))return res.json({data:null});
  // Reuse provider/cache with household configuration, never host's personal location.
  const forwarded=Object.create(req);forwarded.url='/';forwarded.authUserId=null;forwarded.session={};
  weatherRouter.handle(forwarded,res,next);
}));
function taskFor(req,userId=null) {
  assertWallModule(db.get(),host(req),'tasks',userId);
  const task=wallTaskVisible(db.get(),req.params.id,host(req),userId);
  if(!task)throw wallError('This Task is not available on the shared display.',404);
  return task;
}
function projectedTask(req,id,userId=null) {
  const row=wallTaskVisible(db.get(),id,host(req),userId);
  return row?publicTaskProjection(db.get(),hydrateTask(row,userId||host(req)),host(req),userId):null;
}
router.get('/tasks/:id',guarded((req,res)=>{
  const userId=actorToken(req)?actor(req).id:null;
  const task=taskFor(req,userId);
  res.json({data:projectedTask(req,task.id,userId)});
}));
router.patch('/tasks/:id/status',guarded((req,res)=>{
  const user=actionActor(req,'task_complete','tasks'),d=db.get();
  const result=d.transaction(()=>{
    const task=taskFor(req,user.id);
    // Hold the same write reservation for the public-scope check and canonical
    // mutation, so another connection cannot insert a hidden child between them.
    const mapped=d.prepare('SELECT action_task_id FROM task_supervision_actions WHERE counterpart_task_id=?').get(task.id);
    const container=d.prepare('SELECT source_task_id FROM task_activity_support_tasks WHERE task_id=?').get(task.id);
    const targets=container?d.prepare("SELECT action_task_id AS id FROM task_supervision_actions WHERE source_task_id=? AND state!='not_required'").all(container.source_task_id)
      :[{id:mapped?.action_task_id||task.id}];
    const scope=new Set();
    const collect=id=>{if(scope.has(id))return;scope.add(id);for(const child of actionableSubtasks(d,id))collect(child.id);};
    targets.forEach(row=>collect(row.id));
    if(['done','open'].includes(req.body.status)&&[...scope].some(id=>!wallTaskVisible(d,id,host(req),user.id)))throw wallError('This Task includes work that cannot be shown on the Wall. Complete it from your personal Tasks view.',403);
    return changeTaskStatus(d,task.id,req.body.status,{actorId:user.id,body:req.body});
  }).immediate();
  const data=projectedTask(req,Number(req.params.id),user.id);
  if(result.parent_task&&data)data.parent_task=projectedTask(req,result.parent_task.id,user.id);
  res.json({data});
  if(result.pending||result.undone)flushOutbound().catch(()=>{});
}));
router.post('/tasks/:id/claim',guarded((req,res)=>{
  const user=actionActor(req,'task_claim','tasks'),d=db.get();
  try {d.transaction(()=>{const task=taskFor(req,user.id);assertTaskRevision(d,task,req.body,{required:true,requireParent:true});assertTaskMutation(d,user.id,task,req.body,{operation:'claim'});claimTask(d,task.id,user.id);}).immediate();}
  catch(error){
    if(error.status)throw error;
    const safeMessages=['This task is not claimable.','This task has already been claimed.','This task was claimed by someone else.'];
    throw wallError(safeMessages.includes(error.message)?error.message:'This member cannot claim this Task with the current skills, supervision, or Availability. Review the details in their personal Tasks view.',409);
  }
  res.json({data:projectedTask(req,Number(req.params.id),user.id)});
}));
router.get('/calendar/:id',guarded((req,res)=>{
  assertWallModule(db.get(),host(req),'calendar');const row=wallCalendarVisible(db.get(),req.params.id);
  if(!row)throw wallError('This event is not available on the shared display.',404);
  res.json({data:publicCalendarEvent(row)});
}));
router.get('/meals/:id',guarded((req,res)=>{
  assertWallModule(db.get(),host(req),'meals');const row=wallMeal(db.get(),req.params.id);
  if(!row)throw wallError('This shared Meal has not been published.',404);
  res.json({data:row});
}));
router.get('/shopping/:id',guarded((req,res)=>{
  assertWallModule(db.get(),host(req),'shopping');const row=wallShopping(db.get(),req.params.id);
  if(!row)throw wallError('Shopping list not found.',404);
  res.json({data:row});
}));
router.post('/rewards/redemptions',guarded((req,res)=>{
  const user=actionActor(req,'reward_redeem','rewards');
  // The explicit actor always spends their own points. Hosting-admin authority
  // and a forged user_id never become an acting-for shortcut on a shared screen.
  const result=createRedemption(db.get(),{actorId:user.id,userId:user.id,catalogId:req.body.catalog_id,
    note:req.body.note==null?null:String(req.body.note).trim().slice(0,500)||null,requestKey:req.body.request_key||req.get('Idempotency-Key')});
  res.status(result.replayed?200:201).json({data:result.row,replayed:result.replayed});
}));
export default router;
