/**
 * OpenAPI 3.0 specification for chat-service (Factor XIII — API First).
 *
 * This file IS the contract.  Route handlers must conform to these schemas.
 * The spec is served at /api-docs.json (always) and /api-docs (dev-only UI).
 *
 * Socket.IO events are documented under x-socket-events (non-standard extension)
 * since OpenAPI 3.0 does not natively support WebSocket/event-driven APIs.
 */

const spec = {
  openapi: '3.0.3',
  info: {
    title: 'Chat Service',
    version: '1.0.0',
    description:
      'End-to-end encrypted real-time messaging service.  ' +
      'REST endpoints for message CRUD; Socket.IO for real-time delivery, typing indicators, and presence.  ' +
      'All message payloads must be Signal-protocol encrypted envelopes (`{ __encrypted: true, body: "<base64>" }`).',
    contact: { name: 'Chat App Team' },
    license: { name: 'MIT' },
  },
  servers: [
    { url: '/', description: 'Behind nginx reverse-proxy' },
  ],

  // ── Security ──────────────────────────────────────────────────────────────
  components: {
    securitySchemes: {
      cookieAuth: {
        type: 'apiKey' as const,
        in: 'cookie' as const,
        name: 'jwt',
        description: 'JWT token set as httpOnly cookie by user-service /login or /register',
      },
    },
    schemas: {
      Error: {
        type: 'object' as const,
        properties: {
          status: { type: 'integer' as const },
          message: { type: 'string' as const },
        },
      },
      Message: {
        type: 'object' as const,
        properties: {
          id:          { type: 'string' as const, format: 'uuid' },
          senderId:    { type: 'string' as const, format: 'uuid' },
          receiverId:  { type: 'string' as const, format: 'uuid' },
          message:     { type: 'string' as const, description: 'Encrypted envelope JSON string' },
          isEncrypted: { type: 'boolean' as const },
          status:      { type: 'string' as const, enum: ['Not Delivered', 'Delivered', 'Seen'] },
          createdAt:   { type: 'string' as const, format: 'date-time' },
          updatedAt:   { type: 'string' as const, format: 'date-time' },
        },
      },
      Conversation: {
        type: 'object' as const,
        properties: {
          userId:              { type: 'string' as const, format: 'uuid' },
          username:            { type: 'string' as const },
          lastMessage:         { type: 'string' as const },
          lastMessageSenderId: { type: 'string' as const, format: 'uuid' },
          lastMessageTime:     { type: 'string' as const, format: 'date-time' },
          unreadCount:         { type: 'integer' as const },
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
              redis:    { type: 'boolean' as const, nullable: true },
            },
          },
        },
      },
    },
  },

  // ── Paths ─────────────────────────────────────────────────────────────────
  paths: {
    '/send': {
      post: {
        tags: ['Messages'],
        summary: 'Send an encrypted message (REST)',
        security: [{ cookieAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object' as const,
                required: ['receiverId', 'message'],
                properties: {
                  receiverId: { type: 'string' as const, format: 'uuid' },
                  message:    { type: 'string' as const, description: 'Signal-protocol encrypted envelope (JSON string, max 5000 chars)' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Message sent', content: { 'application/json': { schema: { $ref: '#/components/schemas/Message' } } } },
          '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '401': { description: 'Authentication required' },
        },
      },
    },
    '/get/{receiverId}': {
      get: {
        tags: ['Messages'],
        summary: 'Fetch conversation with a user',
        security: [{ cookieAuth: [] }],
        parameters: [
          { name: 'receiverId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'limit',  in: 'query' as const, schema: { type: 'integer' as const, default: 50, maximum: 200 } },
          { name: 'offset', in: 'query' as const, schema: { type: 'integer' as const, default: 0 } },
        ],
        responses: {
          '200': {
            description: 'Conversation messages (chronological order)',
            content: { 'application/json': { schema: {
              type: 'object' as const,
              properties: {
                data:       { type: 'array' as const, items: { $ref: '#/components/schemas/Message' } },
                pagination: {
                  type: 'object' as const,
                  properties: {
                    total:   { type: 'integer' as const },
                    limit:   { type: 'integer' as const },
                    offset:  { type: 'integer' as const },
                    hasMore: { type: 'boolean' as const },
                  },
                },
              },
            } } },
          },
          '401': { description: 'Authentication required' },
        },
      },
    },
    '/conversations': {
      get: {
        tags: ['Messages'],
        summary: 'List all conversations for the authenticated user',
        security: [{ cookieAuth: [] }],
        responses: {
          '200': {
            description: 'Conversation list (most recent first)',
            content: { 'application/json': { schema: {
              type: 'object' as const,
              properties: {
                data: { type: 'array' as const, items: { $ref: '#/components/schemas/Conversation' } },
              },
            } } },
          },
          '401': { description: 'Authentication required' },
        },
      },
    },
    '/messages/read/{senderId}': {
      put: {
        tags: ['Messages'],
        summary: 'Mark all messages from a sender as read',
        security: [{ cookieAuth: [] }],
        parameters: [
          { name: 'senderId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        responses: {
          '200': {
            description: 'Messages marked as read',
            content: { 'application/json': { schema: {
              type: 'object' as const,
              properties: { data: { type: 'object' as const, properties: { modifiedCount: { type: 'integer' as const } } } },
            } } },
          },
          '401': { description: 'Authentication required' },
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
        summary: 'Prometheus metrics (internal — blocked by nginx in production)',
        responses: { '200': { description: 'Prometheus text exposition format' } },
      },
    },
  },

  // ── Socket.IO events (non-standard extension) ────────────────────────────
  'x-socket-events': {
    namespace: '/',
    authentication: 'JWT via httpOnly cookie (handshake) or socket.handshake.auth.token',
    events: {
      'sendMessage': {
        direction: 'client → server',
        payload: '{ senderId, receiverId, message, _id? }',
        ack: '{ ok: boolean, id?: string, error?: string }',
        description: 'Send an E2EE message via WebSocket. Server validates, persists, and broadcasts to receiver room.',
      },
      'receiveMessage': {
        direction: 'server → client',
        payload: '{ _id, id, senderId, senderUsername, receiverId, content, message, timestamp, createdAt, read }',
        description: 'Delivered to the receiver when a new message arrives.',
      },
      'typing': {
        direction: 'bidirectional',
        payload: '{ userId, isTyping: boolean }',
        description: 'Client emits to server with { receiverId, isTyping }; server forwards to the receiver room.',
      },
      'presence': {
        direction: 'server → client',
        payload: '{ userId, online: boolean, lastSeen?: string }',
        description: 'Broadcast when a user goes online or offline.',
      },
      'presenceBulk': {
        direction: 'server → client',
        payload: '{ onlineUserIds: string[] }',
        description: 'Sent once on connection with all currently online user IDs.',
      },
    },
  },
}

export default spec
