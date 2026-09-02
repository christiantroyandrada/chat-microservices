// Runtime contract tests exercise the controller and validation boundaries with
// the existing unit harness.  The JSON round-trip mirrors Express res.json()
// serialization for Date values returned by TypeORM.
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
    case 'string':
      expect(typeof value).toBe('string')
      return
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
  sender: '00000000-0000-0000-0000-000000000001',
  recipient: '00000000-0000-0000-0000-000000000002',
  partner: '00000000-0000-0000-0000-000000000003',
}

function messageFixture(status: MessageStatus) {
  return {
    id: `00000000-0000-0000-0000-00000000000${status === MessageStatus.NotDelivered ? '4' : status === MessageStatus.Delivered ? '5' : '6'}`,
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

  it.each([
    ['Infinity', Infinity],
    ['NaN', Number.NaN],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['negative number', -1],
    ['zero limit', 0],
    ['fractional number', 1.5],
    ['negative string', '-1'],
    ['fractional string', '1.5'],
    ['unsafe integer string', '9007199254740992'],
  ])('rejects %s pagination values before controller database access', async (_label, offset) => {
    const repo = { createQueryBuilder: jest.fn() }
    jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any)

    const result = await invokePaginationValidation({ limit: '50', offset })

    expect(result.statusCode).toBe(400)
    expect(result.nextCalled).toBe(false)
    expect(result.body).toEqual(
      expect.objectContaining({ status: 400, message: 'Validation failed' }),
    )
    assertContractResponse('/get/{receiverId}', 'get', result.statusCode, result.body)
    expect(repo.createQueryBuilder).not.toHaveBeenCalled()
  })
})
