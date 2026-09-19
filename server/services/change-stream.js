/** Reusable payload-free revision stream. The persisted session and current
 * module permissions authorize every event, including after logout/reconnect. */
import * as db from '../db.js';
import { deviceRequestStillValid } from './devices.js';


export function createChangesStream({table,canRead,deniedMessage}) {
  if(!/^[a-z_]+$/.test(table))throw new Error('Invalid revision clock table.');
  const subscribers = new Set();
  let timer = null;
  function allowed(d,req) {
    if(!deviceRequestStillValid(d,req))return false;
    // Long-lived requests retain the original Session object after logout. The
    // persisted session, not that snapshot, authorizes every event/heartbeat.
    if (req.authMethod !== 'session' || !req.sessionID) return false;
    const row = d.prepare('SELECT sess FROM sessions WHERE sid=? AND expired_at>?').get(req.sessionID, Date.now());
    if (!row || Number(JSON.parse(row.sess)?.userId) !== Number(req.authUserId)) return false;
    return canRead(d,req);
  }
  function tick() {
    const d=db.get(), version=d.prepare(`SELECT version FROM ${table} WHERE id=1`).get().version;
    for (const sub of subscribers) {
      try {
        if (!allowed(d,sub.req)) { sub.res.end(); subscribers.delete(sub); continue; }
        if (version!==sub.version) {
          sub.res.write(`event: change\ndata: ${JSON.stringify({version})}\n\n`);
          sub.version=version;
        } else if (Date.now()-sub.heartbeat>20000) {
          sub.res.write(': keepalive\n\n'); sub.heartbeat=Date.now();
        }
      } catch { sub.res.end(); subscribers.delete(sub); }
    }
    if (!subscribers.size && timer) {clearInterval(timer);timer=null;}
  }
  return function changesStream(req,res) {
    try {
      if (!allowed(db.get(),req)) return res.status(403).json({error:deniedMessage,code:403});
      res.status(200).set({'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform',
        'Connection':'keep-alive','X-Accel-Buffering':'no'});
      res.flushHeaders();
      const sub={req,res,version:null,heartbeat:Date.now()};subscribers.add(sub);
      req.on('close',()=>{subscribers.delete(sub);if(!subscribers.size&&timer){clearInterval(timer);timer=null;}});
      tick();
      if(!timer) {timer=setInterval(tick,1000);timer.unref?.();}
    } catch(error) {res.status(403).json({error:error.message,code:403});}
  }

}
