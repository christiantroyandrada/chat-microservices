// Runtime contract tests exercise controller boundaries with the existing unit
// harness.  The JSON round-trip in captureResponse mirrors Express res.json()
// serialization (notably Date values from TypeORM entities).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_which_is_long_enough_32_chars'

import { AppDataSource } from '../../src/database'
import PrekeyController from '../../src/controllers/PrekeyController'
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
  method: 'get' | 'post',
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

async function invoke(handler: (req: any, res: any, next: any) => Promise<unknown>, req: any) {
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

const userId = '00000000-0000-0000-0000-000000000001'

const prekeyBundle = {
  registrationId: 42,
  identityKey: 'identity-key',
  signedPreKey: { id: 7, publicKey: 'signed-public-key', signature: 'signature' },
  preKeys: [{ id: 1, publicKey: 'one-time-public-key' }],
}

describe('user-service runtime OpenAPI conformance', () => {
  afterEach(() => jest.restoreAllMocks())

  it('returns a contract-declared 404 for a missing Signal backup', async () => {
    const repo = { findOne: jest.fn().mockResolvedValue(undefined) }
    jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any)

    const result = await invoke(PrekeyController.getSignalKeys, {
      user: { id: userId },
      query: { deviceId: 'device-1' },
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    })

    expect(result.statusCode).toBe(404)
    expect(result.body).toEqual({ status: 404, message: 'Operation failed' })
    assertContractResponse('/signal-keys', 'get', result.statusCode, result.body)
  })

  it('publishes a prekey bundle with the status/message-only success shape', async () => {
    const record = { userId, deviceId: 'device-1', bundle: prekeyBundle }
    const repo = {
      findOne: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockReturnValue(record),
      save: jest.fn().mockResolvedValue(record),
    }
    jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any)

    const result = await invoke(PrekeyController.publishPrekey, {
      user: { id: userId },
      body: { deviceId: 'device-1', bundle: prekeyBundle },
    })

    expect(result.statusCode).toBe(200)
    expect(result.body).toEqual({ status: 200, message: 'Prekey bundle published' })
    assertContractResponse('/prekeys', 'post', result.statusCode, result.body)
    expect(repo.create).toHaveBeenCalledWith({ userId, deviceId: 'device-1', bundle: prekeyBundle })
  })

  it('stores Signal backups with the status/message-only success shape', async () => {
    const encryptedBundle = {
      encrypted: 'ciphertext',
      iv: 'initialization-vector',
      salt: 'salt',
      version: 1,
      deviceId: 'device-1',
    }
    const record = { userId, deviceId: 'device-1', bundle: { _encryptedKeyBundle: encryptedBundle } }
    const repo = {
      findOne: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockReturnValue(record),
      save: jest.fn().mockResolvedValue(record),
    }
    jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any)

    const result = await invoke(PrekeyController.storeSignalKeys, {
      user: { id: userId },
      body: { deviceId: 'device-1', encryptedBundle },
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    })

    expect(result.statusCode).toBe(200)
    expect(result.body).toEqual({ status: 200, message: 'Encrypted keys stored' })
    assertContractResponse('/signal-keys', 'post', result.statusCode, result.body)
  })
})
