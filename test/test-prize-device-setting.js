import test from 'node:test';
import assert from 'node:assert/strict';
import {devicePreset,normalizeDevicePermissions} from '../server/services/devices.js';
import {deviceAppRouteSupported} from '../server/services/device-app-paths.js';
test('the separate device redemption permission defaults off for new and existing configurations',()=>{
  assert.equal(devicePreset().capabilities['device_rewards.redeem'],'none');
  const old=devicePreset();delete old.capabilities['device_rewards.redeem'];
  assert.equal(normalizeDevicePermissions(old).capabilities['device_rewards.redeem'],'none');
});
test('a stored device redemption setting does not grant general Rewards write or an anonymous spending route',()=>{
  const permissions=devicePreset();permissions.capabilities['device_rewards.redeem']='allow';
  const normalized=normalizeDevicePermissions(permissions);
  assert.equal(normalized.capabilities['device_rewards.redeem'],'allow');assert.equal(normalized.modules.rewards,'read');
  assert.equal(deviceAppRouteSupported({method:'POST',path:'/rewards/redemptions'}),false);
});
