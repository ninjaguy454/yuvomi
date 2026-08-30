import { op, jsonBody, idParam } from '../helpers.js';

export function recipeProvidersPaths() {
  return {
    '/api/v1/recipe-providers/accounts': {
      get: op({
        summary: 'List recipe provider accounts',
        tag: 'Recipe providers',
        admin: true,
        description: 'External recipe sources (e.g. Tandoor). The API token of an account is never '
          + 'part of the response.',
      }),
      post: op({
        summary: 'Add a recipe provider account',
        tag: 'Recipe providers',
        admin: true,
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
    },
    '/api/v1/recipe-providers/accounts/{id}': {
      patch: op({
        summary: 'Update a recipe provider account',
        tag: 'Recipe providers',
        admin: true,
        stateChanging: true,
        params: [idParam()],
        requestBody: jsonBody(null),
      }),
      delete: op({
        summary: 'Remove a recipe provider account',
        tag: 'Recipe providers',
        admin: true,
        stateChanging: true,
        params: [idParam()],
      }),
    },
    '/api/v1/recipe-providers/accounts/{id}/test': {
      post: op({
        summary: 'Test one provider connection',
        tag: 'Recipe providers',
        admin: true,
        stateChanging: true,
        params: [idParam()],
        description: 'Contacts the provider once and reports whether the credentials work, so a '
          + 'wrong token surfaces here rather than as a sync that quietly imports nothing.',
      }),
    },
    '/api/v1/recipe-providers/accounts/{id}/sync': {
      post: op({
        summary: 'Sync one provider account now',
        tag: 'Recipe providers',
        admin: true,
        stateChanging: true,
        params: [idParam()],
      }),
    },
    '/api/v1/recipe-providers/sync': {
      post: op({
        summary: 'Sync all provider accounts now',
        tag: 'Recipe providers',
        admin: true,
        stateChanging: true,
      }),
    },
    '/api/v1/recipe-providers/status': {
      get: op({
        summary: 'Get sync status per provider account',
        tag: 'Recipe providers',
        description: 'Readable by every member, unlike the account endpoints: the recipes page shows '
          + '"last synchronised" per account, and this answer never carries the API token.',
      }),
    },
  };
}
