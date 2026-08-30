import { op, jsonBody, idParam } from '../helpers.js';

export function screensaverPaths() {
  return {
    '/api/v1/screensaver/config': {
      get: op({
        summary: 'Get screensaver configuration',
        tag: 'Screensaver',
        admin: true,
        description: 'Immich connection settings for the wall-display screensaver. Admin only, '
          + 'because it carries the connection details of an external server.',
      }),
      put: op({
        summary: 'Update screensaver configuration',
        tag: 'Screensaver',
        admin: true,
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
    },
    '/api/v1/screensaver/test': {
      post: op({
        summary: 'Test the Immich connection',
        tag: 'Screensaver',
        admin: true,
        stateChanging: true,
        description: 'Calls the configured Immich server once and reports how many photos the album '
          + 'holds. Answers 502 if Immich cannot be reached, so a wrong URL or token shows up here '
          + 'rather than as an empty screensaver.',
      }),
    },
    '/api/v1/screensaver/photos': {
      get: op({
        summary: 'List screensaver photos',
        tag: 'Screensaver',
        description: 'The asset ids of the configured album. Readable by every member: the wall '
          + 'display shows them, and it does not run as an administrator.',
      }),
    },
    '/api/v1/screensaver/photos/{id}': {
      get: op({
        summary: 'Fetch one screensaver photo',
        tag: 'Screensaver',
        params: [idParam('id', 'Immich asset ID')],
        description: 'Proxies the image bytes from Immich. It is fetched through Yuvomi rather than '
          + 'linked directly so the browser never needs the Immich token.',
      }),
    },
  };
}
