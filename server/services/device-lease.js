/** Revalidate temporary authority after awaited preparation, before a write or
 * disclosure. Ordinary personal requests retain their existing behavior. */
import * as db from '../db.js';
import {deviceCookie,deviceError,deviceRequestStillValid} from './devices.js';

export function assertCurrentDeviceRequest(req,database=db.get()) {
  if(!deviceCookie(req)&&!req.session?.deviceCredentialId&&!req.deviceContext)return;
  const persisted=req.sessionID?database.prepare('SELECT sess FROM sessions WHERE sid=? AND expired_at>?').get(req.sessionID,Date.now()):null;
  let session;try{session=JSON.parse(persisted?.sess||'null');}catch{}
  const human=Number(req.authUserId)||null;
  const role=human?database.prepare('SELECT role FROM users WHERE id=?').get(human)?.role:null;
  if(!deviceRequestStillValid(database,req)||!human||role!=='admin'||session?.userId!==human)
    throw deviceError('Temporary personal access changed. Return to the display and sign in again.',409,'device_context_changed');
}

export function sendDeviceLeaseError(res,error) {
  if(error?.reason!=='device_context_changed')return false;
  res.status(error.status||409).json({error:error.message,reason:error.reason});return true;
}
