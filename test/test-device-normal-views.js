import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

function store() {
  const data = new Map();
  const context = vm.createContext({
    Map, Set, JSON, window: { dispatchEvent() {} }, navigator: {},
    localStorage: { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
  });
  for (const path of ['../public/utils/device-context.js', '../public/permissions.js']) {
    vm.runInContext(readFileSync(new URL(path, import.meta.url), 'utf8').replaceAll('export ', ''), context);
  }
  return source => vm.runInContext(source, context);
}

test('paired defaults land in the same Dashboard, List and Kanban routes without becoming a member', () => {
  const run = store();
  run("acceptAuthentication({authContext:'context-1',principal:{kind:'device'},user:{id:null,kind:'device'},device:{preferences:{default_view:'wall'}}})");
  assert.equal(run('isDevicePrincipal()'), true);
  assert.equal(run('deviceBootstrap().user.id'), null);
  assert.equal(run('deviceLandingPath()'), '/');
  assert.equal(run("deviceLandingPath({device:{preferences:{default_view:'list'}}})"), '/tasks?view=list');
  assert.equal(run("deviceLandingPath({device:{preferences:{default_view:'kanban'}}})"), '/tasks?view=kanban');
  assert.equal(run("deviceLandingPath({device:{preferences:{default_view:'https://outside.invalid'}}})"), '/');
});

test('device navigation, widgets and actions fail closed while explicit normal Task permissions remain usable', () => {
  const run = store();
  run("setPermissions({principal_kind:'device',modules:{dashboard:'read',tasks:'read'},widgets:{tasks:'allow'},capabilities:{'device_tasks.complete':'allow','tasks.create':'none'}})");
  assert.equal(run("canAccessNavModule('tasks')"), true);
  assert.equal(run("canAccessNavModule('dashboard')"), true);
  for (const module of ['settings', 'unknown-module', 'budget', 'health', 'recipes', 'birthdays']) assert.equal(run('canAccessNavModule(' + JSON.stringify(module) + ')'), false);
  assert.equal(run("canSeeWidget('tasks')"), true);
  assert.equal(run("canSeeWidget('cycle')"), false);
  assert.equal(run("canCapability('device_tasks.complete')"), true);
  assert.equal(run("canCapability('tasks.create')"), false);
  assert.equal(run("canTask({permissions:{complete:true}}, 'complete')"), true);
  assert.equal(run("canTask({permissions:{complete:false}}, 'complete')"), false);
});

test('temporary personal access restores personal navigation only with the authenticated payload', () => {
  const run = store();
  run("acceptAuthentication({authContext:'device',principal:{kind:'device'},device:{}});setPermissions({principal_kind:'device',modules:{tasks:'read'}})");
  assert.equal(run("canAccessNavModule('settings')"), false);
  run("acceptAuthentication({authContext:'personal',principal:{kind:'member'},user:{id:7},device:{},temporary:{}});setPermissions({principal_kind:'member',admin:true})");
  assert.equal(run('isDevicePrincipal()'), false);
  assert.equal(run("canAccessNavModule('settings')"), true);
  run("acceptAuthentication({authContext:'device-returned',principal:{kind:'device'},device:{}});setPermissions({principal_kind:'device',modules:{tasks:'read'}})");
  assert.equal(run('isDevicePrincipal()'), true);
  assert.equal(run("canAccessNavModule('settings')"), false);
});

test('existing personal sparse module defaults remain unchanged', () => {
  const run = store();
  run("setPermissions({principal_kind:'member',modules:{budget:'none'}})");
  assert.equal(run("canAccessNavModule('tasks')"), true);
  assert.equal(run("canAccessNavModule('settings')"), true);
  assert.equal(run("canAccessNavModule('budget')"), false);
  assert.equal(run("canCapability('tasks.create')"), false);
});
