// JSON round-trip mirrors Express res.json() serialization of Date values.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_which_is_long_enough_32_chars'

jest.mock('uuid', () => ({ v4: () => 'mock-uuid' }))
jest.mock('amqplib', () => ({ connect: jest.fn() }))

import { AppDataSource } from '../../src/database/connection'
import MessageController, { clearUserDetailCache } from '../../src/controllers/MessageController'
import {
  fetchConversationValidation,
} from '../../src/middleware/validation/messageValidation'
import { validateRequest } from '../../src/middleware/validation/validateRequest'
import { MessageStatus } from '../../src/database/models/MessageModel'
import spec from '../../src/openapi'

type Schema = {
  $ref?: string
  type?: string
  format?: string
  nullable?: boolean
  enum?: unknown[]
  required?: string[]
  properties?: Record<string, Schema>
  items?: Schema
}

type Operation = {
  responses?: Record<string, { content?: Record<string, { schema?: Schema }> }>
}

type Contract = {
  components: { schemas: Record<string, Schema> }
  paths: Record<string, Record<string, Operation>>
}

const contract = spec as unknown as Contract

function resolveSchema(schema: Schema): Schema {
  if (!schema.$ref) return schema
  const prefix = '#/components/schemas/'
  expect(schema.$ref.startsWith(prefix)).toBe(true)
  const name = schema.$ref.slice(prefix.length)
  const resolved = contract.components.schemas[name]
  expect(resolved).toBeDefined()
  return resolved
}

function assertSchema(value: unknown, schema: Schema, path = 'response'): void {
  if (schema.nullable && value === null) return
  const resolved = resolveSchema(schema)

  if (resolved.enum) {
    expect(resolved.enum).toContain(value)
  }

  switch (resolved.type) {
    case 'object': {
      expect(value).not.toBeNull()
      expect(typeof value).toBe('object')
      expect(Array.isArray(value)).toBe(false)
      const object = value as Record<string, unknown>
      for (const field of resolved.required ?? []) {
        expect(Object.prototype.hasOwnProperty.call(object, field)).toBe(true)
      }
      for (const [field, fieldSchema] of Object.entries(resolved.properties ?? {})) {
        if (Object.prototype.hasOwnProperty.call(object, field)) {
          assertSchema(object[field], fieldSchema, `${path}.${field}`)
        }
      }
      return
    }
    case 'array':
      expect(Array.isArray(value)).toBe(true)
      if (resolved.items) {
        for (const [index, item] of (value as unknown[]).entries()) {
          assertSchema(item, resolved.items, `${path}[${index}]`)
        }
      }
      return
    case 'integer':
      expect(typeof value).toBe('number')
      expect(Number.isSafeInteger(value)).toBe(true)
      return
    case 'number':
      expect(typeof value).toBe('number')
      expect(Number.isFinite(value)).toBe(true)
      return
    case 'boolean':
      expect(typeof value).toBe('boolean')
      return
    case 'string': {
      expect(typeof value).toBe('string')
      if (resolved.format === 'uuid') {
        expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
      }
      if (resolved.format === 'date-time') {
        expect(Number.isNaN(Date.parse(value as string))).toBe(false)
      }
      return
    }
    default:
      throw new Error(`${path}: unsupported schema type ${String(resolved.type)}`)
  }
}

function assertContractResponse(
  path: string,
  method: 'get' | 'post' | 'put',
  status: number,
  body: unknown,
): void {
  const operation = contract.paths[path]?.[method]
  expect(operation).toBeDefined()
  const response = operation?.responses?.[String(status)]
  expect(response).toBeDefined()
  const schema = response?.content?.['application/json']?.schema
  expect(schema).toBeDefined()
  assertSchema(body, schema as Schema)
}

function serialize(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function captureResponse() {
  let statusCode = 200
  let body: unknown
  const res: any = {
    status(code: number) {
      statusCode = code
      return res
    },
    json(value: unknown) {
      body = serialize(value)
      return res
    },
  }
  return {
    res,
    get statusCode() {
      return statusCode
    },
    get body() {
      return body
    },
  }
}

async function invoke(
  handler: (req: any, res: any, next: any) => Promise<unknown>,
  req: any,
) {
  const captured = captureResponse()
  let error: any
  await handler(req, captured.res, (nextError: unknown) => {
    error = nextError
  })
  return {
    statusCode: error?.statusCode ?? captured.statusCode,
    body: captured.body,
    error,
  }
}

async function invokePaginationValidation(query: Record<string, unknown>) {
  const req: any = {
    params: { receiverId: userIds.recipient },
    query,
  }
  const captured = captureResponse()
  let nextCalled = false
  for (const chain of fetchConversationValidation) {
    await chain.run(req)
  }
  validateRequest(req, captured.res, () => {
    nextCalled = true
  })
  return {
    statusCode: captured.statusCode,
    body: captured.body,
    nextCalled,
  }
}

const userIds = {
  sender: '11111111-1111-4111-8111-111111111111',
  recipient: '22222222-2222-4222-8222-222222222222',
  partner: '33333333-3333-4333-8333-333333333333',
}

function messageFixture(status: MessageStatus) {
  const id =
    status === MessageStatus.NotDelivered
      ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
      : status === MessageStatus.Delivered
        ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'
        : 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3'
  return {
    id,
    senderId: userIds.sender,
    receiverId: userIds.recipient,
    message: JSON.stringify({ __encrypted: true, type: 1, body: 'Y2lwaGVydGV4dA==' }),
    isEncrypted: true,
    status,
    createdAt: '2026-09-02T12:00:00.000Z',
    updatedAt: '2026-09-02T12:00:00.000Z',
  }
}

describe('chat-service runtime OpenAPI conformance', () => {
  beforeEach(() => {
    clearUserDetailCache()
  })

  afterEach(() => {
    jest.restoreAllMocks()
    jest.clearAllMocks()
  })

  it('returns conversations with numeric unread counts and validates the full response', async () => {
    const repo = {
      query: jest.fn().mockResolvedValue([
        {
          userId: userIds.partner,
          lastMessageSenderId: userIds.partner,
          lastMessage: '[Encrypted message]',
          lastMessageTime: '2026-09-02T12:00:00.000Z',
          unreadCount: 3,
        },
      ]),
    }
    jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any)
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { username: 'bob' } }),
    }) as any

    const result = await invoke(MessageController.getConversations, {
      user: { _id: userIds.sender },
      cookies: {},
      headers: {},
    })

    expect(result.statusCode).toBe(200)
    expect(result.error).toBeUndefined()
    const body = result.body as any
    expect(typeof body.data[0].unreadCount).toBe('number')
    assertContractResponse('/conversations', 'get', result.statusCode, result.body)
  })

  it('returns every supported message status through the conversation response', async () => {
    const messages = [
      messageFixture(MessageStatus.NotDelivered),
      messageFixture(MessageStatus.Delivered),
      messageFixture(MessageStatus.Seen),
    ]
    const qb: any = {
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([messages, messages.length]),
    }
    const repo = { createQueryBuilder: jest.fn().mockReturnValue(qb) }
    jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any)

    const result = await invoke(MessageController.fetchConversation, {
      params: { receiverId: userIds.recipient },
      query: { limit: '3', offset: '0' },
      user: { _id: userIds.sender },
    })

    expect(result.statusCode).toBe(200)
    expect(result.error).toBeUndefined()
    expect((result.body as any).data.map((message: any) => message.status)).toEqual([
      'Seen',
      'Delivered',
      'NotDelivered',
    ])
    assertContractResponse('/get/{receiverId}', 'get', result.statusCode, result.body)
  })

  it('rejects malformed UUID fixtures in the schema oracle', () => {
    expect(() =>
      assertSchema('not-a-uuid', { type: 'string', format: 'uuid' }, 'response.data[0].id'),
    ).toThrow()
    expect(() =>
      assertSchema('not-a-date', { type: 'string', format: 'date-time' }, 'response.data[0].createdAt'),
    ).toThrow()
  })

  it('accepts the maximum valid pagination boundary without validation errors', async () => {
    const result = await invokePaginationValidation({ limit: '200', offset: '0' })

    expect(result.nextCalled).toBe(true)
    expect(result.body).toBeUndefined()
  })

  it.each([
    ['zero limit', { limit: '0', offset: '0' }],
    ['limit above maximum', { limit: '201', offset: '0' }],
    ['fractional limit', { limit: '1.5', offset: '0' }],
    ['infinite limit', { limit: Infinity, offset: '0' }],
    ['negative offset', { limit: '50', offset: '-1' }],
    ['fractional offset', { limit: '50', offset: '1.5' }],
    ['unsafe offset', { limit: '50', offset: '9007199254740992' }],
    ['NaN offset', { limit: '50', offset: Number.NaN }],
  ])('rejects %s', async (_label, query) => {
    const result = await invokePaginationValidation(query)

    expect(result.statusCode).toBe(400)
    expect(result.nextCalled).toBe(false)
    assertContractResponse('/get/{receiverId}', 'get', 400, result.body)
  })
})
