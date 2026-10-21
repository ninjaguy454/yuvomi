import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const router = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');
const dashboard = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
const start = router.indexOf('let _moduleCounts = {}');
const end = router.indexOf('\n/**', router.indexOf('function primeModuleCountsFrom(', start));
assert.ok(start > 0 && end > start);

test('an older Dashboard response cannot prime nav counts after a Task mutation', () => {
  const context = vm.createContext({
    Date, setTimeout: () => 1, clearTimeout: () => {},
    currentUser: { role: 'member' }, navItems: () => [],
    moduleCountsFrom: data => data, navBadgeCountsFrom: () => ({}), setNavBadge: () => {},
  });
  vm.runInContext(router.slice(start, end), context);
  const oldGeneration = vm.runInContext('_moduleCountsGen', context);
  vm.runInContext('invalidateModuleCounts()', context);
  context.oldGeneration = oldGeneration;
  context.newGeneration = vm.runInContext('_moduleCountsGen', context);
  vm.runInContext('primeModuleCountsFrom({ openTaskCount: 1 }, { generation: oldGeneration })', context);
  assert.equal(vm.runInContext('_moduleCountsAt', context), 0);
  vm.runInContext('primeModuleCountsFrom({ openTaskCount: 2 }, { generation: newGeneration })', context);
  assert.equal(vm.runInContext('_moduleCounts.openTaskCount', context), 2);
  assert.ok(vm.runInContext('_moduleCountsAt', context) > 0);
});

test('a Dashboard response from a prior session cannot restore counts after reset', () => {
  const context = vm.createContext({
    Date, setTimeout: () => 1, clearTimeout: () => {},
    currentUser: { role: 'member' }, navItems: () => [],
    moduleCountsFrom: data => data, navBadgeCountsFrom: () => ({}), setNavBadge: () => {},
  });
  vm.runInContext(router.slice(start, end), context);
  context.prior = vm.runInContext('_moduleCountsGen', context);
  vm.runInContext('resetModuleCounts()', context);
  vm.runInContext('primeModuleCountsFrom({ openTaskCount: 7 }, { generation: prior })', context);
  assert.equal(vm.runInContext('_moduleCountsAt', context), 0);
  assert.equal(vm.runInContext('Object.keys(_moduleCounts).length', context), 0);
});

test('Dashboard captures the count generation before starting its request', () => {
  const capture = dashboard.indexOf('const moduleCountsGeneration = window.yuvomi?.moduleCountsGeneration?.();');
  const request = dashboard.indexOf("api.get(layoutHintQuery('/dashboard'))", capture);
  const prime = dashboard.indexOf('window.yuvomi?.primeModuleCountsFrom?.(dashRes', request);
  assert.ok(capture > 0 && request > capture && prime > request);
  assert.match(dashboard.slice(prime, prime + 200), /generation: moduleCountsGeneration/);
});

test('rapid invalidations coalesce count reads but do not postpone them indefinitely', () => {
  let now = 1000;
  const delays = [];
  const context = vm.createContext({
    Date: { now: () => now },
    setTimeout: (_callback, delay) => { delays.push(delay); return delays.length; },
    clearTimeout: () => {},
    currentUser: { role: 'member' }, navItems: () => [],
    moduleCountsFrom: data => data, navBadgeCountsFrom: () => ({}), setNavBadge: () => {},
  });
  vm.runInContext(router.slice(start, end), context);
  vm.runInContext('invalidateModuleCounts()', context);
  now = 1300; vm.runInContext('invalidateModuleCounts()', context);
  now = 1800; vm.runInContext('invalidateModuleCounts()', context);
  assert.deepEqual(delays, [600, 600, 200]);
  vm.runInContext('resetModuleCounts()', context);
  now = 2200; vm.runInContext('invalidateModuleCounts()', context);
  assert.equal(delays.at(-1), 600, 'a new session begins its own coalescing window');
});
