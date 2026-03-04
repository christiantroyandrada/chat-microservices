/**
 * OpenAPI 3.0 specification for notification-service (Factor XIII — API First).
 *
 * This file IS the contract.  Route handlers must conform to these schemas.
 * The spec is served at /api-docs.json (always) and /api-docs (dev-only UI).
 *
 * The service also consumes RabbitMQ events (MESSAGE_RECEIVED, USER_REGISTERED)
 * via an internal queue — those are documented under x-async-events.
 */

const spec = {
  openapi: '3.0.3',
  info: {
    title: 'Notification Service',
    version: '1.0.0',
    description:
      'In-app notification management and asynchronous delivery (email / push).  ' +
      'Consumes events from the NOTIFICATIONS RabbitMQ queue and creates in-app notifications.  ' +
      'REST endpoints let clients list, read, and delete their notifications.',
    contact: { name: 'Chat App Team' },
    license: { name: 'MIT' },
  },
  servers: [
    { url: '/', description: 'Behind nginx reverse-proxy' },
  ],

  components: {
    securitySchemes: {
      cookieAuth: {
        type: 'apiKey' as const,
        in: 'cookie' as const,
        name: 'jwt',
        description: 'JWT token set as httpOnly cookie by user-service',
      },
    },
    schemas: {
      Error: {
        type: 'object' as const,
        properties: {
          status:  { type: 'integer' as const },
          message: { type: 'string' as const },
        },
      },
      Notification: {
        type: 'object' as const,
        properties: {
          id:        { type: 'string' as const, format: 'uuid' },
          userId:    { type: 'string' as const, format: 'uuid' },
          type:      { type: 'string' as const, enum: ['message', 'system', 'alert'] },
          title:     { type: 'string' as const },
          message:   { type: 'string' as const },
          read:      { type: 'boolean' as const },
          createdAt: { type: 'string' as const, format: 'date-time' },
          updatedAt: { type: 'string' as const, format: 'date-time' },
        },
      },
      HealthCheck: {
        type: 'object' as const,
        properties: {
          status:  { type: 'string' as const, enum: ['ok', 'degraded', 'error'] },
          service: { type: 'string' as const },
          checks:  {
            type: 'object' as const,
            properties: {
              database: { type: 'boolean' as const },
              rabbitmq: { type: 'boolean' as const },
            },
          },
        },
      },
    },
  },

  paths: {
    '/notifications': {
      get: {
        tags: ['Notifications'],
        summary: 'List notifications for the authenticated user',
        security: [{ cookieAuth: [] }],
        parameters: [
          { name: 'limit',  in: 'query' as const, schema: { type: 'integer' as const, default: 20 } },
          { name: 'offset', in: 'query' as const, schema: { type: 'integer' as const, default: 0 } },
        ],
        responses: {
          '200': {
            description: 'Notifications list (newest first)',
            content: { 'application/json': { schema: {
              type: 'object' as const,
              properties: { data: { type: 'array' as const, items: { $ref: '#/components/schemas/Notification' } } },
            } } },
          },
          '401': { description: 'Authentication required' },
        },
      },
      post: {
        tags: ['Notifications'],
        summary: 'Create a notification (admin / system)',
        security: [{ cookieAuth: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object' as const,
            required: ['userId', 'type', 'title', 'message'],
            properties: {
              userId:  { type: 'string' as const, format: 'uuid' },
              type:    { type: 'string' as const, enum: ['message', 'system', 'alert'] },
              title:   { type: 'string' as const },
              message: { type: 'string' as const },
            },
          } } },
        },
        responses: {
          '201': { description: 'Notification created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Notification' } } } },
          '400': { description: 'Validation error' },
          '401': { description: 'Authentication required' },
        },
      },
    },
    '/notifications/unread/count': {
      get: {
        tags: ['Notifications'],
        summary: 'Get unread notification count',
        security: [{ cookieAuth: [] }],
        responses: {
          '200': {
            description: 'Unread count',
            content: { 'application/json': { schema: {
              type: 'object' as const,
              properties: { data: { type: 'object' as const, properties: { count: { type: 'integer' as const } } } },
            } } },
          },
          '401': { description: 'Authentication required' },
        },
      },
    },
    '/notifications/read-all': {
      put: {
        tags: ['Notifications'],
        summary: 'Mark all notifications as read',
        security: [{ cookieAuth: [] }],
        responses: {
          '200': {
            description: 'All marked as read',
            content: { 'application/json': { schema: {
              type: 'object' as const,
              properties: { data: { type: 'object' as const, properties: { modifiedCount: { type: 'integer' as const } } } },
            } } },
          },
          '401': { description: 'Authentication required' },
        },
      },
    },
    '/notifications/{notificationId}/read': {
      put: {
        tags: ['Notifications'],
        summary: 'Mark a single notification as read',
        security: [{ cookieAuth: [] }],
        parameters: [
          { name: 'notificationId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        responses: {
          '200': { description: 'Notification marked as read', content: { 'application/json': { schema: { $ref: '#/components/schemas/Notification' } } } },
          '401': { description: 'Authentication required' },
          '404': { description: 'Notification not found' },
        },
      },
    },
    '/notifications/{notificationId}': {
      delete: {
        tags: ['Notifications'],
        summary: 'Delete a notification',
        security: [{ cookieAuth: [] }],
        parameters: [
          { name: 'notificationId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        responses: {
          '200': { description: 'Notification deleted' },
          '401': { description: 'Authentication required' },
          '404': { description: 'Notification not found' },
        },
      },
    },
    '/health': {
      get: {
        tags: ['Operations'],
        summary: 'Health check',
        responses: {
          '200': { description: 'Healthy', content: { 'application/json': { schema: { $ref: '#/components/schemas/HealthCheck' } } } },
          '503': { description: 'Degraded / unhealthy' },
        },
      },
    },
    '/metrics': {
      get: {
        tags: ['Operations'],
        summary: 'Prometheus metrics (internal)',
        responses: { '200': { description: 'Prometheus text exposition format' } },
      },
    },
  },

  // ── Async events consumed from RabbitMQ (non-standard extension) ────────
  'x-async-events': {
    queue: 'NOTIFICATIONS',
    events: {
      MESSAGE_RECEIVED: {
        description: 'Published by chat-service when an offline user receives a message.  Creates an in-app notification and optionally sends email.',
        payload: '{ type, userId, message, envelope, isEncrypted, userEmail, userToken, fromName }',
      },
      USER_REGISTERED: {
        description: 'Published by user-service on new registration.  Creates a welcome notification and optionally sends welcome email.',
        payload: '{ type, userId, userEmail, fromName, message }',
      },
    },
  },
}

export default spec
