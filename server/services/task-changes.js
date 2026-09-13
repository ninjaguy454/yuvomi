/** Single lightweight database clock observer; clients receive no Task data. */
import * as db from '../db.js';
import { actorPermissions } from '../permissions.js';

const subscribers = new Set();
let timer = null;
function allowed(d,req) {
  const p=actorPermissions(d,req);
  return p.modules.tasks !== 'none'
    && (p.capabilities['tasks.view_own']==='allow'||p.capabilities['tasks.view_household']==='allow');
}
function tick() {
  const d=db.get(), version=d.prepare('SELECT version FROM task_change_clock WHERE id=1').get().version;
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
export function taskChangesStream(req,res) {
  try {
    if (!allowed(db.get(),req)) return res.status(403).json({error:'Task access is not enabled.',code:403});
    res.status(200).set({'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform',
      'Connection':'keep-alive','X-Accel-Buffering':'no'});
    res.flushHeaders();
    const sub={req,res,version:null,heartbeat:Date.now()};subscribers.add(sub);
    req.on('close',()=>{subscribers.delete(sub);if(!subscribers.size&&timer){clearInterval(timer);timer=null;}});
    tick();
    if(!timer) {timer=setInterval(tick,1000);timer.unref?.();}
  } catch(error) {res.status(403).json({error:error.message,code:403});}
}
