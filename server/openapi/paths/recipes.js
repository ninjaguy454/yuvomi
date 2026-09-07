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
      get: op({ summary: 'Get recipe and its execution pipeline', tag: 'Recipes', params: [idParam()], description: 'Includes pipeline, pipeline_revision, pipeline_source_hash, pipeline_current_source_hash, pipeline_review_needed, pipeline_invalid and pipeline_can_edit. Execution JSON is a local resource/operation document; normal written content is preserved.' }),
      put: op({ summary: 'Update recipe', tag: 'Recipes', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete recipe', tag: 'Recipes', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/recipes/{id}/pipeline': {
      put: op({
        summary: 'Save a native recipe execution pipeline', tag: 'Recipes', params: [idParam()],
        stateChanging: true, requestBody: jsonBody(null),
        description: 'Body: { pipeline, expected_revision, source_hash }. Requires the native recipe creator and Meals write access. Imported recipes must be duplicated first. Pipeline schema_version 1 contains resources and operations; dependencies are derived from producer/consumer relationships. Invalid graphs return 400; changed revisions or recipe source return 409. Successful saves increment pipeline_revision. Ordinary recipe edits preserve the saved document and mark it as needing review when ingredients or instructions change. No AI or prose inference is used.',
      }),
    },
    '/api/v1/recipes/{id}/duplicate': {
      post: op({
        summary: 'Duplicate a recipe and its pipeline atomically', tag: 'Recipes', params: [idParam()],
        stateChanging: true, requestBody: jsonBody(null),
        description: 'Body: { title? }. Requires Meals write access. Copies ordinary recipe fields, meal types, ingredients and a valid saved pipeline into a native recipe owned by the caller. Imported recipes may be copied. The pipeline keeps its original source hash and any need for review; the new revision is 1 when a pipeline exists. Invalid saved execution data returns 409 without creating a partial copy.',
      }),
    },
    '/api/v1/recipes/{id}/to-shopping-list': {
      post: op({ summary: 'Transfer recipe ingredients to shopping list', tag: 'Recipes', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/recipes/{id}/provider-thumbnail': {
      get: op({ summary: 'Fetch the image of an imported recipe', tag: 'Recipes', params: [idParam()], description: 'Proxies the bytes from the recipe provider. A direct <img src> to the provider is not possible: its media route wants the same bearer token as every other endpoint, and that token must never reach the client. Same arrangement as the DMS preview proxy.' }),
    },
  };
}
