import { op, jsonBody, idParam } from '../helpers.js';

export function shoppingPaths() {
  return {
    '/api/v1/shopping': {
      get: op({ summary: 'List shopping lists alphabetically', tag: 'Shopping', description: 'Returns Shopping lists ordered by name, which is also the Meal Plan grocery-default fallback order when no explicit default is configured.' }),
      post: op({ summary: 'Create shopping list', tag: 'Shopping', stateChanging: true, requestBody: jsonBody(null, 'Body: { name }. Meal Plan grocery settings can alternatively create and select a list atomically with `new_shopping_list_name`.') }),
    },
    '/api/v1/shopping/categories': {
      get: op({ summary: 'List shopping categories', tag: 'Shopping' }),
      post: op({ summary: 'Create shopping category', tag: 'Shopping', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/shopping/categories/{catId}': {
      put: op({ summary: 'Update shopping category', tag: 'Shopping', params: [idParam('catId', 'Category ID')], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete shopping category', tag: 'Shopping', params: [idParam('catId', 'Category ID')], stateChanging: true }),
    },
    '/api/v1/shopping/categories/reorder': {
      patch: op({ summary: 'Reorder shopping categories', tag: 'Shopping', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/shopping/suggestions': { get: op({ summary: 'Get shopping suggestions', tag: 'Shopping' }) },
    '/api/v1/shopping/grocery-runs': {
      get: op({
        summary: 'List Meal-derived grocery runs',
        tag: 'Shopping',
        params: [
          { name: 'list_id', in: 'query', required: false, schema: { type: 'integer' } },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1 } },
        ],
        description: 'Grocery runs preserve planned quantities, source Meal/ingredient provenance, purchase state and Pantry reconciliation state.',
      }),
    },
    '/api/v1/shopping/grocery-runs/{runId}': {
      get: op({ summary: 'Get one grocery run and its items', tag: 'Shopping', params: [idParam('runId', 'Grocery run ID')] }),
    },
    '/api/v1/shopping/{listId}/grocery-runs': {
      post: op({
        summary: 'Create or refresh a grocery run from a Meal date range',
        tag: 'Shopping',
        params: [idParam('listId', 'Shopping list ID')],
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Body: { from, to }. Reconciles Meal ingredient demand into a stable run instead of duplicating a run for the same list and date window.',
      }),
    },
    '/api/v1/shopping/grocery-runs/{runId}/finalize': {
      post: op({ summary: 'Finalize grocery-run demand before shopping', tag: 'Shopping', params: [idParam('runId', 'Grocery run ID')], stateChanging: true, description: 'Freezes the current planned grocery quantities for the run.' }),
    },
    '/api/v1/shopping/grocery-runs/{runId}/add-to-shopping': {
      post: op({ summary: 'Publish a grocery run to its Shopping list', tag: 'Shopping', params: [idParam('runId', 'Grocery run ID')], stateChanging: true, description: 'Adds stable linked Shopping items and returns their IDs; retrying reuses previously published outputs.' }),
    },
    '/api/v1/shopping/grocery-runs/{runId}/sync-purchases': {
      post: op({ summary: 'Synchronize checked Shopping items into grocery purchase state', tag: 'Shopping', params: [idParam('runId', 'Grocery run ID')], stateChanging: true }),
    },
    '/api/v1/shopping/grocery-runs/{runId}/items/{itemId}/purchase': {
      patch: op({
        summary: 'Record purchase quantities and status for one grocery item',
        tag: 'Shopping',
        params: [idParam('runId', 'Grocery run ID'), idParam('itemId', 'Grocery item ID')],
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Body may set purchased_quantity, remaining_quantity and purchase_status before Pantry reconciliation.',
      }),
    },
    '/api/v1/shopping/items/undo-transfer': {
      post: op({
        summary: 'Undo a kitchen transfer to a shopping list',
        description: 'Removes the items created by one transfer (the `added_ids` of the response) and clears the `on_shopping_list` flag on the meal ingredients they came from. Unknown ids are skipped; `removed` reports what actually went back.',
        tag: 'Shopping',
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
    },
    '/api/v1/shopping/items/{itemId}': {
      patch: op({ summary: 'Update shopping item', tag: 'Shopping', params: [idParam('itemId', 'Item ID')], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete shopping item', tag: 'Shopping', params: [idParam('itemId', 'Item ID')], stateChanging: true }),
    },
    '/api/v1/shopping/{listId}': {
      put: op({ summary: 'Rename shopping list', tag: 'Shopping', params: [idParam('listId', 'List ID')], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete shopping list', tag: 'Shopping', params: [idParam('listId', 'List ID')], stateChanging: true }),
    },
    '/api/v1/shopping/{listId}/items': {
      get: op({ summary: 'List items in shopping list', tag: 'Shopping', params: [idParam('listId', 'List ID')] }),
      post: op({ summary: 'Add item to shopping list', tag: 'Shopping', params: [idParam('listId', 'List ID')], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/shopping/{listId}/import-pantry': {
      post: op({
        summary: 'Add pantry items to a shopping list',
        description: 'Adds low or empty pantry items to the list. Names already on the list unchecked are skipped instead of duplicated.',
        tag: 'Shopping',
        params: [idParam('listId', 'List ID')],
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
    },
    '/api/v1/shopping/{listId}/items/checked': {
      delete: op({ summary: 'Delete checked shopping items', tag: 'Shopping', params: [idParam('listId', 'List ID')], stateChanging: true }),
    },
    '/api/v1/shopping/{listId}/items/reorder': {
      patch: op({ summary: 'Reorder the items of one category', tag: 'Shopping', stateChanging: true, params: [idParam('listId', 'Shopping list ID')], requestBody: jsonBody(null), description: 'Per category rather than across the whole list: the category order is already its own handle and models the route through the shop; a second, list-wide rank beside it would make two statements about the same order. The request must name EVERY item of the category - a subset would let the ranks of the omitted ones collide with the newly assigned ones, and creation time would decide again.' }),
    },
    '/api/v1/shopping/{listId}/import-meal-plan': {
      post: op({ summary: 'Import ingredients from the meal plan into a list', tag: 'Shopping', stateChanging: true, params: [idParam('listId', 'Shopping list ID')], requestBody: jsonBody(null), description: 'Body: { from, to, preview? }. With `preview: true` nothing is written - it only counts, for the "X ingredients from Y meals" line in the import dialog.' }),
    },
  };
}
