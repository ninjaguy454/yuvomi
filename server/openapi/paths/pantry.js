import { op, jsonBody, idParam } from '../helpers.js';

export function pantryPaths() {
  return {
    '/api/v1/pantry': {
      get: op({
        summary: 'List pantry items with storage locations, categories and Store Places',
        tag: 'Pantry',
        description: 'Each item includes optional `sku` and `preferred_store_place_id`; the response also includes `store_places` for the preferred-store selector. A preferred store is a reusable Yuvomi Place whose type is `store`.',
      }),
      post: op({
        summary: 'Create pantry item',
        tag: 'Pantry',
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Accepts optional `sku` (up to 100 characters) and `preferred_store_place_id`, which must reference an active saved Place of type `store`.',
      }),
    },
    '/api/v1/pantry/locations': {
      get: op({ summary: 'List storage locations', tag: 'Pantry' }),
      post: op({ summary: 'Create storage location', tag: 'Pantry', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/pantry/locations/reorder': {
      patch: op({ summary: 'Reorder storage locations', tag: 'Pantry', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/pantry/locations/{locId}': {
      put: op({ summary: 'Update storage location', tag: 'Pantry', params: [idParam('locId', 'Storage location ID')], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({
        summary: 'Delete storage location',
        description: 'Items keep their stock and become location-less; the last remaining location cannot be deleted.',
        tag: 'Pantry',
        params: [idParam('locId', 'Storage location ID')],
        stateChanging: true,
      }),
    },
    '/api/v1/pantry/import-shopping': {
      post: op({
        summary: 'Take checked shopping items into the pantry',
        description: 'Creates or increments pantry items from the checked items of a shopping list. Does not modify the shopping list itself — clear it separately via DELETE /api/v1/shopping/{listId}/items/checked.',
        tag: 'Pantry',
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
    },
    '/api/v1/pantry/movements': {
      get: op({
        summary: 'List immutable Pantry quantity movements',
        tag: 'Pantry',
        params: [
          { name: 'item_id', in: 'query', required: false, schema: { type: 'integer' } },
          { name: 'meal_id', in: 'query', required: false, schema: { type: 'integer' } },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 250, default: 100 } },
        ],
        description: 'The execution ledger links stock changes to Pantry items, Meals, execution snapshots and grocery runs using logical keys so retries do not duplicate movement.',
      }),
    },
    '/api/v1/pantry/reconcile-grocery-run': {
      post: op({
        summary: 'Reconcile purchased grocery-run items into Pantry',
        tag: 'Pantry',
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Body: { grocery_run_id, items }. Creates or increments Pantry stock and records one purchase movement per grocery item; already reconciled logical outputs are skipped.',
      }),
    },
    '/api/v1/pantry/leftovers': {
      post: op({
        summary: 'Record Meal leftovers in Pantry',
        tag: 'Pantry',
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Body includes name, quantity, unit, optional Meal/location/expiry and logical_key. A repeated logical key returns the existing stock result instead of adding it twice.',
      }),
    },
    '/api/v1/pantry/{itemId}/consume': {
      post: op({
        summary: 'Consume a quantity from one Pantry item',
        tag: 'Pantry',
        params: [idParam('itemId', 'Pantry item ID')],
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Body: { quantity, meal_id?, logical_key?, notes? }. Records a consumption movement and rejects a quantity greater than current stock.',
      }),
    },
    '/api/v1/pantry/{itemId}/discard-expired': {
      post: op({
        summary: 'Discard all remaining expired stock for one Pantry item',
        tag: 'Pantry',
        params: [idParam('itemId', 'Pantry item ID')],
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Sets remaining quantity to zero and records an expiry movement. `logical_key` makes retrying the operation idempotent at the domain level.',
      }),
    },
    '/api/v1/pantry/{itemId}': {
      put: op({ summary: 'Replace pantry item', tag: 'Pantry', params: [idParam('itemId', 'Item ID')], stateChanging: true, requestBody: jsonBody(null), description: 'Supports optional `sku` and an active Store Place in `preferred_store_place_id`. Omitted optional fields are cleared by a full replacement.' }),
      patch: op({ summary: 'Partially update pantry item', tag: 'Pantry', params: [idParam('itemId', 'Item ID')], stateChanging: true, requestBody: jsonBody(null), description: 'Partially updates Pantry fields, including optional `sku` and `preferred_store_place_id`, without changing omitted values.' }),
      delete: op({ summary: 'Delete pantry item', tag: 'Pantry', params: [idParam('itemId', 'Item ID')], stateChanging: true }),
    },
  };
}
