/** Explicit normal-application route boundary for a non-human device principal. */
export const canonicalPath=path=>String(path||'').split('?')[0].replace(/^\/api\/v1(?=\/|$)/,'').replace(/\/+$/,'')||'/';
const reads=new Set(['/tasks','/tasks/meta/options','/tasks/categories','/tasks/tags','/tasks/completions',
  '/tasks/changes','/tasks/sync-targets','/dashboard','/preferences','/auth/users','/module-counts',
  '/calendar','/calendar/holidays','/calendar/search','/calendar/sync-targets',
  '/meals','/meals/week-model','/meals/status','/meals/planning','/meals/selection-requests',
  '/shopping','/shopping/categories','/rewards/overview','/rewards/catalog','/rewards/redemptions','/rewards/changes',
  '/automation/rotation-groups','/automation/rotation-members','/automation/rotation-changes',
  '/automation/activity-options','/automation/obligations','/planning/places','/planning/place-search/status','/reminders']);
/** Used by authentication to admit only routes subsequently intercepted here. */
export function deviceAppRouteSupported(method,path) {
  if(typeof method==='object'){path=method.originalUrl||method.path||method.url;method=method.method;}
  path=canonicalPath(path);method=String(method||'GET').toUpperCase();
  if(method==='GET')return reads.has(path)||/^\/tasks\/\d+(?:\/(?:activity|completions|comments|documents))?$/.test(path)
    ||/^\/calendar\/\d+$/.test(path)||/^\/shopping\/\d+\/items$/.test(path)||/^\/automation\/rotation-groups\/\d+$/.test(path);
  if(method==='POST')return path==='/tasks'||/^\/automation\/tasks\/\d+\/claim$/.test(path);
  return method==='PUT'&&/^\/tasks\/\d+$/.test(path)||method==='PATCH'&&/^\/tasks\/\d+\/status$/.test(path);
}
