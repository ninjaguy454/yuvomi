import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createLogger } from '../logger.js';

const resources = new Set(['auth','device','tasks','dashboard','automation','rewards',
  'calendar','notes','documents','meals','shopping','preferences','notifications',
  'permissions','family','health','backup','search','modules','push']);

/** Bounded incident evidence, never request bodies, URLs, identities or headers.
 * Set REQUEST_DIAGNOSTICS=false to disable. Normal successful reads are silent.
 * This is observation only: it never retries or changes a response.
 */
export function requestDiagnostics({
  enabled = process.env.REQUEST_DIAGNOSTICS !== 'false',
  log = createLogger('RequestDiagnostics'),
  now = () => performance.now(),
  slowMs = 2000,
  limit = 30,
  windowMs = 60_000,
} = {}) {
  let windowStart = now(), emitted = 0, suppressed = 0;
  function record(value) {
    const time = now();
    if (time - windowStart >= windowMs) {
      if (suppressed) log.warn('Request diagnostics suppressed', { count: suppressed });
      windowStart = time; emitted = 0; suppressed = 0;
    }
    if (emitted >= limit) { suppressed++; return; }
    emitted++; log.warn('Request outcome', value);
  }
  return (req, res, next) => {
    if (!enabled || !String(req.url || '').startsWith('/api/')) return next();
    const started = now(), requestId = randomUUID();
    const path = String(req.url).split('?')[0];
    const segment = path.split('/')[3];
    const resource = resources.has(segment) ? segment : 'other';
    const stream = /\/changes$/.test(path);
    const method = ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].includes(req.method) ? req.method : 'OTHER';
    let finished = false;
    res.setHeader('X-Request-ID', requestId);
    res.once('finish', () => {
      finished = true;
      const elapsed = Math.max(0, Math.round(now() - started));
      const status = res.statusCode;
      if (status < 400 && (stream || elapsed < slowMs)) return;
      record({ requestId, resource, method, status, durationMs: elapsed,
        outcome: status >= 500 ? 'server_error' : status === 429 ? 'rate_limited'
          : status === 401 ? 'unauthenticated' : status === 403 ? 'forbidden'
            : status === 409 ? 'conflict' : status >= 400 ? 'rejected' : 'slow' });
    });
    res.once('close', () => {
      if (finished || stream) return;
      record({ requestId, resource, method, durationMs: Math.max(0, Math.round(now() - started)),
        outcome: 'connection_closed_before_response' });
    });
    next();
  };
}

