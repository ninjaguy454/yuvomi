import { op, jsonBody, idParam } from '../helpers.js';

export function rewardsPaths() {
  return {
    '/api/v1/rewards/overview': {
      get: op({ summary: 'Reward overview (balances, catalog, pending count)', tag: 'Rewards' }),
    },
    '/api/v1/rewards/changes': {
      get: op({ summary: 'Session-authorized live Reward revision stream (no personal content)', tag: 'Rewards' }),
    },
    '/api/v1/rewards/participants': {
      get: op({ summary: 'List members with participation flag and balance', tag: 'Rewards', admin: true }),
    },
    '/api/v1/rewards/participants/{userId}': {
      put: op({ summary: 'Enable/disable a member in the reward system', tag: 'Rewards', admin: true, params: [idParam('userId', 'User ID')], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/rewards/catalog': {
      get: op({ summary: 'List rewards (admin sees inactive with ?all=1)', tag: 'Rewards' }),
      post: op({ summary: 'Create reward', tag: 'Rewards', admin: true, stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/rewards/catalog/{id}': {
      patch: op({ summary: 'Update / (de)activate reward', tag: 'Rewards', admin: true, params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete reward', tag: 'Rewards', admin: true, params: [idParam()], stateChanging: true }),
    },
    '/api/v1/rewards/ledger': {
      get: op({ summary: 'Point transaction history (filter by user_id)', tag: 'Rewards' }),
    },
    '/api/v1/rewards/redemptions': {
      get: op({ summary: 'List redemption requests (filter by status)', tag: 'Rewards' }),
      post: op({ summary: 'Request a redemption (reserves points once; stable Idempotency-Key or request_id required, missing ID returns 428)', tag: 'Rewards', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/rewards/redemptions/{id}': {
      patch: op({ summary: 'Decide a redemption (fulfill/reject/cancel)', tag: 'Rewards', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/rewards/bonus': {
      post: op({ summary: 'Grant manual bonus / correction points', tag: 'Rewards', admin: true, stateChanging: true, requestBody: jsonBody(null) }),
    },
  };
}
