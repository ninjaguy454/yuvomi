import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');
const start = source.indexOf('async function navigate(');
const end = source.indexOf('\nasync function syncPreferencesOnce()', start);
assert.ok(start > 0 && end > start);

function harness() {
  const history = [], rendered = [];
  let release, epoch = 0, revision = 0;
  const loading = new Promise(resolve => { release = resolve; });
  const noop = () => {};
  const routes = ['/', '/tasks', '/calendar', '/settings', '/login'].map(path => ({ path, requiresAuth: path !== '/login', module: path === '/tasks' ? 'tasks' : null }));
  const context = vm.createContext({
    console, URLSearchParams, setTimeout, window: {}, location: { search: '' },
    document: { getElementById: () => ({ scrollTop: 0 }), querySelector: () => null },
    currentUser: { id: 1 }, currentPath: null, isNavigating: false, _pendingNavigation: null,
    _navigationRun: 0, _activeNavigationPath: null,
    _wallPrivacyTransitioning: false, _setupRequired: false, _pendingLoginRedirect: false,
    _renderedModuleName: null, _renderedModule: null, _disabledModules: new Set(),
    isWallModeEnabled: () => false, allRoutes: () => routes, ROUTES: routes,
    canAccessNavModule: () => true, deviceLandingPath: () => '/',
    authenticationSnapshot: () => ({ epoch }), sameAuthentication: snapshot => snapshot.epoch === epoch,
    sessionRevision: () => revision,
    rememberScrollPosition: noop, scrollPositionFor: () => 0,
    pushNavigationHistory: path => history.push(path),
    renderPage: async route => { rendered.push(route.path); if (rendered.length === 1) await loading; },
    syncWallMode: noop, applyModuleAccentForRoute: noop, updateNav: noop,
    updateThemeColorForRoute: noop, updateBranding: noop, focusMainContentAfterNavigation: noop,
    paintNotificationBadges: noop, topLevelSection: path => path,
  });
  vm.runInContext(source.slice(start, end), context);
  return {
    context, history, rendered, release,
    navigate: (...args) => context.navigate(...args),
    changeAuthentication: () => { epoch++; },
    changeSession: () => { revision++; },
  };
}

test('a visible navigation request survives loading and the latest destination wins', async () => {
  const app = harness(), first = app.navigate('/');
  await app.navigate('/calendar');
  await app.navigate('/settings');
  assert.deepEqual(app.rendered, ['/'], 'renders never overlap');
  app.release(); await first;
  assert.deepEqual(app.rendered, ['/', '/settings']);
  assert.deepEqual(app.history, ['/', '/settings'], 'discarded intermediate clicks do not pollute history');
});

test('repeated clicks on the loading destination do not rerender or add history entries', async () => {
  const app = harness(), first = app.navigate('/tasks');
  await app.navigate('/tasks');
  app.release(); await first;
  assert.deepEqual(app.rendered, ['/tasks']);
  assert.deepEqual(app.history, ['/tasks']);
});

test('choosing the loading destination cancels an older queued destination', async () => {
  const app = harness(), first = app.navigate('/tasks');
  await app.navigate('/settings');
  await app.navigate('/tasks');
  app.release(); await first;
  assert.deepEqual(app.rendered, ['/tasks']);
});

test('a same-path authenticated user handoff is retained rather than coalesced away', async () => {
  const app = harness(), first = app.navigate('/tasks');
  app.context.syncPreferencesOnce = async () => {};
  app.context.startThirdPartyModulePolling = () => {};
  await app.navigate('/tasks', { id: 2, kind: 'device' });
  app.release(); await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.context.currentUser.id, 2);
  assert.deepEqual(app.rendered, ['/tasks', '/tasks']);
});

for (const change of ['changeAuthentication', 'changeSession']) test(`queued personal navigation is discarded on ${change}`, async () => {
  const app = harness(), first = app.navigate('/');
  await app.navigate('/settings');
  app[change](); app.release(); await first;
  assert.deepEqual(app.rendered, ['/']);
  assert.deepEqual(app.history, ['/']);
});

test('an expiry redirect takes precedence over a queued personal destination', async () => {
  const app = harness(), first = app.navigate('/');
  await app.navigate('/settings');
  app.context.currentUser = null;
  app.context._pendingLoginRedirect = true;
  app.release(); await first;
  assert.deepEqual(app.rendered, ['/', '/login']);
  assert.deepEqual(app.history, ['/', '/login']);
});

test('an authentication guard redirect owns the render before queued navigation can start', async () => {
  const app = harness();
  let authenticated, allowed = true;
  app.context.currentUser = null;
  app.context.auth = { me: () => new Promise(resolve => { authenticated = resolve; }) };
  app.context.syncPreferencesOnce = async () => { allowed = false; };
  app.context.startThirdPartyModulePolling = () => {};
  app.context.canAccessNavModule = () => allowed;
  const original = app.navigate('/tasks');
  await app.navigate('/settings');
  authenticated({ user: { id: null, kind: 'device' } });
  await original;
  assert.deepEqual(app.rendered, ['/'], 'redirect must finish its held render before Settings starts');
  assert.equal(app.context.isNavigating, true, 'redirect retains navigation ownership');
  app.release();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(app.rendered, ['/', '/settings']);
  assert.equal(app.context.isNavigating, false);
});
