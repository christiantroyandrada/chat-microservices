/**
 * OpenAPI 3.0 specification for user-service (Factor XIII — API First).
 *
 * This file IS the contract.  Route handlers must conform to these schemas.
 * The spec is served at /api-docs.json (always) and /api-docs (dev-only UI).
 */

const spec = {
  openapi: '3.0.3',
  info: {
    title: 'User Service',
    version: '1.0.0',
    description:
      'Authentication, user management, and Signal Protocol prekey distribution.  ' +
      'Auth uses JWT in httpOnly cookies — no token is ever returned in response bodies.  ' +
      'E2EE prekey bundles follow the Signal X3DH key agreement protocol.',
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
        description: 'JWT token set as httpOnly cookie by /login or /register',
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
      RegisterRequest: {
        type: 'object' as const,
        required: ['username', 'email', 'password'],
        properties: {
          username: { type: 'string' as const, minLength: 3, maxLength: 30, pattern: '^[a-z0-9_-]+$' },
          email: { type: 'string' as const, format: 'email' },
          password: { type: 'string' as const, minLength: 8 },
        },
      },
      LoginRequest: {
        type: 'object' as const,
        required: ['email', 'password'],
        properties: {
          email: { type: 'string' as const, format: 'email' },
          password: { type: 'string' as const },
        },
      },
      StatusResponse: {
        type: 'object' as const,
        required: ['status', 'message'],
        properties: {
          status: { type: 'integer' as const },
          message: { type: 'string' as const },
        },
      },
      User: {
        type: 'object' as const,
        required: ['id', 'username', 'email'],
        properties: {
          id:       { type: 'string' as const, format: 'uuid' },
          username: { type: 'string' as const },
          email:    { type: 'string' as const, format: 'email' },
        },
      },
      UserResponse: {
        type: 'object' as const,
        required: ['status', 'message', 'data'],
        properties: {
          status: { type: 'integer' as const },
          message: { type: 'string' as const },
          data: { $ref: '#/components/schemas/User' },
        },
      },
      SearchUser: {
        type: 'object' as const,
        required: ['_id', 'username', 'email'],
        properties: {
          _id: { type: 'string' as const, format: 'uuid' },
          username: { type: 'string' as const },
          email: { type: 'string' as const, format: 'email' },
        },
      },
      UserListResponse: {
        type: 'object' as const,
        required: ['status', 'data'],
        properties: {
          status: { type: 'integer' as const },
          data: { type: 'array' as const, items: { $ref: '#/components/schemas/SearchUser' } },
        },
      },
      SignedPreKey: {
        type: 'object' as const,
        required: ['id', 'publicKey', 'signature'],
        properties: {
          id: { type: 'integer' as const },
          publicKey: { type: 'string' as const },
          signature: { type: 'string' as const },
        },
      },
      OneTimePreKey: {
        type: 'object' as const,
        required: ['id', 'publicKey'],
        properties: {
          id: { type: 'integer' as const },
          publicKey: { type: 'string' as const },
        },
      },
      PrekeyBundle: {
        type: 'object' as const,
        description: 'Signal Protocol X3DH prekey bundle',
        required: ['registrationId', 'identityKey', 'signedPreKey', 'preKeys'],
        properties: {
          identityKey:   { type: 'string' as const, description: 'Base64-encoded identity public key' },
          signedPreKey: { $ref: '#/components/schemas/SignedPreKey' },
          preKeys: { type: 'array' as const, items: { $ref: '#/components/schemas/OneTimePreKey' } },
          registrationId: { type: 'integer' as const },
        },
      },
      PublishPrekeyRequest: {
        type: 'object' as const,
        required: ['deviceId', 'bundle'],
        properties: {
          deviceId: { type: 'string' as const },
          bundle: { $ref: '#/components/schemas/PrekeyBundle' },
        },
      },
      ConsumedPrekey: {
        type: 'object' as const,
        required: ['userId', 'deviceId', 'bundle'],
        properties: {
          userId: { type: 'string' as const, format: 'uuid' },
          deviceId: { type: 'string' as const },
          bundle: { $ref: '#/components/schemas/PrekeyBundle' },
        },
      },
      ConsumedPrekeyResponse: {
        type: 'object' as const,
        required: ['status', 'data'],
        properties: {
          status: { type: 'integer' as const },
          data: { $ref: '#/components/schemas/ConsumedPrekey' },
        },
      },
      SignalKeyBackupRequest: {
        type: 'object' as const,
        required: ['deviceId', 'encryptedBundle'],
        properties: {
          deviceId: { type: 'string' as const },
          encryptedBundle: {
            type: 'object' as const,
            required: ['encrypted', 'iv', 'salt', 'version', 'deviceId'],
            properties: {
              encrypted: { type: 'string' as const },
              iv: { type: 'string' as const },
              salt: { type: 'string' as const },
              version: { type: 'integer' as const },
              deviceId: { type: 'string' as const },
            },
          },
        },
      },
      SignalKeyBackupResponse: {
        type: 'object' as const,
        required: ['status', 'data'],
        properties: {
          status: { type: 'integer' as const },
          data: { $ref: '#/components/schemas/SignalKeyBackupRequest' },
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
    '/register': {
      post: {
        tags: ['Auth'],
        summary: 'Register a new user',
        description: 'Creates a user account and sets a JWT httpOnly cookie.  Publishes a USER_REGISTERED event to RabbitMQ.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/RegisterRequest' } } },
        },
        responses: {
          '200': { description: 'User registered (JWT set in cookie)', content: { 'application/json': { schema: { $ref: '#/components/schemas/UserResponse' } } } },
          '400': { description: 'Validation error / duplicate email or username' },
        },
      },
    },
    '/login': {
      post: {
        tags: ['Auth'],
        summary: 'Log in',
        description: 'Verifies credentials and sets a JWT httpOnly cookie.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginRequest' } } },
        },
        responses: {
          '200': { description: 'Login successful (JWT set in cookie)', content: { 'application/json': { schema: { $ref: '#/components/schemas/StatusResponse' } } } },
          '401': { description: 'Invalid email or password' },
        },
      },
    },
    '/me': {
      get: {
        tags: ['Auth'],
        summary: 'Get current authenticated user',
        security: [{ cookieAuth: [] }],
        responses: {
          '200': { description: 'Current user', content: { 'application/json': { schema: { $ref: '#/components/schemas/UserResponse' } } } },
          '401': { description: 'Authentication required' },
        },
      },
    },
    '/logout': {
      post: {
        tags: ['Auth'],
        summary: 'Log out',
        description: 'Clears the JWT cookie.',
        responses: {
          '200': { description: 'Logged out successfully', content: { 'application/json': { schema: { $ref: '#/components/schemas/StatusResponse' } } } },
        },
      },
    },
    '/search': {
      get: {
        tags: ['Users'],
        summary: 'Search users by username or email',
        security: [{ cookieAuth: [] }],
        parameters: [
          { name: 'q', in: 'query' as const, required: true, schema: { type: 'string' as const }, description: 'Search term (ILIKE match)' },
        ],
        responses: {
          '200': {
            description: 'Matching users (max 20)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/UserListResponse' } } },
          },
          '401': { description: 'Authentication required' },
        },
      },
    },
    '/users/{userId}': {
      get: {
        tags: ['Users'],
        summary: 'Get user by ID',
        description: 'Requires authentication to prevent user enumeration.',
        security: [{ cookieAuth: [] }],
        parameters: [
          { name: 'userId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        responses: {
          '200': { description: 'User found', content: { 'application/json': { schema: { $ref: '#/components/schemas/UserResponse' } } } },
          '401': { description: 'Authentication required' },
          '404': { description: 'User not found' },
        },
      },
    },
    '/prekeys': {
      post: {
        tags: ['E2EE'],
        summary: 'Publish prekey bundle',
        description: 'Upload a Signal Protocol prekey bundle for the authenticated user.',
        security: [{ cookieAuth: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/PublishPrekeyRequest' } } },
        },
        responses: {
          '200': { description: 'Prekey bundle stored', content: { 'application/json': { schema: { $ref: '#/components/schemas/StatusResponse' } } } },
          '401': { description: 'Authentication required' },
        },
      },
    },
    '/prekeys/{userId}': {
      get: {
        tags: ['E2EE'],
        summary: 'Get prekey bundle for a user',
        description: 'Consumes a one-time prekey atomically when available.',
        parameters: [
          { name: 'userId', in: 'path' as const, required: true, schema: { type: 'string' as const, format: 'uuid' } },
        ],
        responses: {
          '200': { description: 'Prekey bundle', content: { 'application/json': { schema: { $ref: '#/components/schemas/ConsumedPrekeyResponse' } } } },
          '404': { description: 'No prekey bundle found' },
        },
      },
    },
    '/signal-keys': {
      post: {
        tags: ['E2EE'],
        summary: 'Store complete Signal key set',
        security: [{ cookieAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/SignalKeyBackupRequest' } } } },
        responses: {
          '200': { description: 'Keys stored', content: { 'application/json': { schema: { $ref: '#/components/schemas/StatusResponse' } } } },
          '401': { description: 'Authentication required' },
        },
      },
      get: {
        tags: ['E2EE'],
        summary: 'Retrieve stored Signal key set',
        security: [{ cookieAuth: [] }],
        responses: {
          '200': { description: 'Stored keys', content: { 'application/json': { schema: { $ref: '#/components/schemas/SignalKeyBackupResponse' } } } },
          '401': { description: 'Authentication required' },
          '404': { description: 'No keys found' },
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
}

export default spec
