/** Tasks retain their existing payload-free stream and capability boundary. */
import { actorPermissions } from '../permissions.js';
import { createChangesStream } from './change-stream.js';
export const taskChangesStream = createChangesStream({
  table:'task_change_clock',deniedMessage:'Task access is not enabled.',
  canRead(d,req) {
    const p=actorPermissions(d,req);
    return p.modules.tasks !== 'none'
      && (p.capabilities['tasks.view_own']==='allow'||p.capabilities['tasks.view_household']==='allow');
  },
});