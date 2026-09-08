import { op, jsonBody, idParam } from '../helpers.js';

const preferenceSchema = {
  type: 'object', additionalProperties: false,
  properties: Object.fromEntries(['tasks', 'meals', 'calendar', 'shopping', 'automation'].map((category) => [category, { type: 'boolean' }])),
};
const itemSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' }, title: { type: 'string' }, body: { type: 'string' },
    url: { type: 'string', description: 'Authorized, relative Vidamia destination.' },
    category: { type: 'string' }, created_at: { type: 'string' }, read_at: { type: 'string', nullable: true },
  },
};
const inboxSchema = {
  type: 'object', properties: {
    items: { type: 'array', items: itemSchema }, unreadCount: { type: 'integer', minimum: 0 },
  },
};
function personalOperation(options, dataSchema = inboxSchema) {
  const operation = op({
    tag: 'Notifications', ...options,
    description: `${options.description || ''} Requires a signed-in household member session; API tokens cannot access personal notification state. Responses are private and never cached.`.trim(),
    responses: {
      200: { description: 'Current user notification state', content: { 'application/json': { schema: { type: 'object', properties: { data: dataSchema } } } } },
      400: { $ref: '#/components/responses/BadRequest' },
      401: { $ref: '#/components/responses/Unauthorized' },
      403: { $ref: '#/components/responses/Forbidden' },
      404: { description: 'Notification not found or no longer visible', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
      500: { $ref: '#/components/responses/InternalServerError' },
    },
  });
  operation.security = [{ cookieAuth: [] }];
  return operation;
}

export function notificationsPaths() {
  return {
    '/api/v1/notifications/inbox': {
      get: personalOperation({ summary: 'List personal notification history and unread count', params: [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } }], description: 'Returns newest first, omitting dismissed items and sources the current user may no longer view.' }),
    },
    '/api/v1/notifications/inbox/{id}': {
      get: personalOperation({ summary: 'Get one authorized notification for a deep link', params: [idParam()] }, itemSchema),
      delete: personalOperation({ summary: 'Dismiss one personal notification', params: [idParam()], stateChanging: true, description: 'Retains its durable receipt. Does not change the source Task, Meal or Calendar Event.' }),
    },
    '/api/v1/notifications/inbox/{id}/read': {
      patch: personalOperation({ summary: 'Mark one personal notification as read', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/notifications/inbox/read-all': {
      post: personalOperation({ summary: 'Mark all currently visible personal notifications as read', stateChanging: true }),
    },
    '/api/v1/notifications/preferences': {
      get: personalOperation({ summary: 'Get personal notification category preferences' }, preferenceSchema),
      patch: personalOperation({ summary: 'Update personal notification category preferences', stateChanging: true, description: 'Supply only categories to change. Muting prevents new category notifications and pending delivery; unmuting does not replay past reminders.', requestBody: { required: true, content: { 'application/json': { schema: preferenceSchema } } } }, preferenceSchema),
    },
    '/api/v1/notifications/providers': {
      get: op({
        summary: 'List supported notification channel providers',
        tag: 'Notifications',
        admin: true,
      }),
    },
    '/api/v1/notifications/channels': {
      get: op({
        summary: 'List household notification channels',
        tag: 'Notifications',
        admin: true,
        responses: {
          200: {
            description: 'Notification channels with secrets omitted',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/NotificationChannelListResponse' } } },
          },
          403: { $ref: '#/components/responses/Forbidden' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      post: op({
        summary: 'Create a household notification channel',
        tag: 'Notifications',
        admin: true,
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/NotificationChannelInput'),
        responses: {
          201: {
            description: 'Notification channel created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/NotificationChannelResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          403: { $ref: '#/components/responses/Forbidden' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/notifications/channels/{id}': {
      put: op({
        summary: 'Update a household notification channel',
        tag: 'Notifications',
        admin: true,
        stateChanging: true,
        params: [idParam()],
        requestBody: jsonBody('#/components/schemas/NotificationChannelInput'),
      }),
      delete: op({
        summary: 'Delete a household notification channel',
        tag: 'Notifications',
        admin: true,
        stateChanging: true,
        params: [idParam()],
      }),
    },
    '/api/v1/notifications/channels/{id}/test': {
      post: op({
        summary: 'Send a test notification through a channel',
        tag: 'Notifications',
        admin: true,
        stateChanging: true,
        params: [idParam()],
      }),
    },

  };
}
