import { op, jsonBody, idParam } from '../helpers.js';

/** Places, availability/presence, trips and Calendar planning projections. */
export function planningPaths() {
  return {
    '/api/v1/planning/places': {
      get: op({
        summary: 'List reusable Yuvomi Places',
        tag: 'Planning',
        params: [{ name: 'active', in: 'query', required: false, schema: { type: 'string', enum: ['true', 'false'] }, description: 'Defaults to active Places only. Set false to include inactive Places.' }],
        description: 'Returns immutable Yuvomi Place IDs, inherited address information and any permitted external-provider identity. Every household has an active, address-optional Home Place; the endpoint idempotently restores that default if the last active Home was removed. Renaming a Place does not change references to it.',
      }),
    },
    '/api/v1/planning/place-search/status': {
      get: op({ summary: 'Get Google Places search availability and request usage', tag: 'Planning', description: 'Returns configuration booleans, request limits and current household/member usage. The API key is never returned.' }),
    },
    '/api/v1/planning/admin/place-search-config': {
      get: op({ summary: 'Get Google Places integration settings', tag: 'Planning', admin: true, description: 'Returns whether an API key is configured and which settings are environment-managed; never returns the API key.' }),
      put: op({
        summary: 'Update Google Places integration settings',
        tag: 'Planning',
        admin: true,
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Body configures enablement, terms acceptance, request quotas, search radius, and optionally a write-only `api_key` or `clear_api_key`. Environment-managed fields cannot be overridden.',
      }),
    },
    '/api/v1/planning/place-search': {
      post: op({
        summary: 'Deliberately search Google Places near a selected origin',
        tag: 'Planning',
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Body: { query, origin_place_id?, origin_text?, included_type? }. Search is request-controlled and returns transient Google results keyed by external_place_id; it does not create Yuvomi Places.',
      }),
    },
    '/api/v1/planning/admin/context': {
      get: op({ summary: 'Get the household Place and availability authoring context', tag: 'Planning', admin: true, description: 'Returns Places, household members, recurring Availability Rules and dated Availability Periods for the administration UI.' }),
    },
    '/api/v1/planning/admin/places': {
      post: op({ summary: 'Create a user-maintained Yuvomi Place', tag: 'Planning', admin: true, stateChanging: true, requestBody: jsonBody(null), description: 'Creates a reusable Place with immutable Yuvomi identity, optional parent Place, address and coordinates. Home Places do not require an address.' }),
    },
    '/api/v1/planning/admin/places/from-google': {
      post: op({
        summary: 'Save a Google result as a reusable Yuvomi Place',
        tag: 'Planning',
        admin: true,
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Stores Google external_place_id separately from the immutable Yuvomi Place ID. Name and address remain user-maintained fields; a duplicate provider identity returns 409.',
      }),
    },
    '/api/v1/planning/admin/places/{id}': {
      put: op({ summary: 'Update a Yuvomi Place without changing its identity', tag: 'Planning', admin: true, params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete an unused Yuvomi Place', tag: 'Planning', admin: true, params: [idParam()], stateChanging: true, description: 'Returns 409 while schedules, templates, Tasks or child Places still reference the Place. Calendar Event and Meal links use their schema deletion policy and do not justify deleting other guarded references.' }),
    },
    '/api/v1/planning/admin/places/{id}/refresh-external-id': {
      post: op({ summary: 'Refresh a saved Google Place identity', tag: 'Planning', admin: true, params: [idParam()], stateChanging: true, description: 'Refreshes a stale Google place ID without changing the immutable Yuvomi Place ID; a provider-ID collision returns 409.' }),
    },
    '/api/v1/planning/admin/rules': {
      post: op({ summary: 'Create a recurring Availability Rule', tag: 'Planning', admin: true, stateChanging: true, requestBody: jsonBody(null), description: 'Defines a member, weekdays, time window, availability state, optional Place/category and active state.' }),
    },
    '/api/v1/planning/admin/rules/{id}': {
      put: op({ summary: 'Update a recurring Availability Rule', tag: 'Planning', admin: true, params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete a recurring Availability Rule', tag: 'Planning', admin: true, params: [idParam()], stateChanging: true }),
    },
    '/api/v1/planning/admin/periods': {
      post: op({ summary: 'Create a dated Availability or Presence Period', tag: 'Planning', admin: true, stateChanging: true, requestBody: jsonBody(null), description: 'Creates a bounded availability override for one household member with optional Place and note.' }),
    },
    '/api/v1/planning/admin/periods/{id}': {
      put: op({ summary: 'Update a dated Availability or Presence Period', tag: 'Planning', admin: true, params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete a dated Availability or Presence Period', tag: 'Planning', admin: true, params: [idParam()], stateChanging: true }),
    },
    '/api/v1/planning/trips': {
      get: op({
        summary: 'List Trips overlapping an optional date range',
        tag: 'Planning',
        params: [
          { name: 'from', in: 'query', required: false, schema: { type: 'string', format: 'date' } },
          { name: 'to', in: 'query', required: false, schema: { type: 'string', format: 'date' } },
        ],
      }),
    },
    '/api/v1/planning/contexts': {
      get: op({
        summary: 'List general household planning contexts',
        tag: 'Planning',
        params: [
          { name: 'from', in: 'query', required: false, schema: { type: 'string', format: 'date' }, description: 'Inclusive window start.' },
          { name: 'to', in: 'query', required: false, schema: { type: 'string', format: 'date' }, description: 'Exclusive window end.' },
          { name: 'include_cancelled', in: 'query', required: false, schema: { type: 'string', enum: ['0', '1'] }, description: 'Set to 1 to include cancelled contexts.' },
        ],
        description: 'Lists home, travel and custom contexts with members, source Events/Trips, Meal Plan bindings and unresolved conflicts. Multiple related Calendar Events may share one context.',
      }),
    },
    '/api/v1/planning/contexts/{id}': {
      get: op({ summary: 'Get one planning context with members, sources and conflicts', tag: 'Planning', params: [idParam()] }),
    },
    '/api/v1/planning/admin/contexts': {
      post: op({ summary: 'Create a manual planning context', tag: 'Planning', admin: true, stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/planning/admin/contexts/{id}': {
      put: op({ summary: 'Update a planning context and reconcile member conflicts', tag: 'Planning', admin: true, params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/planning/context-conflicts': {
      get: op({
        summary: 'List planning-context membership conflicts awaiting resolution',
        tag: 'Planning',
        params: [{ name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['open', 'resolved', 'superseded'] }, description: 'Defaults to open.' }],
        description: 'A conflict is created only when distinct contexts claim the same member for overlapping meal periods; ordinary overlapping Calendar Events are not conflicts.',
      }),
    },
    '/api/v1/planning/admin/context-conflicts/{id}/resolve': {
      post: op({ summary: 'Explicitly resolve an overlapping planning-context claim', tag: 'Planning', admin: true, params: [idParam()], stateChanging: true, requestBody: jsonBody(null), description: 'Body resolution is `keep_first` or `keep_second`. The selected context keeps the member and the other releases them; distinct overlapping contexts can never both claim the same person, and Yuvomi never chooses silently.' }),
    },
    '/api/v1/planning/admin/trips': {
      post: op({ summary: 'Create a Trip with stages and participants', tag: 'Planning', admin: true, stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/planning/admin/trips/{id}': {
      put: op({ summary: 'Update a Trip, stages and participants', tag: 'Planning', admin: true, params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete a Trip', tag: 'Planning', admin: true, params: [idParam()], stateChanging: true }),
    },
    '/api/v1/planning/trips/{id}/itinerary': {
      get: op({ summary: 'Get the dated itinerary for a Trip', tag: 'Planning', params: [idParam()] }),
    },
    '/api/v1/planning/calendar-context': {
      get: op({
        summary: 'List Meal and Trip projections for Calendar display',
        tag: 'Planning',
        params: [
          { name: 'from', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
          { name: 'to', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
        ],
        description: 'Returns read-only Calendar-shaped projections with plan_kind/plan_id provenance. It does not create duplicate Calendar Event records.',
      }),
    },
    '/api/v1/planning/presence/{userId}': {
      get: op({
        summary: 'Evaluate a member presence policy for a time window',
        tag: 'Planning',
        params: [
          idParam('userId', 'Household member ID'),
          { name: 'policy', in: 'query', required: false, schema: { type: 'string', enum: ['ignore', 'must_be_home', 'must_be_at_location', 'must_be_away', 'available_before_due'] } },
          { name: 'start_at', in: 'query', required: false, schema: { type: 'string', format: 'date-time' } },
          { name: 'end_at', in: 'query', required: false, schema: { type: 'string', format: 'date-time' } },
          { name: 'place_id', in: 'query', required: false, schema: { type: 'integer' } },
        ],
        description: 'Combines recurring rules and dated periods and returns eligibility plus the contributing availability signals.',
      }),
    },
  };
}
