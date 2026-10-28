import net from 'node:net'

let mockBrokerUrl = ''
jest.mock('../../src/config/config', () => ({ __esModule: true, default: { get msgBrokerURL() { return mockBrokerUrl }, queue: { notifications: 'NOTIFICATIONS' } } }))
jest.mock('../../src/services/NotificationInbox', () => ({ notificationInbox: { accept: jest.fn() }, PermanentNotificationError: class extends Error {} }))
jest.mock('../../src/utils/logger', () => ({ logInfo: jest.fn(), logWarn: jest.fn(), logError: jest.fn() }))

test.each(['deadline', 'disconnect'])('native socket abort closes a stalled AMQP handshake on %s', async action => {
  jest.resetModules()
  const sockets = new Set<net.Socket>()
  let accepted!: () => void, closed!: () => void
  const connected = new Promise<void>(resolve => { accepted = resolve })
  const socketClosed = new Promise<void>(resolve => { closed = resolve })
  const listener = net.createServer(socket => {
    sockets.add(socket)
    socket.on('error', () => undefined)
    socket.on('data', accepted)
    socket.on('close', () => { sockets.delete(socket); closed() })
  })
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
  const address = listener.address() as net.AddressInfo
  mockBrokerUrl = `amqp://127.0.0.1:${address.port}`
  jest.useFakeTimers()
  const { rabbitMQService: service } = require('../../src/services/RabbitMQService') as typeof import('../../src/services/RabbitMQService')
  const result = service.connect().catch(error => error)
  try {
    await connected
    expect(service.isHealthy()).toBe(false)
    if (action === 'deadline') await jest.advanceTimersByTimeAsync(10000)
    else await service.disconnect()
    expect(await result).toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' })
    await socketClosed
    expect(sockets.size).toBe(0)
    await service.disconnect()
    expect(jest.getTimerCount()).toBe(0)
  } finally {
    await service.disconnect()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => listener.close(() => resolve()))
    jest.useRealTimers()
  }
}, 10000)
