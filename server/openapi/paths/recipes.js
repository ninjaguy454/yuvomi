import { op, jsonBody, idParam } from '../helpers.js';

export function recipesPaths() {
  return {
    '/api/v1/recipes': {
      get: op({ summary: 'List recipes', tag: 'Recipes' }),
      post: op({ summary: 'Create recipe', tag: 'Recipes', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/recipes/url-preview': {
      post: op({
        summary: 'Import a recipe URL into a reviewable draft',
        tag: 'Recipes',
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Body: { url }. Fetches through the server-side private-network/redirect guard and returns normalized recipe fields without saving a Recipe.',
      }),
    },
    '/api/v1/recipes/markdown-preview': {
      post: op({
        summary: 'Import Recipe Markdown into a reviewable draft',
        tag: 'Recipes',
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Body: { markdown, source_url? }. Parses the shareable Yuvomi Markdown format without saving a Recipe. Markdown export itself is client-side and therefore has no separate API route.',
      }),
    },
    '/api/v1/recipes/{id}': {
      put: op({ summary: 'Update recipe', tag: 'Recipes', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete recipe', tag: 'Recipes', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/recipes/{id}/to-shopping-list': {
      post: op({ summary: 'Transfer recipe ingredients to shopping list', tag: 'Recipes', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/recipes/{id}/provider-thumbnail': {
      get: op({ summary: 'Fetch the image of an imported recipe', tag: 'Recipes', params: [idParam()], description: 'Proxies the bytes from the recipe provider. A direct <img src> to the provider is not possible: its media route wants the same bearer token as every other endpoint, and that token must never reach the client. Same arrangement as the DMS preview proxy.' }),
    },
  };
}
