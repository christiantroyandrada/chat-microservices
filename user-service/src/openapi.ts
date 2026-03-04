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
      User: {
        type: 'object' as const,
        properties: {
          id:       { type: 'string' as const, format: 'uuid' },
          username: { type: 'string' as const },
          email:    { type: 'string' as const, format: 'email' },
        },
      },
      PrekeyBundle: {
        type: 'object' as const,
        description: 'Signal Protocol X3DH prekey bundle',
        properties: {
          identityKey:   { type: 'string' as const, description: 'Base64-encoded identity public key' },
          signedPreKey:  { type: 'object' as const, properties: { keyId: { type: 'integer' as const }, publicKey: { type: 'string' as const }, signature: { type: 'string' as const } } },
          preKey:        { type: 'object' as const, nullable: true, properties: { keyId: { type: 'integer' as const }, publicKey: { type: 'string' as const } } },
          registrationId: { type: 'integer' as const },
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
          content: { 'application/json': { schema: {
            type: 'object' as const,
            required: ['username', 'email', 'password'],
            properties: {
              username: { type: 'string' as const, minLength: 3, maxLength: 30, pattern: '^[a-z0-9_-]+$' },
              email:    { type: 'string' as const, format: 'email' },
              password: { type: 'string' as const, minLength: 8 },
            },
          } } },
        },
        responses: {
          '200': { description: 'User registered (JWT set in cookie)', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
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
          content: { 'application/json': { schema: {
            type: 'object' as const,
            required: ['email', 'password'],
            properties: {
              email:    { type: 'string' as const, format: 'email' },
              password: { type: 'string' as const },
            },
          } } },
        },
        responses: {
          '200': { description: 'Login successful (JWT set in cookie)' },
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
          '200': { description: 'Current user', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
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
          '200': { description: 'Logged out successfully' },
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
            content: { 'application/json': { schema: {
              type: 'object' as const,
              properties: { data: { type: 'array' as const, items: { $ref: '#/components/schemas/User' } } },
            } } },
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
          '200': { description: 'User found', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
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
          content: { 'application/json': { schema: { $ref: '#/components/schemas/PrekeyBundle' } } },
        },
        responses: {
          '200': { description: 'Prekey bundle stored' },
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
          '200': { description: 'Prekey bundle', content: { 'application/json': { schema: { $ref: '#/components/schemas/PrekeyBundle' } } } },
          '404': { description: 'No prekey bundle found' },
        },
      },
    },
    '/signal-keys': {
      post: {
        tags: ['E2EE'],
        summary: 'Store complete Signal key set',
        security: [{ cookieAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' as const } } } },
        responses: {
          '200': { description: 'Keys stored' },
          '401': { description: 'Authentication required' },
        },
      },
      get: {
        tags: ['E2EE'],
        summary: 'Retrieve stored Signal key set',
        security: [{ cookieAuth: [] }],
        responses: {
          '200': { description: 'Stored keys' },
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
