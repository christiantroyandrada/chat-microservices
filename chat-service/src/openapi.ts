/**
 * OpenAPI 3.0 specification for chat-service (Factor XIII — API First).
 *
 * This file IS the contract.  Route handlers must conform to these schemas.
 * The spec is served at /api-docs.json (always) and /api-docs (dev-only UI).
 *
 * The separate Go WebSocket service owns live delivery, typing, and presence.
 */

const jsonResponse = (description: string, schemaName: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: `#/components/schemas/${schemaName}` } } },
})

const readReceiptParameters = [
  { name: 'senderId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
  { name: 'expectedUserId', in: 'query' as const, required: false, schema: { type: 'string' as const, format: 'uuid' }, description: 'Optional account precondition. A mismatch with the authenticated user returns 403 before data access.' },
]
const readReceiptResponses = {
  '200': jsonResponse('Messages marked as read', 'MarkReadResponse'),
  '400': jsonResponse('Invalid sender ID or account precondition', 'Error'),
  '401': { description: 'Authentication required' },
  '403': jsonResponse('Expected user does not match authenticated user', 'Error'),
}

const spec = {
  openapi: '3.0.3',
  info: {
    title: 'Chat Service',
    version: '1.0.0',
    description:
      'End-to-end encrypted real-time messaging service.  ' +
      'REST endpoints accept encrypted message commands, history reads, and delivery receipts.  ' +
      'The Go WebSocket service provides live delivery, typing indicators, and presence.  ' +
      'Live relay failures do not reject stored commands.  ' +
      'All message payloads must be Signal-protocol encrypted envelopes (`{ __encrypted: true, body: "<base64>" }`).',
    contact: { name: 'Chat App Team' },
    license: { name: 'MIT' },
  },
  servers: [
    { url: '/', description: 'Behind nginx reverse-proxy' },
  ],

  'x-service-id': 'chat' as const,
  'x-gateway-prefix': '/chat' as const,

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
      SendMessageRequest: {
        type: 'object' as const,
        required: ['receiverId', 'message'],
        properties: {
          receiverId: { type: 'string' as const, format: 'uuid' },
          expectedSenderId: { type: 'string' as const, format: 'uuid', description: 'Optional sender precondition. A mismatch with the authenticated sender returns 403 before submission.' },
          clientMessageId: { type: 'string' as const, format: 'uuid', description: 'Optional stable send key. Reuse requires the same recipient and exact encrypted envelope.' },
          message: {
            type: 'string' as const,
            maxLength: 5000,
            description: 'Signal-protocol encrypted envelope (JSON string, max 5000 chars)',
          },
        },
      },
      MarkVisibleAsReadRequest: {
        type: 'object' as const,
        required: ['messageIds'],
        properties: {
          messageIds: { type: 'array' as const, minItems: 1, maxItems: 50, items: { type: 'string' as const, format: 'uuid' } },
        },
      },
      Message: {
        type: 'object' as const,
        required: ['id', 'senderId', 'receiverId', 'message', 'isEncrypted', 'status', 'createdAt', 'updatedAt'],
        properties: {
          id:          { type: 'string' as const, format: 'uuid' },
          senderId:    { type: 'string' as const, format: 'uuid' },
          receiverId:  { type: 'string' as const, format: 'uuid' },
          clientMessageId: { type: 'string' as const, format: 'uuid', nullable: true },
          message:     { type: 'string' as const, description: 'Encrypted envelope JSON string' },
          isEncrypted: { type: 'boolean' as const },
          status:      { type: 'string' as const, enum: ['NotDelivered', 'Delivered', 'Seen'] },
          createdAt:   { type: 'string' as const, format: 'date-time' },
          updatedAt:   { type: 'string' as const, format: 'date-time' },
        },
      },
      Conversation: {
        type: 'object' as const,
        required: ['id', 'name', 'avatar', 'lastMessage', 'unreadCount', 'lastMessageTime'],
        properties: {
          id:              { type: 'string' as const, format: 'uuid' },
          name:            { type: 'string' as const },
          avatar:          { type: 'string' as const, nullable: true },
          lastMessage:     { type: 'string' as const },
          unreadCount:     { type: 'integer' as const },
          lastMessageTime: { type: 'string' as const, format: 'date-time' },
        },
      },
      Pagination: {
        type: 'object' as const,
        required: ['total', 'limit', 'offset', 'hasMore'],
        properties: {
          total: { type: 'integer' as const },
          limit: { type: 'integer' as const },
          offset: { type: 'integer' as const },
          hasMore: { type: 'boolean' as const },
        },
      },
      MessageResponse: {
        type: 'object' as const,
        required: ['status', 'message', 'data'],
        properties: {
          status: { type: 'integer' as const },
          message: { type: 'string' as const },
          data: { $ref: '#/components/schemas/Message' },
        },
      },
      MessagesPageResponse: {
        type: 'object' as const,
        required: ['status', 'message', 'data', 'pagination'],
        properties: {
          status: { type: 'integer' as const },
          message: { type: 'string' as const },
          data: { type: 'array' as const, items: { $ref: '#/components/schemas/Message' } },
          pagination: { $ref: '#/components/schemas/Pagination' },
        },
      },
      ConversationListResponse: {
        type: 'object' as const,
        required: ['status', 'message', 'data'],
        properties: {
          status: { type: 'integer' as const },
          message: { type: 'string' as const },
          data: { type: 'array' as const, items: { $ref: '#/components/schemas/Conversation' } },
        },
      },
      MarkReadResponse: {
        type: 'object' as const,
        required: ['status', 'message', 'data'],
        properties: {
          status: { type: 'integer' as const },
          message: { type: 'string' as const },
          data: {
            type: 'object' as const,
            required: ['modifiedCount'],
            properties: { modifiedCount: { type: 'integer' as const } },
          },
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
        operationId: 'chat.sendMessage' as const,
        'x-response-mode': 'envelope' as const,
        tags: ['Messages'],
        summary: 'Send an encrypted message (REST)',
        security: [{ cookieAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SendMessageRequest' },
            },
          },
        },
        responses: {
          '200': { description: 'Message sent', content: { 'application/json': { schema: { $ref: '#/components/schemas/MessageResponse' } } } },
          '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '401': { description: 'Authentication required' },
          '403': { description: 'Expected sender does not match authenticated user', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '409': { description: 'Client message ID conflicts with the stored recipient or encrypted envelope', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/get/{receiverId}': {
      get: {
        operationId: 'chat.listMessages' as const,
        'x-response-mode': 'envelope' as const,
        tags: ['Messages'],
        summary: 'Fetch conversation with a user',
        security: [{ cookieAuth: [] }],
        parameters: [
          { name: 'receiverId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'expectedUserId', in: 'query' as const, required: false, schema: { type: 'string' as const, format: 'uuid' }, description: 'Optional account precondition. A mismatch with the authenticated user returns 403 before data access.' },
          { name: 'limit',  in: 'query' as const, schema: { type: 'integer' as const, default: 50, minimum: 1, maximum: 200 } },
          { name: 'offset', in: 'query' as const, schema: { type: 'integer' as const, default: 0, minimum: 0, maximum: Number.MAX_SAFE_INTEGER } },
          { name: 'afterMessageId', in: 'query' as const, schema: { type: 'string' as const }, description: 'Set the cursor to a message ID in this conversation or to start. The page starts after the cursor. Use offset 0.' },
          { name: 'beforeMessageId', in: 'query' as const, schema: { type: 'string' as const, format: 'uuid' }, description: 'Set the cursor to a message ID in this conversation. The page ends before the cursor. Use offset 0.' },
        ],
        responses: {
          '200': { description: 'Conversation messages (chronological order)', content: { 'application/json': { schema: { $ref: '#/components/schemas/MessagesPageResponse' } } } },
          '400': { description: 'Invalid pagination or account precondition', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '401': { description: 'Authentication required' },
          '403': { description: 'Expected user does not match authenticated user', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '404': jsonResponse('Message cursor not found in this conversation', 'Error'),
        },
      },
    },
    '/conversations': {
      get: {
        operationId: 'chat.listConversations' as const,
        'x-response-mode': 'envelope' as const,
        tags: ['Messages'],
        summary: 'List all conversations for the authenticated user',
        security: [{ cookieAuth: [] }],
        parameters: [
          { name: 'expectedUserId', in: 'query' as const, required: false, schema: { type: 'string' as const, format: 'uuid' }, description: 'Optional account precondition. A mismatch with the authenticated user returns 403 before data access.' },
        ],
        responses: {
          '200': { description: 'Conversation list (most recent first)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ConversationListResponse' } } } },
          '400': { description: 'Invalid account precondition', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '401': { description: 'Authentication required' },
          '403': { description: 'Expected user does not match authenticated user', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/messages/read/{senderId}': {
      put: {
        operationId: 'chat.markAsRead' as const,
        'x-response-mode': 'envelope' as const,
        tags: ['Messages'],
        summary: 'Mark all messages from a sender as read',
        security: [{ cookieAuth: [] }],
        parameters: readReceiptParameters,
        responses: readReceiptResponses,
      },
    },
    '/messages/read/{senderId}/visible': {
      put: {
        operationId: 'chat.markVisibleAsRead' as const,
        'x-response-mode': 'envelope' as const,
        tags: ['Messages'],
        summary: 'Mark the specified messages from a sender as read',
        security: [{ cookieAuth: [] }],
        parameters: readReceiptParameters,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/MarkVisibleAsReadRequest' },
            },
          },
        },
        responses: {
          ...readReceiptResponses,
          '400': jsonResponse('Invalid message IDs, sender ID, or account precondition', 'Error'),
        },
      },
    },
    '/messages/{messageId}/delivered': {
      put: {
        operationId: 'chat.acknowledgeDelivery' as const,
        'x-response-mode': 'envelope' as const,
        tags: ['Messages'],
        summary: 'Acknowledge delivery of a message',
        security: [{ cookieAuth: [] }],
        parameters: [
          { name: 'messageId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
          { name: 'expectedUserId', in: 'query' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        responses: {
          '200': jsonResponse('Delivery acknowledged. modifiedCount is 0 if the status did not change.', 'MarkReadResponse'),
          '400': jsonResponse('Invalid message ID or account precondition', 'Error'),
          '401': { description: 'Authentication required' },
          '403': jsonResponse('Expected user does not match authenticated user', 'Error'),
          '404': jsonResponse('Message not found for this recipient', 'Error'),
        },
      },
    },
    '/health': {
      get: {
        operationId: 'chat.health' as const,
        'x-response-mode': 'raw' as const,
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
        operationId: 'chat.metrics' as const,
        'x-response-mode': 'raw' as const,
        tags: ['Operations'],
        summary: 'Prometheus metrics (internal — blocked by nginx in production)',
        responses: { '200': { description: 'Prometheus text exposition format' } },
      },
    },
  },

}

export default spec
