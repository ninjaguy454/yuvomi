/** A shared display never inherits the hosting account's ordinary API access. */
export const WALL_EXIT_VERIFIED = Symbol('verified-wall-exit');
/** Older in-flight session snapshots cannot undo a newly enabled privacy lock. */
export function preserveWallSessionLock(previous,session) {
  if(previous?.wallMode && !session[WALL_EXIT_VERIFIED])session.wallMode=true;
  delete session[WALL_EXIT_VERIFIED];
  return session;
}
export function wallSessionAllows(req) {
  if (!req.session?.wallMode) return true;
  const path = String(req.originalUrl || req.url || '').split('?')[0].replace(/\/+$/, '');
  return /^\/api\/v1\/wall(?:\/|$)/.test(path)
    || ['/api/v1/auth/me', '/api/v1/auth/logout', '/api/v1/version', '/api/v1/tasks/changes', '/api/v1/rewards/changes'].includes(path);
}
