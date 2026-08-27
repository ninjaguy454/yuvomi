import { op, jsonBody, idParam } from '../helpers.js';

export function notesPaths() {
  return {
    '/api/v1/notes': {
      get: op({ summary: 'List notes', tag: 'Notes' }),
      post: op({ summary: 'Create note', tag: 'Notes', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/notes/{id}': {
      put: op({ summary: 'Update note', tag: 'Notes', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete note', tag: 'Notes', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/notes/{id}/pin': {
      patch: op({ summary: 'Toggle note pin state', tag: 'Notes', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/notes/{id}/check': {
      patch: op({
        summary: 'Tick one checklist item, addressed by its source line',
        tag: 'Notes',
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
    },
  };
}
