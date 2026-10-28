export {}

const order: string[] = []
const mockHttp = {
  close: jest.fn((callback: (error?: Error) => void) => { order.push('http-stop'); callback() }),
  closeIdleConnections: jest.fn(), closeAllConnections: jest.fn(),
  once: jest.fn(), off: jest.fn(),
}
const mockDatabase = {
  isInitialized: false,
  initialize: jest.fn(async () => { order.push('database-start'); mockDatabase.isInitialized = true }),
  destroy: jest.fn(async () => { order.push('database-stop'); mockDatabase.isInitialized = false }),
}
const mockBroker = {
  connect: jest.fn(async () => { order.push('broker-start') }),
  disconnect: jest.fn(async () => { order.push('broker-stop') }),
  isHealthy: jest.fn(() => true),
}
const mockWorker = {
  start: jest.fn(() => { order.push('worker-start') }),
  stop: jest.fn(async () => { order.push('worker-stop') }),
  isHealthy: jest.fn(() => true),
}
jest.mock('../../src/database', () => ({ connectDB: () => mockDatabase.initialize(), AppDataSource: mockDatabase }))
jest.mock('../../src/database/connection', () => ({ AppDataSource: mockDatabase }))
jest.mock('../../src/services/RabbitMQService', () => ({ rabbitMQService: mockBroker }))
jest.mock('../../src/services/NotificationDeliveryWorker', () => ({ NotificationDeliveryWorker: jest.fn(() => mockWorker) }))
jest.mock('../../src/config/config', () => ({ __esModule: true, default: { PORT: 0, env: 'production' } }))
jest.mock('../../src/routes/notificationRoutes', () => ({ __esModule: true, default: require('express').Router() }))
jest.mock('../../src/utils/logger', () => ({ logInfo: jest.fn(), logWarn: jest.fn(), logError: jest.fn() }))

function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve() }
function runtime() { return require('../../src/server') }
beforeEach(() => {
  jest.resetModules(); jest.clearAllMocks(); jest.useFakeTimers()
  order.length = 0; mockDatabase.isInitialized = false
  mockBroker.isHealthy.mockReturnValue(true); mockWorker.isHealthy.mockReturnValue(true)
  Object.assign(process.env, { PORT: '0', MESSAGE_BROKER_URL: 'fixture', NOTIFICATIONS_QUEUE: 'NOTIFICATIONS', DATABASE_URL: 'fixture', JWT_SECRET: 'fixture' })
  jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  jest.spyOn(process, 'on')
  jest.spyOn(require('express').application, 'listen').mockImplementation((...args: unknown[]) => {
    order.push('http-start'); void Promise.resolve().then(args[1] as () => void); return mockHttp
  })
})
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks(); process.exitCode = 0 })
async function health(current: any, expected: number) {
  const handler = current.app.router.stack.find((layer: any) => layer.route?.path === '/health').route.stack[0].handle
  const response = { status: jest.fn().mockReturnThis(), json: jest.fn() }
  await handler({}, response)
  expect(response.status).toHaveBeenCalledWith(expected)
}

test('import has no startup or signal side effects, and startup singleflights database before worker and HTTP', async () => {
  const current = runtime()
  expect(mockDatabase.initialize).not.toHaveBeenCalled()
  expect(process.on).not.toHaveBeenCalled()
  const first = current.start()
  expect(current.start()).toBe(first)
  await first
  expect(order[0]).toBe('database-start')
  expect(order.indexOf('worker-start')).toBeGreaterThan(0)
  expect(order.indexOf('http-start')).toBeGreaterThan(0)
  expect(mockWorker.start).toHaveBeenCalledTimes(1)
  await current.gracefulShutdown('fixture')
})

test('broker outage leaves HTTP and worker available while health is degraded', async () => {
  mockBroker.connect.mockRejectedValueOnce(new Error('fixture broker outage'))
  mockBroker.isHealthy.mockReturnValue(false)
  const current = runtime()
  await current.start(); await flush()
  expect(mockWorker.start).toHaveBeenCalledTimes(1)
  expect(order).toContain('http-start')
  await health(current, 503)
  expect(process.exit).not.toHaveBeenCalled()
  await current.gracefulShutdown('fixture')
})

test('worker fatal remains observable as health503 without shutdown or process exit', async () => {
  const current = runtime()
  await current.start()
  await health(current, 200)
  mockWorker.isHealthy.mockReturnValue(false)
  await health(current, 503)
  expect(mockBroker.disconnect).not.toHaveBeenCalled()
  expect(process.exit).not.toHaveBeenCalled()
  await current.gracefulShutdown('fixture')
})

test('shutdown latches both owners before any drain, joins all resources, and shares completion', async () => {
  const workerDrain = gate(), brokerDrain = gate(), httpDrain = gate()
  const current = runtime()
  await current.start()
  mockWorker.stop.mockImplementationOnce(() => { order.push('worker-stop'); return workerDrain.promise })
  mockBroker.disconnect.mockImplementationOnce(() => { order.push('broker-stop'); return brokerDrain.promise })
  mockHttp.close.mockImplementationOnce(callback => { order.push('http-stop'); void httpDrain.promise.then(() => callback()) })
  order.length = 0
  const stopped = current.gracefulShutdown('fixture')
  expect(current.gracefulShutdown('second')).toBe(stopped)
  expect(mockWorker.stop).toHaveBeenCalledTimes(1)
  expect(mockBroker.disconnect).toHaveBeenCalledTimes(1)
  await health(current, 503)
  await flush()
  expect(mockDatabase.destroy).not.toHaveBeenCalled()
  workerDrain.release(); brokerDrain.release()
  await flush()
  expect(mockDatabase.destroy).not.toHaveBeenCalled()
  httpDrain.release(); await stopped
  expect(order[order.length - 1]).toBe('database-stop')
  expect(mockHttp.closeIdleConnections).toHaveBeenCalledTimes(1)
  expect(process.exit).not.toHaveBeenCalled()
})

test.each([false, true])('shutdown during database startup prevents later admission, startup failure=%s', async failure => {
  const ready = gate()
  const primary = new Error('fixture startup failed')
  mockDatabase.initialize.mockImplementationOnce(async () => {
    await ready.promise
    if (failure) throw primary
    mockDatabase.isInitialized = true
  })
  const current = runtime()
  const started = current.start().catch((error: unknown) => error)
  const stopped = current.gracefulShutdown('fixture')
  ready.release()
  expect(await started).toBe(failure ? primary : undefined)
  await stopped
  expect(mockWorker.start).not.toHaveBeenCalled()
  expect(mockBroker.connect).not.toHaveBeenCalled()
  expect(order).not.toContain('http-start')
  expect(mockDatabase.destroy).toHaveBeenCalledTimes(failure ? 0 : 1)
})

test('startup remains pending until HTTP listens and shutdown waits without starting the broker', async () => {
  let listening!: () => void
  jest.mocked(require('express').application.listen).mockImplementationOnce((_port: number, callback: () => void) => {
    order.push('http-start'); listening = callback; return mockHttp
  })
  const current = runtime()
  let ready = false
  const started = current.start().then(() => { ready = true })
  await flush()
  expect(ready).toBe(false)
  expect(mockBroker.connect).not.toHaveBeenCalled()
  const stopped = current.gracefulShutdown('fixture')
  expect(mockWorker.stop).toHaveBeenCalledTimes(1)
  expect(mockBroker.disconnect).toHaveBeenCalledTimes(1)
  listening()
  await Promise.all([started, stopped])
  expect(mockBroker.connect).not.toHaveBeenCalled()
  expect(mockHttp.close).toHaveBeenCalledTimes(1)
  expect(mockDatabase.destroy).toHaveBeenCalledTimes(1)
})

test('HTTP listen error rejects startup and cleans resources without process exit', async () => {
  const primary = new Error('fixture address in use')
  mockHttp.once.mockImplementationOnce((_event, handler) => { void Promise.resolve().then(() => handler(primary)); return mockHttp })
  jest.mocked(require('express').application.listen).mockImplementationOnce(() => mockHttp)
  const current = runtime()
  await expect(current.start()).rejects.toBe(primary)
  expect(mockWorker.stop).toHaveBeenCalledTimes(1)
  expect(mockBroker.disconnect).toHaveBeenCalledTimes(1)
  expect(mockDatabase.destroy).toHaveBeenCalledTimes(1)
  expect(process.exit).not.toHaveBeenCalled()
})

test('startup failure cleans acquired resources without a start/shutdown promise cycle', async () => {
  const primary = new Error('fixture listen failed')
  jest.mocked(require('express').application.listen).mockImplementationOnce(() => { throw primary })
  const current = runtime()
  await expect(current.start()).rejects.toBe(primary)
  expect(mockWorker.stop).toHaveBeenCalledTimes(1)
  expect(mockBroker.disconnect).toHaveBeenCalledTimes(1)
  expect(mockDatabase.destroy).toHaveBeenCalledTimes(1)
  await current.gracefulShutdown('fixture')
})

test('cleanup failures set exitCode and do not prevent independent cleanup', async () => {
  const current = runtime()
  await current.start()
  mockWorker.stop.mockRejectedValueOnce(new Error('fixture worker stop failed'))
  mockBroker.disconnect.mockRejectedValueOnce(new Error('fixture broker stop failed'))
  mockHttp.close.mockImplementationOnce(callback => callback(new Error('fixture HTTP close failed')))
  mockDatabase.destroy.mockRejectedValueOnce(new Error('fixture database stop failed'))
  await current.gracefulShutdown('fixture')
  expect(mockDatabase.destroy).toHaveBeenCalledTimes(1)
  expect(mockHttp.close).toHaveBeenCalledTimes(1)
  expect(process.exitCode).toBe(1)
  expect(process.exit).not.toHaveBeenCalled()
})

test('HTTP drain forces remaining connections closed after five seconds', async () => {
  const current = runtime()
  await current.start()
  mockHttp.close.mockImplementationOnce(() => undefined)
  const stopped = current.gracefulShutdown('fixture')
  await jest.advanceTimersByTimeAsync(4999)
  expect(mockHttp.closeAllConnections).not.toHaveBeenCalled()
  expect(mockDatabase.destroy).not.toHaveBeenCalled()
  await jest.advanceTimersByTimeAsync(1)
  await stopped
  expect(mockHttp.closeAllConnections).toHaveBeenCalledTimes(1)
  expect(mockDatabase.destroy).toHaveBeenCalledTimes(1)
  expect(process.exitCode).toBe(1)
})

test('requested shutdown keeps its unref watchdog after drains and terminates lingering handles at thirty seconds', async () => {
  const current = runtime()
  await current.start()
  await current.gracefulShutdown('fixture')
  await jest.advanceTimersByTimeAsync(29999)
  expect(process.exit).not.toHaveBeenCalled()
  await jest.advanceTimersByTimeAsync(1)
  expect(process.exit).toHaveBeenCalledWith(1)
})

test('invalid configuration rejects before acquisition', async () => {
  const current = runtime()
  delete process.env.MESSAGE_BROKER_URL
  await expect(current.start()).rejects.toThrow()
  expect(mockDatabase.initialize).not.toHaveBeenCalled()
  expect(process.exit).not.toHaveBeenCalled()
})
