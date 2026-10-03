import { op, jsonBody, idParam } from '../helpers.js';

export function notesPaths() {
  return {
    '/api/v1/notes': {
      get: op({ summary: 'List notes', tag: 'Notes' }),
      post: op({ summary: 'Create note', tag: 'Notes', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/notes/{id}': {
      get: op({ summary: 'Read an authorized note', tag: 'Notes', params: [idParam()] }),
      put: op({ summary: 'Update note', tag: 'Notes', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete note', tag: 'Notes', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/notes/members': {
      get: op({ summary: 'Household recipients for note sharing', tag: 'Notes' }),
    },
    '/api/v1/notes/changes': {
      get: op({ summary: 'Authorized payload-free Notes change stream', tag: 'Notes' }),
    },
    '/api/v1/notes/layout': {
      patch: op({ summary: 'Atomically arrange authorized notes using layout revisions', tag: 'Notes', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/notes/{id}/layout': {
      patch: op({ summary: 'Move or resize a note using its layout revision', tag: 'Notes', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
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
