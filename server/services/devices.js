/** Device credentials and context state. No device is represented by a user. */
import crypto from 'node:crypto';
import { PERMISSION_CAPABILITIES, PERMISSION_MODULES, PERMISSION_WIDGETS } from '../permissions.js';
import { normalizeWallConfig, wallConfig, householdMember } from './wall.js';

export const DEVICE_COOKIE = 'vidamia.device';
export const DEVICE_ACTIONS = ['complete','reopen','reset','claim'];
export const DEVICE_WIDGETS = ['tasks','calendar','meals','shopping','points','rewards','rotations'];
export const DEVICE_DEFINITION_CAPABILITIES = ['tasks.create','tasks.edit_others','tasks.change_assignment','tasks.reassign','tasks.change_dates','tasks.change_points'];
const json = value => JSON.stringify(value);
const random = () => crypto.randomBytes(32).toString('hex');
export const deviceHash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
export const deviceError = (message,status=400,reason='device_access_denied') => Object.assign(new Error(message),{status,reason});
export function deviceCookie(req) {
  const raw=String(req.headers?.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(`${DEVICE_COOKIE}=`));
  return raw?.slice(DEVICE_COOKIE.length+1)||null;
}
export function devicePreset() {
  return {admin:false,
    modules:Object.fromEntries(PERMISSION_MODULES.map(m=>[m.key,['dashboard','tasks','calendar','meals','shopping','rewards'].includes(m.key)?'read':'none'])),
    widgets:Object.fromEntries(PERMISSION_WIDGETS.map(w=>[w.id,['tasks','calendar','meals','shopping','rewards','clock'].includes(w.id)?'allow':'none'])),
    capabilities:{...Object.fromEntries(PERMISSION_CAPABILITIES.map(c=>[c.key,['tasks.view_household','rotations.view'].includes(c.key)?'allow':'none'])),
      ...Object.fromEntries(DEVICE_ACTIONS.map(a=>[`device_tasks.${a}`,a==='complete'?'allow':'none']))}};
}
const allowedModules=new Set(['dashboard','tasks','calendar','meals','shopping','rewards']);
export function normalizeDevicePermissions(input=devicePreset()) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw deviceError('Invalid device permissions.');
  const result=devicePreset();
  for(const key of Object.keys(input.modules||{}))if(!(key in result.modules))throw deviceError('Unknown display module.');
  for(const key of Object.keys(input.capabilities||{}))if(!(key in result.capabilities))throw deviceError('Unknown display action.');
  for(const key of Object.keys(result.modules)) {
    const value=input.modules?.[key]??result.modules[key];
    if(!['none','read'].includes(value)||(!allowedModules.has(key)&&value!=='none'))throw deviceError('This module requires personal sign-in.');
    result.modules[key]=value;
  }
  for(const key of Object.keys(result.capabilities)) {
    const value=input.capabilities?.[key]??result.capabilities[key];
    if(!['allow','none'].includes(value))throw deviceError('Choose Allow or Not allowed.');
    if(value==='allow'&&!['tasks.view_household','rotations.view',...DEVICE_DEFINITION_CAPABILITIES,...DEVICE_ACTIONS.map(a=>`device_tasks.${a}`)].includes(key))
      throw deviceError('This action requires authenticated personal access.');
    result.capabilities[key]=value;
  }
  return result;
}
export function normalizeDeviceScope(d,input={}) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw deviceError('Invalid display scope.');
  if(input.show_points!==undefined&&typeof input.show_points!=='boolean')throw deviceError('Choose whether point totals are visible.');
  const ids=input.member_ids??[];
  if(!Array.isArray(ids)||ids.length>100||ids.some(id=>!Number.isSafeInteger(id)||!householdMember(d,id)))throw deviceError('Choose valid household members.');
  const groups=input.rotation_group_ids??null;
  if(groups!==null&&(!Array.isArray(groups)||groups.length>100||groups.some(id=>!Number.isSafeInteger(id)||!d.prepare('SELECT id FROM rotation_groups WHERE id=?').get(id))))throw deviceError('Choose valid Rotation Groups.');
  return {member_ids:[...new Set(ids)],rotation_group_ids:groups===null?null:[...new Set(groups)],show_points:input.show_points!==false};
}
export function normalizeDevicePreferences(d,input) {
  const seed=input??wallConfig(d);
  if(!seed||typeof seed!=='object'||Array.isArray(seed))throw deviceError('Invalid display preferences.');
  const supplied=input?.widgets??DEVICE_WIDGETS.map((id,order)=>({id,visible:true,size:id==='tasks'?'large':'medium',order}));
  if(!Array.isArray(supplied)||supplied.length>DEVICE_WIDGETS.length||new Set(supplied.map(row=>row?.id)).size!==supplied.length||supplied.some(row=>!row||!DEVICE_WIDGETS.includes(row.id)))
    throw deviceError('Choose supported display widgets without duplicates.');
  // Reuse Wall appearance and widget validation; Rotation is the device's extra
  // explicitly shared resource. Neither layout nor visibility grants access.
  const rotation=supplied.find(row=>row.id==='rotations');
  const normalized=normalizeWallConfig({...seed,widgets:supplied.filter(row=>row.id!=='rotations')});
  const rotationWidget=rotation?normalizeWallConfig({widgets:[{...rotation,id:'tasks'}]}).widgets.find(row=>row.id==='tasks'):null;
  const widgets=DEVICE_WIDGETS.map(id=>{
    const source=supplied.find(row=>row.id===id),validated=id==='rotations'?rotationWidget:normalized.widgets.find(row=>row.id===id);
    return {id,visible:validated?.visible??false,size:validated?.size||'medium',order:Number.isSafeInteger(source?.order)?source.order:DEVICE_WIDGETS.indexOf(id)};
  }).sort((a,b)=>a.order-b.order).map((row,order)=>({...row,order}));
  return {...normalized,widgets,default_view:['wall','list','kanban'].includes(seed.default_view)?seed.default_view:'wall'};
}
export function publicDevice(row) {
  if(!row)return null;
  return {id:row.id,name:row.name,status:row.status,revision:row.revision,permissions:JSON.parse(row.permissions_json),scope:JSON.parse(row.scope_json),
    preferences:JSON.parse(row.preferences_json),idle_seconds:row.idle_seconds,maximum_seconds:row.maximum_seconds,
    created_at:row.created_at,last_seen_at:row.last_seen_at,revoked_at:row.revoked_at};
}
export function devicePrincipal(row) {return {kind:'device',...publicDevice(row)};}
export function auditDevice(d,id,actor,event,details={}) {
  d.prepare('INSERT INTO device_audit_events(device_id,actor_user_id,event_type,details_json) VALUES(?,?,?,?)').run(id,actor??null,event,json(details));
}
export function createDevice(d,input,actor) {
  const name=String(input.name||'').trim(); if(!name||name.length>80)throw deviceError('Name the display (up to 80 characters).');
  const permissions=normalizeDevicePermissions(input.permissions),scope=normalizeDeviceScope(d,input.scope),preferences=normalizeDevicePreferences(d,input.preferences);
  const id=Number(d.prepare('INSERT INTO household_devices(name,permissions_json,scope_json,preferences_json,paired_by) VALUES(?,?,?,?,?)')
    .run(name,json(permissions),json(scope),json(preferences),actor).lastInsertRowid);
  auditDevice(d,id,actor,'paired');return publicDevice(d.prepare('SELECT * FROM household_devices WHERE id=?').get(id));
}
export function updateDevice(d,id,input,actor) {
  return d.transaction(()=>{
    const row=d.prepare('SELECT * FROM household_devices WHERE id=?').get(id); if(!row)throw deviceError('Device not found.',404);
    if(input.revision!==row.revision)throw deviceError('This device changed. Reload before saving.',409,'stale_revision');
    const name=String(input.name??row.name).trim();if(!name||name.length>80)throw deviceError('Name the display (up to 80 characters).');
    const idle=input.idle_seconds??row.idle_seconds,max=input.maximum_seconds??row.maximum_seconds;
    if(!Number.isInteger(idle)||idle<30||idle>300||!Number.isInteger(max)||max<60||max<idle||max>1800)throw deviceError('Choose an idle timeout of 30–300 seconds and a maximum of 60–1800 seconds, at least as long as the idle timeout.');
    const priorPermissions=JSON.parse(row.permissions_json), supplied=input.permissions||{};
    const permissions=normalizeDevicePermissions({...priorPermissions,...supplied,
      modules:{...priorPermissions.modules,...supplied.modules},capabilities:{...priorPermissions.capabilities,...supplied.capabilities}});
    const scope=normalizeDeviceScope(d,{...JSON.parse(row.scope_json),...input.scope}),preferences=normalizeDevicePreferences(d,input.preferences??JSON.parse(row.preferences_json));
    d.prepare('UPDATE household_devices SET name=?,permissions_json=?,scope_json=?,preferences_json=?,idle_seconds=?,maximum_seconds=?,revision=revision+1 WHERE id=?')
      .run(name,json(permissions),json(scope),json(preferences),idle,max,id);
    invalidateDeviceContexts(d,id);auditDevice(d,id,actor,'configuration_changed');
    return publicDevice(d.prepare('SELECT * FROM household_devices WHERE id=?').get(id));
  }).immediate();
}
export function invalidateDeviceContexts(d,id,{revoke=false}={}) {
  if(revoke)d.prepare('UPDATE device_pairings SET consumed_at=COALESCE(consumed_at,?) WHERE device_id=?').run(Date.now(),id);
  const rows=d.prepare('SELECT * FROM device_credentials WHERE device_id=?').all(id);
  for(const row of rows) {
    if(row.temporary_sid)retireBrowserSession(d,row.temporary_sid);
    d.prepare(`UPDATE device_credentials SET context_key=?,temporary_sid=NULL,temporary_user_id=NULL,temporary_started_at=NULL,temporary_idle_at=NULL,login_intent_at=NULL,
      revoked_at=CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE revoked_at END WHERE id=?`).run(random(),revoke?1:0,row.id);
  }
}
export function revokeDevice(d,id,revision,actor) {
  return d.transaction(()=>{
    const result=d.prepare("UPDATE household_devices SET status='revoked',revision=revision+1,revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND revision=?") .run(id,revision);
    if(!result.changes)throw deviceError('This device changed. Reload before revoking.',409,'stale_revision');
    invalidateDeviceContexts(d,id,{revoke:true});auditDevice(d,id,actor,'revoked');
  }).immediate();
}
export function beginPairing(d,now=Date.now()) {
  const id=random(),code=crypto.randomBytes(6).toString('hex').toUpperCase(),expiresAt=now+5*60_000;
  d.prepare('DELETE FROM device_pairings WHERE expires_at<?').run(now-24*60*60_000);
  d.prepare('INSERT INTO device_pairings(id,code_hash,expires_at,created_at) VALUES(?,?,?,?)').run(deviceHash(id),deviceHash(code),expiresAt,now);
  return {secret:id,code,expiresAt};
}
export function approvePairing(d,code,input,actor,now=Date.now()) {
  return d.transaction(()=>{
    const row=d.prepare('SELECT * FROM device_pairings WHERE code_hash=? AND expires_at>? AND consumed_at IS NULL AND device_id IS NULL').get(deviceHash(String(code||'').replace(/[ -]/g,'').toUpperCase()),now);
    if(!row)throw deviceError('Pairing code is invalid, expired or already approved.',404);
    let device;
    if(input.replace_device_id) {
      const existing=d.prepare('SELECT * FROM household_devices WHERE id=?').get(input.replace_device_id);
      if(!existing||existing.revision!==input.revision)throw deviceError('Reload the device before replacing access.',409);
      invalidateDeviceContexts(d,existing.id,{revoke:true});
      d.prepare("UPDATE household_devices SET status='active',revoked_at=NULL,revision=revision+1 WHERE id=?").run(existing.id);
      auditDevice(d,existing.id,actor,'access_replaced');device=publicDevice(d.prepare('SELECT * FROM household_devices WHERE id=?').get(existing.id));
    }else device=createDevice(d,input,actor);
    d.prepare('UPDATE device_pairings SET device_id=?,approved_by=? WHERE id=?').run(device.id,actor,row.id);
    return device;
  }).immediate();
}
export function pairingStatus(d,secret,now=Date.now()) {
  const row=d.prepare('SELECT device_id,expires_at FROM device_pairings WHERE id=? AND expires_at>? AND consumed_at IS NULL').get(deviceHash(secret||''),now);
  if(!row)throw deviceError('Pairing code expired. Start pairing again.',410);
  return {approved:!!row.device_id,expiresAt:row.expires_at};
}
export function claimPairing(d,secret,now=Date.now()) {
  return d.transaction(()=>{
    const row=d.prepare('SELECT * FROM device_pairings WHERE id=? AND expires_at>? AND consumed_at IS NULL AND device_id IS NOT NULL').get(deviceHash(secret||''),now);
    if(!row)throw deviceError('Pairing has not been approved or has expired.',409);
    const device=d.prepare("SELECT * FROM household_devices WHERE id=? AND status='active'").get(row.device_id);
    if(!device)throw deviceError('This device was revoked.',403);
    const token=random();d.prepare('INSERT INTO device_credentials(device_id,token_hash,context_key) VALUES(?,?,?)').run(device.id,deviceHash(token),random());
    d.prepare('UPDATE device_pairings SET consumed_at=? WHERE id=?').run(now,row.id);
    return {token,device:publicDevice(device)};
  }).immediate();
}
export function readDeviceContext(d,req,{now=Date.now(),expire=true}={}) {
  const token=deviceCookie(req);if(!token)return null;
  const credential=d.prepare('SELECT * FROM device_credentials WHERE token_hash=?').get(deviceHash(token));
  const device=credential&&d.prepare('SELECT * FROM household_devices WHERE id=?').get(credential.device_id);
  if(!device||device.status!=='active'||credential.revoked_at)throw deviceError('This display has been revoked. Pair it again.',401,'device_revoked');
  // Presence metadata is throttled; it neither extends the personal lease nor grants authority.
  if(expire&&(!device.last_seen_at||now-Date.parse(device.last_seen_at)>60_000))
    d.prepare('UPDATE household_devices SET last_seen_at=? WHERE id=?').run(new Date(now).toISOString(),device.id);
  if(credential.temporary_sid&&(now>=credential.temporary_started_at+device.maximum_seconds*1000||now>=credential.temporary_idle_at+device.idle_seconds*1000||
    d.prepare('SELECT role FROM users WHERE id=?').get(credential.temporary_user_id)?.role!=='admin')) {
    if(expire){returnToDevice(d,credential,'temporary_expired');return readDeviceContext(d,req,{now,expire:false});}
    throw deviceError('Temporary personal access expired.',401,'device_context_changed');
  }
  return {credential,device};
}
export function contextKey(req) {return String(req.get?.('X-Auth-Context')||req.headers?.['x-auth-context']||((req.originalUrl||'').split('?')[0].endsWith('/changes')?req.query?.context:'')||'');}
export function assertDeviceContext(d,req,{allowMissing=false,now=Date.now()}={}) {
  const context=readDeviceContext(d,req,{now});if(!context)return null;
  const sent=contextKey(req);
  if((!allowMissing||sent)&&sent!==context.credential.context_key)throw deviceError('The display sign-in changed. Return to the display and try again.',409,'device_context_changed');
  return context;
}
export function isTemporaryContext(req,context) {
  const c=context?.credential;
  return !!(c?.temporary_sid&&c.temporary_sid===req.sessionID&&c.temporary_user_id===req.session?.userId&&contextKey(req)===c.context_key);
}
export function deviceContextPayload(req,context) {
  const {device,credential}=context;
  const temporary=credential.temporary_sid===req.sessionID&&credential.temporary_user_id===req.session?.userId;
  return {device:publicDevice(device),authContext:credential.context_key,
    ...(temporary?{temporary:{idleExpiresAt:credential.temporary_idle_at+device.idle_seconds*1000,expiresAt:credential.temporary_started_at+device.maximum_seconds*1000}}:
      {principal:{kind:'device',id:device.id,name:device.name},permissions:JSON.parse(device.permissions_json)}),
    temporaryLoginPending:!!credential.login_intent_at,csrfToken:req.session?.csrfToken};
}
export function beginTemporary(d,req,now=Date.now()) {
  const context=assertDeviceContext(d,req,{now});if(!context)throw deviceError('Pair this display first.',403);
  if(context.credential.temporary_sid)throw deviceError('Return to the device before signing in again.',409);
  d.prepare('UPDATE device_credentials SET login_intent_at=? WHERE id=?').run(now,context.credential.id);
  req.session.deviceLoginIntent={credentialId:context.credential.id,context:context.credential.context_key,expiresAt:now+5*60_000};
}
export function validateTemporaryLogin(d,req,user,now=Date.now()) {
  const context=readDeviceContext(d,req,{now});
  if(!context&&req.session?.deviceLoginIntent)throw deviceError('Device authentication was lost during sign-in. Pair this display again.',403);
  if(!context)return null;
  const intent=req.session?.deviceLoginIntent,c=context.credential;
  if(!intent||intent.credentialId!==c.id||intent.context!==c.context_key||intent.expiresAt<=now||!c.login_intent_at)
    throw deviceError('Choose Sign in temporarily on this display first.',403,'device_login_required');
  if(user.role!=='admin')throw deviceError('Temporary access requires a household administrator.',403);
  return context;
}
export function establishTemporary(d,req,context,user,now=Date.now()) {
  const key=random();const result=d.prepare(`UPDATE device_credentials SET context_key=?,temporary_sid=?,temporary_user_id=?,temporary_started_at=?,temporary_idle_at=?,login_intent_at=NULL
    WHERE id=? AND context_key=? AND revoked_at IS NULL`).run(key,req.sessionID,user.id,now,now,context.credential.id,context.credential.context_key);
  if(!result.changes)throw deviceError('Device context changed during sign-in.',409,'device_context_changed');
  req.session.deviceCredentialId=context.credential.id;req.session.deviceContext=key;req.session.deviceLoginHandoff=now;
  auditDevice(d,context.device.id,user.id,'temporary_sign_in');
}
export function returnToDevice(d,credential,event='temporary_return') {
  return d.transaction(()=>{
    if(credential.temporary_sid)retireBrowserSession(d,credential.temporary_sid);
    const changed=d.prepare('UPDATE device_credentials SET context_key=?,temporary_sid=NULL,temporary_user_id=NULL,temporary_started_at=NULL,temporary_idle_at=NULL,login_intent_at=NULL WHERE id=? AND context_key=?')
      .run(random(),credential.id,credential.context_key);
    if(changed.changes&&(credential.temporary_sid||credential.login_intent_at))auditDevice(d,credential.device_id,credential.temporary_user_id,event);
  }).immediate();
}
export function retireBrowserSession(d,sid) {
  if(!sid)return;
  d.prepare('INSERT OR IGNORE INTO device_session_tombstones(sid,revoked_at) VALUES(?,?)').run(sid,Date.now());
  d.prepare('DELETE FROM sessions WHERE sid=?').run(sid);
}
export function touchTemporary(d,req,now=Date.now()) {
  const ctx=assertDeviceContext(d,req,{now});if(!ctx||!isTemporaryContext(req,ctx))throw deviceError('Temporary personal access is no longer active.',401,'device_context_changed');
  d.prepare('UPDATE device_credentials SET temporary_idle_at=? WHERE id=? AND context_key=?').run(now,ctx.credential.id,ctx.credential.context_key);
  return readDeviceContext(d,req,{now});
}
/** Also called by long-lived streams. No session snapshot can revive old authority. */
export function deviceRequestStillValid(d,req) {
  if(!deviceCookie(req)&&!req.session?.deviceCredentialId)return true;
  try{const ctx=assertDeviceContext(d,req);return !!ctx&&(!req.authUserId||isTemporaryContext(req,ctx));}catch{return false;}
}
/** Applied before public auth, Reader and alternate API routers. */
export function deviceBoundary(d,req,res,next) {
  if(!deviceCookie(req)&&!req.session?.deviceCredentialId)return next();
  const path=String(req.path||'').replace(/\/+$/,'').toLowerCase();
  if(path==='/reader'||path.startsWith('/reader/'))return res.status(403).set('Cache-Control','private, no-store').send('Use the paired display or temporary personal app view.');
  // Personal subscription tokens bypass normal session/scope projections. A
  // remembered feed URL must not restore personal content on a paired display.
  if(path==='/feed'||path.startsWith('/feed/'))return res.status(403).set('Cache-Control','private, no-store').send('Open personal subscription feeds from an ordinary personal browser, not a paired display.');
  if(!path.startsWith('/api/')&&path!=='/mcp')return next();
  if(path.startsWith('/api/v1/device/'))return next();
  const bootstrap=['/api/v1/auth/me','/api/v1/version','/api/v1/auth/oidc/config'].includes(path);
  const login=['/api/v1/auth/login','/api/v1/auth/2fa/verify','/api/v1/auth/oidc/start','/api/v1/auth/oidc/callback'].includes(path);
  try {
    if(login&&req.method==='POST') {
      const origin=req.get?.('Origin');
      if(req.get?.('Sec-Fetch-Site')==='cross-site'||(origin&&new URL(origin).host!==req.get('Host')))
        return res.status(403).json({error:'Use this display to sign in temporarily.'});
    }
    const ctx=assertDeviceContext(d,req,{allowMissing:bootstrap||login});
    if(!ctx)return res.status(401).json({error:'Pair this display again.',reason:'device_revoked'});
    if(login&&!req.session?.deviceLoginIntent)return res.status(403).json({error:'Choose Sign in temporarily first.',reason:'device_login_required'});
    if(bootstrap||login||path==='/api/v1/auth/logout'||isTemporaryContext(req,ctx))return next();
    return res.status(403).json({error:'Use temporary personal sign-in for this action.',reason:'device_access_denied'});
  } catch(error){res.status(error.status||403).json({error:error.message,reason:error.reason});}
}
