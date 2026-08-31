import { op, jsonBody, idParam } from '../helpers.js';

export function mealsPaths() {
  return {
    '/api/v1/meals': {
      get: op({ summary: 'List meal plan entries', tag: 'Meals', description: 'Returns the selected `dish`, current `menu_items` (one entree and up to three sides), ingredients, participant roles/statuses, portions, Place, timing window, Calendar conflicts and execution summary. Legacy recurring and skipped records remain readable.' }),
      post: op({ summary: 'Create meal plan entry', tag: 'Meals', stateChanging: true, requestBody: jsonBody(null, 'Preferred body: { date, meal_type, menu_items: [{ item_type: "entree", title?, recipe_id?, position: 0 }, ...sides], portions_mode: "auto"|"fixed", portions?: integer, participants?, ingredients? }. Legacy flattened title/recipe fields remain accepted.'), description: 'The preferred Add Meal contract atomically saves one selected-or-custom entree and up to three sides, preserving custom text even when a Recipe is selected. Custom dishes remain valid without a Recipe; existing Meal/menu actor and occurrence audit fields retain provenance. Automatic portions count only diners explicitly finalized as participating and remain synchronized with later participation decisions; fixed portions must be at least 1. Supplied ingredients are retained as a manual override; otherwise Recipe ingredients are predictably scaled. New menu_items writes reject legacy skipped scope and repeat_weekly; existing records and the legacy flattened compatibility path remain supported.' }),
    },
    '/api/v1/meals/suggestions': { get: op({ summary: 'Get meal suggestions', tag: 'Meals' }) },
    '/api/v1/meals/plans': {
      get: op({ summary: 'List reusable Meal Plans', tag: 'Meals', description: 'Returns named, versioned Meal Plans and their independently editable weekday rules.' }),
      post: op({ summary: 'Create a reusable Meal Plan', tag: 'Meals', admin: true, stateChanging: true, requestBody: jsonBody(null), description: 'Creates a named plan and immutable revision 1. Accepts legacy `rules` with one `weekday`, or reusable `slot_groups` with `weekdays` and optional stable `slot_group_key`. Rules support fixed/round-robin/personal-choice choosers; ordered unique `chooser_fallback_user_ids`; independent `max_entree_choices` and `max_side_choices` from 0 through 9 (`choice_limit` remains compatible); none/fixed/round_robin cook and supervisor delegation; relative or previous-week `weekly_cutoff` deadlines (`deadline_weekday` uses Monday=0 plus local `deadline_time`); per-role execution assignment strategies; and custom meal slots with required `custom_label`. An inactive plan never materializes even when its effective dates include the requested range.' }),
    },
    '/api/v1/meals/plans/{id}': {
      get: op({ summary: 'Get a Meal Plan and revision history', tag: 'Meals', params: [idParam()] }),
      put: op({ summary: 'Update a Meal Plan and append an immutable revision', tag: 'Meals', admin: true, params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Soft-delete a Meal Plan while retaining historical Meals', tag: 'Meals', admin: true, params: [idParam()], stateChanging: true, description: 'Stops future materialization and retains dated outputs and provenance.' }),
    },
    '/api/v1/meals/plans/{id}/contexts/{contextId}': {
      put: op({
        summary: 'Attach a reusable Meal Plan to a planning context',
        tag: 'Meals',
        admin: true,
        params: [idParam(), idParam('contextId', 'Planning context ID')],
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Body: { starts_on?, ends_on?, is_primary? }. Creates or updates an explicit context-plan association without consuming or mutating the household/base rotation cursor.',
      }),
      delete: op({
        summary: 'Detach a Meal Plan from a planning context',
        tag: 'Meals',
        admin: true,
        params: [idParam(), idParam('contextId', 'Planning context ID')],
        stateChanging: true,
        description: 'Stops future context materialization while retaining already dated Meals, choices, provenance and audit history.',
      }),
    },
    '/api/v1/meals/week-model': {
      get: op({ summary: 'Get the personalized My Choices weekly Meal read model', tag: 'Meals', description: 'Query: start, end, member_id?, context_id?. Returns applicable occurrences, chooser responsibility, independent participation/food decisions, menu items, availability and whether the actor may act for the selected member. For a fixed or round-robin household Meal, an unconfirmed current-generation draft is exposed only to its current chooser (or an administrator acting for that chooser); everyone else continues to see the shared Meal as Pending. Released generations remain separate audit history and never become the current chooser\'s editable menu.' }),
    },
    '/api/v1/meals/status': {
      get: op({ summary: 'Get household Meal Status grouped by planning context', tag: 'Meals', description: 'Query: start, end, context_id?. Returns choices and participant counts with the people represented by each count, pending/unavailable groups and chooser state.' }),
    },
    '/api/v1/meals/plan-defaults': {
      get: op({ summary: 'Get household Meal Plan Default Settings', tag: 'Meals', description: 'Returns the terminal chooser failsafe used after a rule-owned ordered fallback chain is exhausted: `personal_choice`, `eligible_round_robin`, or `fixed`; plus the optional fixed member and optional round-robin member group. An empty round-robin group means all eligible household members.' }),
      put: op({ summary: 'Update household Meal Plan Default Settings', tag: 'Meals', admin: true, stateChanging: true, requestBody: jsonBody(null, 'Body: { chooser_terminal_strategy: "personal_choice"|"eligible_round_robin"|"fixed", chooser_terminal_user_id?, chooser_round_robin_user_ids?: number[] }'), description: 'Updates defaults for future occurrences. Every occurrence snapshots the resolved terminal strategy and group, so changing settings never rewrites existing Meal history.' }),
    },
    '/api/v1/meals/grocery-settings': {
      get: op({ summary: 'Get independent household Meal grocery settings', tag: 'Meals' }),
      put: op({ summary: 'Update independent household Meal grocery settings', tag: 'Meals', admin: true, stateChanging: true, requestBody: jsonBody(null), description: 'Controls draft/finalization, lead time and aggregation without editing Meal Plans or execution Task settings.' }),
    },
    '/api/v1/meals/{id}/decisions': {
      post: op({ summary: 'Save a member Meal participation and food decision', tag: 'Meals', params: [idParam()], stateChanging: true, requestBody: jsonBody(null), description: 'Participation is independent from chooser responsibility. For fixed/round-robin slots, only the active participating chooser may submit entrée/side IDs from the current menu generation; released-generation IDs return 409 and cannot fulfill the new chooser obligation. Confirmation fulfills the current generation only. Other participants submit `household` with zero menu IDs or an individual `backup` with zero menu IDs plus `selected_recipe_id` and/or `selected_meal_title`. Backup materializes a linked per-person Meal. Personal Choice rejects shared/backup choices and accepts personal, restaurant, or takeout. Administrators explicitly act for a beneficiary; beneficiary, actor and optional `device_key` are audited. A changed or superseded chooser responsibility releases any authored draft or fulfilled menu as immutable history and opens a blank generation.' }),
    },
    '/api/v1/meals/{id}/chooser/repair': {
      post: op({ summary: 'Repair an unassigned or stale Meal chooser', tag: 'Meals', admin: true, params: [idParam()], stateChanging: true, requestBody: jsonBody(null), description: 'Idempotently preserves a valid active chooser, or advances the occurrence through its snapshotted ordered fixed fallbacks and household terminal failsafe. A fixed last-resort member may be prompted despite current availability or a previous skip. Menu generations never transfer between choosers.' }),
    },
    '/api/v1/meals/{id}/menu-items': {
      get: op({ summary: 'List shared entrée and side options', tag: 'Meals', params: [idParam()], description: 'Returns editable entrée/side options from the current chooser generation only, using generation-local positions. Released chooser generations remain durable audit history but are not returned as the active menu. Personal Choice occurrences return no shared menu. Legacy Backup menu rows remain readable with `legacy_only: true`; modern clients omit them when replacing a menu because the server preserves them as immutable audit data.' }),
      post: op({ summary: 'Add a shared entrée or side option', tag: 'Meals', params: [idParam()], stateChanging: true, requestBody: jsonBody(null), description: 'Allowed only for the occurrence\'s active assigned chooser, or an administrator explicitly acting for that chooser with `beneficiary_user_id`. Adds to the current chooser generation and enforces that occurrence\'s snapshotted `max_entree_choices` and `max_side_choices` limits, regardless of released history. Optional `device_key` and both identities are audited atomically with the mutation. Personal Choice has no shared menu. Backup is a per-person decision and cannot be authored as a shared menu item.' }),
      put: op({
        summary: 'Atomically replace a Meal occurrence menu',
        tag: 'Meals',
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody(null, 'Body: { items: [{ id?, item_type, position?, title, recipe_id?, notes? }] }. The array is the complete desired menu.'),
        description: 'Allowed only for the active assigned chooser, or an administrator explicitly acting for that chooser. Atomically replaces only the current chooser generation, enforces that occurrence\'s snapshotted entrée and side limits, and never counts, mutates, or deletes released-generation options. IDs from a released generation return 409. Released Backup rows are preserved as immutable legacy audit data and modern clients should omit them. Personal Choice has no shared menu.',
      }),
    },
    '/api/v1/meals/{id}/menu-items/{itemId}': {
      put: op({ summary: 'Update a Meal menu option', tag: 'Meals', params: [idParam(), idParam('itemId', 'Menu item ID')], stateChanging: true, requestBody: jsonBody(null), description: 'Allowed only for the active chooser, or an administrator explicitly acting for that chooser. The mutation and audit append are atomic. Only current-generation options are editable; released-generation IDs return 409. Personal Choice rejects shared-menu mutation.' }),
      delete: op({ summary: 'Delete a Meal menu option', tag: 'Meals', params: [idParam(), idParam('itemId', 'Menu item ID')], stateChanging: true, description: 'Allowed only for the active chooser, or an administrator explicitly acting for that chooser. The mutation and audit append are atomic. Only current-generation options are deletable; released-generation IDs return 409. Personal Choice rejects shared-menu mutation.' }),
    },
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
      post: op({ summary: 'Create or reconcile execution Tasks for one Meal', tag: 'Meals', params: [idParam()], stateChanging: true, requestBody: jsonBody(null), description: 'Creates role-specific first-class Tasks from a stable Meal execution snapshot. Each preparation/cooking/serving/cleanup/supervision role may delegate to cook, supervisor, chooser, an independent eligible round robin, or an open/claimable eligible cohort. Retries reuse assignment snapshots and never consume a rotation cursor twice.' }),
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
      post: op({ summary: 'Respond to a Meal-selection request', tag: 'Meals', params: [idParam()], stateChanging: true, requestBody: jsonBody(null), description: 'Accepts a selected recipe/title or personal-choice items, or declines the obligation. Personal responses also write the canonical audited meal_person_decision and reuse one stable primary personal Meal; additional snack choices remain compatible response items. The signed-in member must own the request; overdue household processing uses the separate admin timeout route.' }),
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
      put: op({ summary: 'Update meal plan entry', tag: 'Meals', params: [idParam()], stateChanging: true, requestBody: jsonBody(null, 'Preferred body may include the complete `menu_items`, `portions_mode`, `portions`, participants and ingredients.'), description: 'Atomically updates the selected-or-custom entree, up to three sides, participant-derived automatic or fixed portions, and ingredients. Supplied ingredients become a manual override; set ingredients_manual_override false to rematerialize Recipe ingredients. Legacy recurring/skipped records stay readable, but the preferred menu_items contract does not create them.' }),
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
      post: op({ summary: 'Apply a set of planned meals at once', tag: 'Meals', stateChanging: true, requestBody: jsonBody(null), description: 'Body: { assignments, replace_existing?, planning_context_id? }. Each assignment may override planning_context_id. Replacement is scoped to that exact Home/travel context and never deletes a child personal Meal, another context, or named-Meal-Plan output.' }),
    },
  };
}
