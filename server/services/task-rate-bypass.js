// Only a signed interactive session on ordinary Task reads/edits can bypass
// the broad per-IP API quota. Authentication, authorization, CSRF and the
// route's own validation still run after this middleware.
export function ordinaryTaskSessionBypass(req) {
  if (!Number.isSafeInteger(req.session?.userId) || req.session.userId <= 0 || !req.sessionID) return false;
  const pathname = String(req.originalUrl || '').split('?')[0];
  if (req.method === 'GET') {
    return pathname === '/api/v1/tasks' || pathname === '/api/v1/tasks/window'
      || /^\/api\/v1\/tasks\/[1-9]\d*(?:\/comments)?$/.test(pathname)
      || pathname === '/api/v1/reminders' && req.query?.entity_type === 'task'
        && /^[1-9]\d*$/.test(String(req.query.entity_id ?? ''));
  }
  if (req.method === 'PUT') return /^\/api\/v1\/tasks\/[1-9]\d*$/.test(pathname);
  if (req.method === 'PATCH') return /^\/api\/v1\/tasks\/[1-9]\d*\/status$/.test(pathname);
  return false;
}

export function withOrdinaryTaskSessionBypass(limiter, signedTaskLimiter) {
  return (req, res, next) => (ordinaryTaskSessionBypass(req) ? signedTaskLimiter : limiter)(req, res, next);
}
