import net from 'node:net'

let mockBrokerUrl = ''
jest.mock('../../src/config/config', () => ({ __esModule: true, default: { get msgBrokerURL() { return mockBrokerUrl } } }))
jest.mock('../../src/database', () => ({ AppDataSource: {}, User: {} }))
jest.mock('../../src/utils/logger', () => ({ logInfo: jest.fn(), logError: jest.fn(), logWarn: jest.fn() }))

test('native socket abort ends a stalled AMQP handshake at the overall setup deadline', async () => {
  const sockets = new Set<net.Socket>()
  let accepted!: () => void
  const connected = new Promise<void>(resolve => { accepted = resolve })
  const listener = net.createServer(socket => {
    sockets.add(socket)
    socket.on('error', () => undefined)
    socket.on('close', () => sockets.delete(socket))
    socket.on('data', () => accepted())
  })
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
  const address = listener.address() as net.AddressInfo
  mockBrokerUrl = `amqp://127.0.0.1:${address.port}`
  jest.useFakeTimers()
  const { rabbitMQService } = require('../../src/services/RabbitMQService') as typeof import('../../src/services/RabbitMQService')
  const result = rabbitMQService.connect().then(() => 'connected', error => error)
  try {
    await connected
    await jest.advanceTimersByTimeAsync(10000)
    expect(await result).toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' })
    expect(rabbitMQService.isHealthy()).toBe(false)
    await rabbitMQService.disconnect()
    expect(jest.getTimerCount()).toBe(0)
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => listener.close(() => resolve()))
    jest.useRealTimers()
  }
})
