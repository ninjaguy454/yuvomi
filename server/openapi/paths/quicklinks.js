import { op, jsonBody, idParam } from '../helpers.js';

export function quickLinksPaths() {
  return {
    '/api/v1/quick-links': {
      get: op({
        summary: 'List quick links',
        tag: 'Quick links',
        description: 'Returns the tiles visible to the calling member. A private tile belongs to '
          + 'whoever created it and is not listed for anyone else.',
      }),
      post: op({
        summary: 'Create a quick link',
        tag: 'Quick links',
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Body: { name, url, icon_data?, icon_name?, color?, visibility? }. A tile shows '
          + 'one of three faces: an uploaded image (`icon_data`), a built-in Lucide symbol '
          + '(`icon_name`), or the first letter of its name on `color`.',
      }),
    },
    '/api/v1/quick-links/order': {
      put: op({
        summary: 'Set the order of quick links',
        tag: 'Quick links',
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Body: { ids }, the complete new order. Only ids the caller can actually see '
          + 'count: slipping someone else\'s private tile into the list does not move it, because it '
          + 'is not there for the caller, and an ordering is not a way to change that.',
      }),
    },
    '/api/v1/quick-links/{id}': {
      put: op({
        summary: 'Update a quick link',
        tag: 'Quick links',
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
      delete: op({
        summary: 'Delete a quick link',
        tag: 'Quick links',
        params: [idParam()],
        stateChanging: true,
      }),
    },
  };
}
