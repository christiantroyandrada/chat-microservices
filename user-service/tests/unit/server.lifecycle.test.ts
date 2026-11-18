export {}

const order: string[] = []
const signals = new Map<string, (...args: unknown[]) => unknown>()
const originalSessionKey = process.env.GO_WS_SESSION_KEY
let sessionHandlers: Array<(req: any, res: any, next: () => void) => unknown> = []
const mockHttp = { close: jest.fn((callback: (error?: Error) => void) => { order.push('http'); callback() }) }
const mockBroker = { connect: jest.fn(async () => { order.push('broker-start') }), disconnect: jest.fn(async () => { order.push('broker') }), isHealthy: jest.fn(() => false) }
const mockDatabase = { isInitialized: true, destroy: jest.fn(async () => { order.push('database') }) }
const mockConnectDB = jest.fn(async () => { order.push('database-start') })
jest.mock('../../src/database', () => ({ connectDB: mockConnectDB }))
jest.mock('../../src/database/connection', () => ({ AppDataSource: mockDatabase }))
jest.mock('../../src/config/config', () => ({ __esModule: true, default: { PORT: 0, JWT_SECRET: 'fixture-secret-at-least-32-characters' } }))
jest.mock('../../src/services/RabbitMQService', () => ({ rabbitMQService: mockBroker }))
jest.mock('../../src/routes/userServiceRouter', () => ({ __esModule: true, default: require('express').Router() }))
jest.mock('../../src/utils/logger', () => ({ logInfo: jest.fn(), logWarn: jest.fn(), logError: jest.fn() }))

async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve() }
beforeEach(() => {
  jest.resetModules()
  jest.clearAllMocks()
  order.length = 0
  signals.clear()
  Object.assign(process.env, { JWT_SECRET: 'fixture-secret-at-least-32-characters', DATABASE_URL: 'fixture-only', PORT: '0', MESSAGE_BROKER_URL: 'fixture-only' })
  jest.spyOn(process, 'on').mockImplementation((event, listener) => { signals.set(String(event), listener); return process })
  jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  jest.spyOn(require('express').application, 'get').mockImplementation(function (this: any, path: string, ...handlers: any[]) {
    if (path === '/internal/ws/session') sessionHandlers = handlers
    return this
  } as any)
  jest.spyOn(require('express').application, 'listen').mockImplementation(() => { order.push('http-start'); return mockHttp })
})
afterEach(() => {
  jest.restoreAllMocks()
  process.exitCode = 0
  sessionHandlers = []
  if (originalSessionKey === undefined) delete process.env.GO_WS_SESSION_KEY
  else process.env.GO_WS_SESSION_KEY = originalSessionKey
})
async function start() {
  const runtime = require('../../src/server')
  if (runtime.start) await runtime.start()
  await flush()
  return runtime
}
test('initializes database before broker and keeps HTTP available after broker rejection', async () => {
  mockBroker.connect.mockRejectedValueOnce(new Error('fixture broker outage'))
  await start()
  expect(order).toEqual(['database-start', 'http-start'])
  expect(mockBroker.connect).toHaveBeenCalledTimes(1)
  expect(mockHttp.close).not.toHaveBeenCalled()
  expect(process.exit).not.toHaveBeenCalled()
})
test('drains HTTP before broker and database once for repeated signals without process.exit', async () => {
  await start()
  let drained!: () => void
  mockHttp.close.mockImplementationOnce(callback => { order.push('http'); drained = callback })
  order.length = 0
  signals.get('SIGTERM')!()
  signals.get('SIGINT')!()
  await flush()
  expect(order).toEqual(['http'])
  expect(mockBroker.disconnect).not.toHaveBeenCalled()
  drained()
  await flush()
  expect(order).toEqual(['http', 'broker', 'database'])
  expect(process.exit).not.toHaveBeenCalled()
})

test('joins startup before shutdown and returns one shared shutdown promise', async () => {
  let databaseReady!: () => void
  mockConnectDB.mockImplementationOnce(() => new Promise<void>(resolve => { databaseReady = resolve }))
  const runtime = require('../../src/server')
  const started = runtime.start()
  const stopped = runtime.gracefulShutdown('SIGTERM')
  expect(runtime.gracefulShutdown('SIGINT')).toBe(stopped)
  await flush()
  expect(mockHttp.close).not.toHaveBeenCalled()
  databaseReady()
  await Promise.all([started, stopped])
  expect(order).toEqual(['http-start', 'broker-start', 'http', 'broker', 'database'])
})
test('observes HTTP close errors and attempts broker and database cleanup independently', async () => {
  mockHttp.close.mockImplementationOnce(callback => { order.push('http'); callback(new Error('fixture HTTP failure')) })
  mockBroker.disconnect.mockRejectedValueOnce(new Error('fixture broker failure'))
  mockDatabase.destroy.mockRejectedValueOnce(new Error('fixture database failure'))
  await start()
  order.length = 0
  signals.get('SIGTERM')!()
  await flush()
  expect(mockBroker.disconnect).toHaveBeenCalledTimes(1)
  expect(mockDatabase.destroy).toHaveBeenCalledTimes(1)
  expect(process.exitCode).toBe(1)
  expect(process.exit).not.toHaveBeenCalled()
})

test('an HTTP callback error alone sets failure status without skipping later cleanup', async () => {
  mockHttp.close.mockImplementationOnce(callback => { callback(new Error('fixture HTTP failure')) })
  const runtime = await start()
  await runtime.gracefulShutdown('SIGTERM')
  expect(process.exitCode).toBe(1)
  expect(mockBroker.disconnect).toHaveBeenCalledTimes(1)
  expect(mockDatabase.destroy).toHaveBeenCalledTimes(1)
})

test('invalid startup configuration rejects before resource acquisition without process.exit', async () => {
  delete process.env.MESSAGE_BROKER_URL
  const runtime = require('../../src/server')
  await expect(runtime.start()).rejects.toThrow()
  expect(mockConnectDB).not.toHaveBeenCalled()
  expect(process.exit).not.toHaveBeenCalled()
})

test('protects the websocket session route with the relay key and cookie checks', async () => {
  process.env.GO_WS_SESSION_KEY = 'fixture-relay-session-key-at-least-32-bytes'
  const runtime = require('../../src/server')
  expect(runtime).toBeDefined()
  expect(sessionHandlers).toHaveLength(3)
  const [guard] = sessionHandlers
  const response = () => ({ sendStatus: jest.fn(), set: jest.fn() })

  const missingKey = response()
  await guard({ get: () => undefined, cookies: {} }, missingKey, jest.fn())
  expect(missingKey.sendStatus).toHaveBeenCalledWith(404)

  const wrongKey = response()
  await guard({ get: () => 'wrong-key', cookies: {} }, wrongKey, jest.fn())
  expect(wrongKey.sendStatus).toHaveBeenCalledWith(404)

  const noCookie = response()
  await guard({ get: () => process.env.GO_WS_SESSION_KEY, cookies: {}, headers: {} }, noCookie, jest.fn())
  expect(noCookie.sendStatus).toHaveBeenCalledWith(401)

  const bearerOnly = response()
  await guard({ get: () => process.env.GO_WS_SESSION_KEY, cookies: {}, headers: { authorization: 'Bearer fixture' } }, bearerOnly, jest.fn())
  expect(bearerOnly.sendStatus).toHaveBeenCalledWith(401)
  const cookieAndBearer = response()
  await guard({ get: () => process.env.GO_WS_SESSION_KEY, cookies: { jwt: 'fixture' }, headers: { authorization: 'Bearer fixture' } }, cookieAndBearer, jest.fn())
  expect(cookieAndBearer.sendStatus).toHaveBeenCalledWith(401)
})

test('passes valid relay and cookie requests through authenticated middleware with no-store', async () => {
  process.env.GO_WS_SESSION_KEY = 'fixture-relay-session-key-at-least-32-bytes'
  require('../../src/server')
  const [guard, auth] = sessionHandlers
  const jwt = require('jsonwebtoken')
  const req = {
    get: () => process.env.GO_WS_SESSION_KEY,
    cookies: { jwt: jwt.sign({ id: 'fixture-user' }, 'fixture-secret-at-least-32-characters') },
    headers: {},
  }
  const res = { sendStatus: jest.fn(), set: jest.fn() }
  const guardNext = jest.fn()
  await guard(req, res, guardNext)
  expect(guardNext).toHaveBeenCalledTimes(1)
  expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
  const authNext = jest.fn()
  await auth(req, res, authNext)
  expect(authNext).toHaveBeenCalledTimes(1)
  expect(authNext).toHaveBeenCalledWith()
})

test('rejects short relay keys at startup', async () => {
  process.env.GO_WS_SESSION_KEY = 'too-short'
  const shortKeyRuntime = require('../../src/server')
  await expect(shortKeyRuntime.start()).rejects.toThrow('GO_WS_SESSION_KEY must contain at least 32 bytes')
  expect(mockConnectDB).not.toHaveBeenCalled()
})

test('returns 404 when the relay key is disabled', async () => {
  delete process.env.GO_WS_SESSION_KEY
  const disabledRuntime = require('../../src/server')
  expect(disabledRuntime).toBeDefined()
  const response = { sendStatus: jest.fn(), set: jest.fn() }
  await sessionHandlers[0]({ get: () => 'fixture-relay-session-key-at-least-32-bytes', cookies: { jwt: 'fixture' }, headers: {} }, response, jest.fn())
  expect(response.sendStatus).toHaveBeenCalledWith(404)
})
