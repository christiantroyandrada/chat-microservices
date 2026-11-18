export {}

const order: string[] = []
const signals = new Map<string, (...args: any[]) => any>()
const mockHttp = { listening: true, close: jest.fn((callback: () => void) => { order.push('http'); mockHttp.listening = false; callback() }), closeAllConnections: jest.fn() }
const mockIo = { close: jest.fn(async () => { order.push('io'); mockHttp.listening = false }), to: jest.fn(() => ({ emit: jest.fn() })) }
const mockApp = { listen: jest.fn(() => mockHttp), locals: {} as Record<string, any> }
const mockPresence = { shutdown: jest.fn(async () => { order.push('presence') }) }
const mockBroker = { connect: jest.fn(async () => undefined), disconnect: jest.fn(async () => { order.push('broker') }) }
const mockWorker = { start: jest.fn(() => { order.push('worker-start') }), stop: jest.fn(async () => { order.push('worker-stop') }) }
const mockDatabase = { isInitialized: true, destroy: jest.fn(async () => { order.push('database') }) }
jest.mock('../../src/app', () => ({ __esModule: true, default: mockApp, setRedisHealthProvider: jest.fn() }))
jest.mock('../../src/database', () => ({ connectDB: jest.fn(async () => { order.push('database-start') }) }))
jest.mock('../../src/database/connection', () => ({ AppDataSource: mockDatabase }))
jest.mock('../../src/config/config', () => ({ __esModule: true, default: { PORT: 0 } }))
jest.mock('../../src/services/RabbitMQService', () => ({ rabbitMQService: mockBroker }))
jest.mock('../../src/services/OutboxWorker', () => ({ outboxWorker: mockWorker }))
jest.mock('../../src/websocket', () => ({ createSocketServer: jest.fn(() => mockIo) }))
jest.mock('../../src/services/PresenceStore', () => ({ getPresenceStore: () => mockPresence }))
jest.mock('../../src/utils/logger', () => ({ logInfo: jest.fn(), logWarn: jest.fn(), logError: jest.fn() }))

async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve() }

beforeEach(() => {
  jest.resetModules()
  jest.clearAllMocks()
  jest.useFakeTimers()
  order.length = 0
  signals.clear()
  mockHttp.listening = true
  Object.assign(process.env, { JWT_SECRET: 'fixture-only', DATABASE_URL: 'fixture-only', PORT: '0', MESSAGE_BROKER_URL: 'fixture-only' })
  jest.spyOn(process, 'on').mockImplementation((event, listener) => { signals.set(String(event), listener); return process })
  jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
})
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); process.exitCode = 0 })

it('starts the existing worker after database initialization and drains sockets once before worker, broker and database teardown', async () => {
  const runtime = require('../../src/server')
  if (runtime.start) await runtime.start()
  await flush()
  signals.get('SIGTERM')!()
  signals.get('SIGINT')!()
  await flush()
  expect(order).toEqual(['database-start', 'worker-start', 'io', 'worker-stop', 'broker', 'presence', 'database'])
  expect(mockIo.close).toHaveBeenCalledTimes(1)
  expect(mockWorker.stop).toHaveBeenCalledTimes(1)
})

it('attempts every owned cleanup after Socket.IO and presence cleanup failures', async () => {
  mockIo.close.mockRejectedValueOnce(new Error('fixture socket failure'))
  mockPresence.shutdown.mockRejectedValueOnce(new Error('fixture presence failure'))
  const runtime = require('../../src/server')
  if (runtime.start) await runtime.start()
  await flush()
  signals.get('SIGTERM')!()
  await flush()
  expect(order).toContain('http')
  expect(mockWorker.stop).toHaveBeenCalledTimes(1)
  expect(mockBroker.disconnect).toHaveBeenCalledTimes(1)
  expect(mockDatabase.destroy).toHaveBeenCalledTimes(1)
})

it('publishes delivery callbacks to the sender room', async () => {
  const runtime = require('../../src/server')
  if (runtime.start) await runtime.start()

  const emit = jest.fn()
  mockIo.to.mockReturnValueOnce({ emit })
  mockApp.locals.onMessageDelivered('sender-id', 'message-id', 'receiver-id')

  expect(mockIo.to).toHaveBeenCalledWith('sender-id')
  expect(emit).toHaveBeenCalledWith('messageDelivered', { messageId: 'message-id', by: 'receiver-id' })
})
