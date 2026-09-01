import { op, jsonBody, idParam } from '../helpers.js';

/**
 * Gilt fuer alle vier schreibenden Wege unten, deshalb einmal statt viermal:
 * was mit den Zugewiesenen eines Termins passiert (#921).
 */
const EVENT_FANOUT = ' For `entity_type=event`, a reminder set by the person who CREATED the event is also '
  + 'written for everyone assigned to it, as a row of their own - so it reaches them by push and shows up '
  + 'when they open the event, instead of leaving them an empty field that reads as "none set". A reminder '
  + 'an assignee set for themselves is never overwritten by this, a dismissed one is not resurrected unless '
  + 'the time actually changed, and removing the assignment removes the inherited row. Anyone other than the '
  + 'creator sets reminders for themselves only.';

const DERIVED_REMINDERS = '`pantry_item` and `meal` are read/dismiss only here: Pantry expiry sync owns '
  + 'the former, while a participant\'s `notify_on_menu_change` Meal decision owns the latter. Creating, '
  + 'replacing, or deleting either through the generic reminder routes returns 400.';

export function remindersPaths() {
  return {
    '/api/v1/reminders/pending': { get: op({ summary: 'List pending reminders', tag: 'Reminders' }) },
    '/api/v1/reminders/all': { get: op({ summary: 'List all reminders for an entity', tag: 'Reminders', description: 'Returns every non-dismissed reminder for the given entity (calendar events support multiple reminders).' }) },
    '/api/v1/reminders': {
      get: op({ summary: 'List reminders', tag: 'Reminders' }),
      post: op({ summary: 'Create reminder', tag: 'Reminders', stateChanging: true, requestBody: jsonBody(null), description: DERIVED_REMINDERS + ' Other module-derived types (subscription and inventory) remain settable because those modules only write when their object changes.' + EVENT_FANOUT }),
      put: op({ summary: 'Replace reminder set for an entity', tag: 'Reminders', stateChanging: true, requestBody: jsonBody(null), description: 'Replaces all reminders of an entity with the given `remind_ats` list (deduplicated, max 5). ' + DERIVED_REMINDERS + EVENT_FANOUT }),
      delete: op({ summary: 'Delete reminders by filter', tag: 'Reminders', stateChanging: true, description: DERIVED_REMINDERS + ' Dismiss a generated reminder instead.' + EVENT_FANOUT }),
    },
    '/api/v1/reminders/{id}/dismiss': {
      patch: op({ summary: 'Dismiss reminder', tag: 'Reminders', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/reminders/{id}': {
      delete: op({ summary: 'Delete reminder', tag: 'Reminders', params: [idParam()], stateChanging: true, description: DERIVED_REMINDERS + ' Dismiss a generated reminder instead.' + EVENT_FANOUT }),
    },
  };
}
