import { op, jsonBody, idParam } from '../helpers.js';

export function remindersPaths() {
  return {
    '/api/v1/reminders/pending': { get: op({ summary: 'List pending reminders', tag: 'Reminders' }) },
    '/api/v1/reminders/all': { get: op({ summary: 'List all reminders for an entity', tag: 'Reminders', description: 'Returns every non-dismissed reminder for the given entity (calendar events support multiple reminders).' }) },
    '/api/v1/reminders': {
      get: op({ summary: 'List reminders', tag: 'Reminders' }),
      post: op({ summary: 'Create reminder', tag: 'Reminders', stateChanging: true, requestBody: jsonBody(null), description: '`pantry_item` is rejected with 400: the notification run rebuilds pantry reminders every pass, so a hand-set date would be gone within a minute. Reading and dismissing work as for any other reminder. Other derived types (subscription, inventory) stay settable - there the module only writes when its object changes.' }),
      put: op({ summary: 'Replace reminder set for an entity', tag: 'Reminders', stateChanging: true, requestBody: jsonBody(null), description: 'Replaces all reminders of an entity with the given `remind_ats` list (deduplicated, max 5). `pantry_item` is rejected with 400: the notification run rebuilds pantry reminders every pass, so a hand-set date would be gone within a minute. Reading and dismissing work as for any other reminder. Other derived types (subscription, inventory) stay settable - there the module only writes when its object changes.' }),
      delete: op({ summary: 'Delete reminders by filter', tag: 'Reminders', stateChanging: true, description: '`pantry_item` is rejected with 400 - the notification run recreates the row every pass. Dismiss it instead.' }),
    },
    '/api/v1/reminders/{id}/dismiss': {
      patch: op({ summary: 'Dismiss reminder', tag: 'Reminders', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/reminders/{id}': {
      delete: op({ summary: 'Delete reminder', tag: 'Reminders', params: [idParam()], stateChanging: true, description: '`pantry_item` is rejected with 400 - the notification run recreates the row every pass. Dismiss it instead.' }),
    },
  };
}
