import express from 'express';
import rateLimit from 'express-rate-limit';
import * as db from '../db.js';
import {requireAuth} from '../auth.js';
import {requireAdmin} from '../middleware/require-admin.js';
import {generateToken,csrfMiddleware,publishCsrfToken} from '../middleware/csrf.js';
import {clientPermissions} from '../permissions.js';
import {deviceDashboard} from '../services/device-content.js';
import {deviceTaskList,deviceTaskDetail,deviceTaskStatus,deviceTaskClaim} from '../services/device-tasks.js';
import {deviceTaskCreateOnce,deviceTaskUpdate} from '../services/device-task-definitions.js';
import {beginDeviceApproval,readDeviceApproval,cancelDeviceApproval} from '../services/device-approval.js';
import {DEVICE_COOKIE,DEVICE_ACTIONS,deviceCookie,deviceError,devicePreset,publicDevice,devicePrincipal,auditDevice,
  updateDevice,revokeDevice,beginPairing,approvePairing,pairingStatus,claimPairing,readDeviceContext,assertDeviceContext,
  deviceContextPayload,isTemporaryContext,beginTemporary,returnToDevice,touchTemporary,retireBrowserSession,deviceRequestStillValid} from '../services/devices.js';

export const deviceRouter=express.Router(),devicesRouter=express.Router();
const guarded=fn=>(req,res,next)=>Promise.resolve().then(()=>fn(req,res,next)).catch(error=>res.status(error.status||500).json({error:error.status?error.message:'The display request could not be completed.',reason:error.reason||'device_error'}));
const rate=rateLimit({windowMs:10*60_000,max:30,standardHeaders:true,legacyHeaders:false});
const pollRate=rateLimit({windowMs:10*60_000,max:600,standardHeaders:true,legacyHeaders:false});
export function deviceSameOrigin(req,res,next) {
  const origin=req.get('Origin');
  let matches=true;try{if(origin)matches=new URL(origin).host===req.get('Host');}catch{matches=false;}
  if(req.get('Sec-Fetch-Site')==='cross-site'||!matches)return res.status(403).json({error:'Use this display to change its sign-in.'});
  next();
}
const save=req=>new Promise((resolve,reject)=>req.session.save(err=>err?reject(err):resolve()));
const regenerate=req=>new Promise((resolve,reject)=>req.session.regenerate(err=>err?reject(err):resolve()));
function contextResponse(req,res,ctx) {
  publishCsrfToken(req,res);
  res.set({'Cache-Control':'private, no-store','X-Auth-Context':ctx.credential.context_key});
  const data=deviceContextPayload(req,ctx);
  if(data.temporary) {
    const user=db.get().prepare('SELECT id,username,display_name,role,family_role,avatar_color,avatar_data FROM users WHERE id=?').get(ctx.credential.temporary_user_id);
    if(!user||user.role!=='admin')throw deviceError('Temporary access is no longer permitted.',403);
    data.user={...user,access_scope:'family',onboarding_pending:false};data.permissions=clientPermissions(db.get(),user);
    data.householdSize=db.get().prepare('SELECT COUNT(*) AS count FROM users WHERE NOT EXISTS(SELECT 1 FROM split_expense_guest_users g WHERE g.user_id=users.id)').get().count;
  }
  res.json(data);
}
deviceRouter.use((req,res,next)=>{res.set('Cache-Control','private, no-store');next();});
deviceRouter.use(deviceSameOrigin);
deviceRouter.post('/pair',rate,guarded(async(req,res)=>{
  if(req.session?.userId&&req.body.confirm_transition!==true)throw deviceError('Confirm that pairing will remove this browser’s personal sign-in.');
  const pair=beginPairing(db.get());req.session.devicePairSecret=pair.secret;await save(req);
  res.json({code:pair.code.match(/.{1,4}/g).join('-'),expiresAt:pair.expiresAt});
}));
deviceRouter.get('/pair',pollRate,guarded((req,res)=>res.json(pairingStatus(db.get(),req.session.devicePairSecret))));
deviceRouter.post('/pair/claim',rate,guarded(async(req,res)=>{
  if(req.body.confirm_transition!==true)throw deviceError('Confirm the transition to a paired display.');
  const d=db.get(),result=claimPairing(d,req.session.devicePairSecret);
  retireBrowserSession(d,req.sessionID);await regenerate(req);req.session.csrfToken=generateToken();await save(req);
  publishCsrfToken(req,res);
  res.cookie(DEVICE_COOKIE,result.token,{httpOnly:true,sameSite:'lax',secure:process.env.SESSION_SECURE==='true',maxAge:365*24*60*60_000,path:'/'});
  // Token is never returned in JSON, a URL, an audit row or a log.
  res.json({paired:true,device:result.device});
}));
deviceRouter.post('/launch',guarded(async(req,res)=>{
  const d=db.get(),ctx=readDeviceContext(d,req);if(!ctx)return res.json({paired:false});
  // Only a just-completed real SSO redirect can carry a one-shot login handoff.
  if(req.body.temporary_handoff===true && req.session.deviceLoginHandoff>Date.now()-30_000 &&
    (ctx.credential.temporary_sid===req.sessionID || (req.session.pendingTwoFactor && req.session.deviceLoginIntent?.expiresAt>Date.now()))) {
    delete req.session.deviceLoginHandoff;await save(req);return contextResponse(req,res,ctx);
  }
  if(req.session.deviceApprovalIntent) {
    d.prepare("UPDATE device_task_approvals SET status='cancelled' WHERE credential_id=? AND status='pending'").run(ctx.credential.id);
    delete req.session.deviceApprovalIntent;delete req.session.deviceApprovalError;delete req.session.pendingTwoFactor;delete req.session.oidc;
    await save(req);
  }
  if(ctx.credential.temporary_sid||ctx.credential.login_intent_at) {
    returnToDevice(d,ctx.credential);retireBrowserSession(d,req.sessionID);await regenerate(req);
  } else if(req.session?.userId) {retireBrowserSession(d,req.sessionID);await regenerate(req);}
  contextResponse(req,res,readDeviceContext(d,req));
}));
deviceRouter.get('/context',guarded((req,res)=>{
  const ctx=readDeviceContext(db.get(),req);if(!ctx)return res.json({paired:false});
  contextResponse(req,res,ctx);
}));
deviceRouter.use(requireAuth,csrfMiddleware);
deviceRouter.post('/temporary/begin',guarded(async(req,res)=>{beginTemporary(db.get(),req);await save(req);res.json({ok:true});}));
deviceRouter.post('/return',guarded(async(req,res)=>{
  const d=db.get(),ctx=assertDeviceContext(d,req);if(!ctx)throw deviceError('This browser is not paired.',403);
  returnToDevice(d,ctx.credential);retireBrowserSession(d,req.sessionID);await regenerate(req);
  contextResponse(req,res,readDeviceContext(d,req));
}));
deviceRouter.post('/activity',guarded((req,res)=>contextResponse(req,res,touchTemporary(db.get(),req))));
deviceRouter.use((req,res,next)=>req.devicePrincipal?next():res.status(403).json({error:'Return to the device view for display actions.'}));
deviceRouter.post('/tasks/:id/approval/begin',rate,guarded(async(req,res)=>{
  const result=beginDeviceApproval(db.get(),req,Number(req.params.id),req.body);await save(req);res.status(201).json(result);
}));
deviceRouter.get('/approval',guarded((req,res)=>res.json(readDeviceApproval(db.get(),req))));
deviceRouter.post('/approval/cancel',guarded(async(req,res)=>{
  if(!req.body?.approval_id)throw deviceError('Choose the approval to cancel.');
  const result=cancelDeviceApproval(db.get(),req,{expectedId:req.body.approval_id});await save(req);res.json(result);
}));
deviceRouter.get('/dashboard',guarded((req,res)=>{
  const d=db.get(),p=req.devicePrincipal;
  res.json({data:{...deviceDashboard(d,p),device:publicDevice(req.deviceContext.device)}});
}));
deviceRouter.get('/tasks',guarded((req,res)=>res.json({data:deviceTaskList(db.get(),req.devicePrincipal)})));
deviceRouter.post('/tasks',guarded((req,res)=>{
  const result=deviceTaskCreateOnce(db.get(),req.devicePrincipal,req.body,req.get('Idempotency-Key'));
  if(result.replayed)res.set('Idempotent-Replayed','true');
  res.status(201).json({data:result.data});
}));
deviceRouter.patch('/tasks/:id',guarded((req,res)=>res.json({data:deviceTaskUpdate(db.get(),req.devicePrincipal,Number(req.params.id),req.body)})));
deviceRouter.get('/tasks/:id',guarded((req,res)=>res.json({data:deviceTaskDetail(db.get(),req.devicePrincipal,Number(req.params.id))})));
deviceRouter.patch('/tasks/:id/status',guarded((req,res)=>res.json({data:deviceTaskStatus(db.get(),req.devicePrincipal,Number(req.params.id),req.body)})));
deviceRouter.post('/tasks/:id/claim',guarded((req,res)=>res.json({data:deviceTaskClaim(db.get(),req.devicePrincipal,Number(req.params.id),req.body)})));
deviceRouter.get('/changes',(req,res)=>{
  res.status(200).set({'Content-Type':'text/event-stream','Cache-Control':'private, no-store, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
  let last='';const tick=()=>{
    if(!deviceRequestStillValid(db.get(),req)){res.write('event: context\ndata: {}\n\n');res.end();clearInterval(timer);return;}
    const d=db.get();
    const versions=['task_change_clock','rotation_change_clock','reward_change_clock'].map(table=>d.prepare(`SELECT version FROM ${table} WHERE id=1`).get()?.version||0);
    const value=JSON.stringify(versions);if(value!==last){last=value;res.write(`event: change\ndata: ${JSON.stringify({version:value})}\n\n`);}else res.write(': keepalive\n\n');
  };
  const timer=setInterval(tick,1000);timer.unref?.();req.on('close',()=>clearInterval(timer));tick();
});

devicesRouter.use(requireAuth,requireAdmin,csrfMiddleware);
devicesRouter.get('/',guarded((req,res)=>res.json({
  data:db.get().prepare('SELECT * FROM household_devices ORDER BY id').all().map(publicDevice),defaults:devicePreset(),supportedActions:DEVICE_ACTIONS,
  members:db.get().prepare('SELECT id,display_name FROM users WHERE NOT EXISTS(SELECT 1 FROM split_expense_guest_users g WHERE g.user_id=users.id) AND NOT EXISTS(SELECT 1 FROM housekeeping_workers w WHERE w.user_id=users.id)').all(),
})));
devicesRouter.post('/pairing-approve',rate,guarded((req,res)=>res.status(201).json({data:approvePairing(db.get(),req.body.code,req.body,req.authUserId)})));
devicesRouter.patch('/:id',guarded((req,res)=>res.json({data:updateDevice(db.get(),Number(req.params.id),req.body,req.authUserId)})));
devicesRouter.post('/:id/revoke',guarded((req,res)=>{revokeDevice(db.get(),Number(req.params.id),req.body.revision,req.authUserId);res.json({ok:true});}));
