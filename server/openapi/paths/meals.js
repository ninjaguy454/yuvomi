import { op, jsonBody, idParam } from '../helpers.js';

export function mealsPaths() {
  return {
    '/api/v1/meals': {
      get: op({ summary: 'List meal plan entries', tag: 'Meals', description: 'Returns ingredients, participant roles/statuses, Place, timing window, Calendar conflicts and current execution summary for each Meal.' }),
      post: op({ summary: 'Create meal plan entry', tag: 'Meals', stateChanging: true, requestBody: jsonBody(null), description: 'In addition to recipe and ingredient fields, accepts `scope`, `participants`, `place_id`, `scheduled_time`, earliest/preferred/latest times, and expected_duration_minutes.' }),
    },
    '/api/v1/meals/suggestions': { get: op({ summary: 'Get meal suggestions', tag: 'Meals' }) },
    '/api/v1/meals/planning': {
      get: op({ summary: 'Get recurring household Meal Plan configuration', tag: 'Meals', description: 'Returns timing defaults, weekly schedule slots, slot participants, household members and Meal execution settings.' }),
      put: op({
        summary: 'Replace recurring household Meal Plan configuration',
        tag: 'Meals',
        admin: true,
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Body: { timing_defaults, slots }. Slots define weekday/type, fixed/round-robin/personal-choice policy, participants and roles, Place, timing window, choice deadline, reminders and fallback behavior.',
      }),
    },
    '/api/v1/meals/execution-settings': {
      get: op({ summary: 'Get Meal execution and preparation settings', tag: 'Meals' }),
      put: op({ summary: 'Update Meal execution and preparation settings', tag: 'Meals', admin: true, stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/meals/execution/prepare': {
      post: op({
        summary: 'Prepare grocery and Task execution for a Meal date range',
        tag: 'Meals',
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Body: { from, to, shopping_list_id?, logical_key? }. Reconciliation keys make retries reuse existing grocery/execution outputs instead of duplicating them.',
      }),
    },
    '/api/v1/meals/{id}/execution': {
      get: op({ summary: 'Get and refresh execution state for one Meal', tag: 'Meals', params: [idParam()] }),
    },
    '/api/v1/meals/{id}/execution-tasks': {
      post: op({ summary: 'Create or reconcile execution Tasks for one Meal', tag: 'Meals', params: [idParam()], stateChanging: true, requestBody: jsonBody(null), description: 'Creates role-specific first-class Tasks from a stable Meal execution snapshot and reuses existing logical outputs on retry.' }),
    },
    '/api/v1/meals/planning/materialize': {
      post: op({ summary: 'Materialize one week of recurring Meal schedule', tag: 'Meals', stateChanging: true, requestBody: jsonBody(null), description: 'Body: { week? }. Creates only missing scheduled Meals and selection obligations for the containing household week, then optionally prepares execution.' }),
    },
    '/api/v1/meals/planning/reconcile': {
      post: op({ summary: 'Reconcile a changed Meal schedule slot on one date', tag: 'Meals', admin: true, stateChanging: true, requestBody: jsonBody(null), description: 'Body: { date, meal_type? }. Rebuilds only eligible awaiting-choice outputs for the requested date instead of rewriting confirmed household choices.' }),
    },
    '/api/v1/meals/selection-requests': {
      get: op({ summary: 'List Meal-selection requests for the current member', tag: 'Meals' }),
    },
    '/api/v1/meals/selection-requests-household': {
      get: op({ summary: 'List Meal-selection requests for the household', tag: 'Meals', admin: true }),
    },
    '/api/v1/meals/selection-requests/{id}/respond': {
      post: op({ summary: 'Respond to a Meal-selection request', tag: 'Meals', params: [idParam()], stateChanging: true, requestBody: jsonBody(null), description: 'Accepts a selected recipe/title or personal-choice items, or declines the obligation. The signed-in member must own the request; overdue household processing uses the separate admin timeout route.' }),
    },
    '/api/v1/meals/selection-requests/process-timeouts': {
      post: op({ summary: 'Process overdue Meal-selection requests', tag: 'Meals', admin: true, stateChanging: true, description: 'Applies configured fallback/next-chooser behavior to pending requests whose deadlines have passed. Safe to run repeatedly.' }),
    },
    '/api/v1/meals/conflicts': {
      get: op({
        summary: 'List or refresh Meal Plan Calendar conflicts for a week',
        tag: 'Meals',
        params: [
          { name: 'week', in: 'query', required: false, schema: { type: 'string', format: 'date' } },
          { name: 'refresh', in: 'query', required: false, schema: { type: 'string', enum: ['true', 'false'] }, description: 'Defaults to refreshing conflict detection before returning results.' },
        ],
      }),
    },
    '/api/v1/meals/conflicts/{id}/resolve': {
      post: op({ summary: 'Resolve a Meal Plan Calendar conflict', tag: 'Meals', params: [idParam()], stateChanging: true, requestBody: jsonBody(null), description: 'Body: { resolution, payload? }. Resolution is participating, not_participating, time_changed, backup_assigned, personal_alternative, keep_preferred_time, keep_window, or ignore. The Meal remains separate from Calendar Event storage.' }),
    },
    '/api/v1/meals/{id}': {
      put: op({ summary: 'Update meal plan entry', tag: 'Meals', params: [idParam()], stateChanging: true, requestBody: jsonBody(null), description: 'May replace participant roles/statuses, Place and timing window in addition to the ordinary Meal fields. Schedule-derived provenance and immutable identity are retained.' }),
      delete: op({ summary: 'Delete meal plan entry', tag: 'Meals', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/meals/{id}/ingredients': {
      post: op({ summary: 'Add meal ingredient', tag: 'Meals', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/meals/ingredients/{ingId}': {
      patch: op({ summary: 'Update meal ingredient', tag: 'Meals', params: [idParam('ingId', 'Ingredient ID')], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete meal ingredient', tag: 'Meals', params: [idParam('ingId', 'Ingredient ID')], stateChanging: true }),
    },
    '/api/v1/meals/{id}/to-shopping-list': {
      post: op({ summary: 'Transfer meal ingredients to shopping list', tag: 'Meals', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/meals/week-to-shopping-list': {
      post: op({ summary: 'Transfer weekly meal ingredients to shopping list', tag: 'Meals', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/meals/apply-plan': {
      post: op({ summary: 'Apply a set of planned meals at once', tag: 'Meals', stateChanging: true, requestBody: jsonBody(null), description: 'Body: { assignments, replace_existing? }. Writes several day/meal-type assignments in one call; `replace_existing: true` overwrites what is already planned on those slots instead of skipping them.' }),
    },
  };
}
