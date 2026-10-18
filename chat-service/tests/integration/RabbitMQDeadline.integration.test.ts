process.env.NODE_ENV = 'production'
export {}

const { createServer } = require('node:net') as typeof import('node:net')
const { RabbitMQService } = require('../../src/services/RabbitMQService') as typeof import('../../src/services/RabbitMQService')
const logger = require('../../src/utils/logger') as typeof import('../../src/utils/logger')

describe('RabbitMQService overall handshake cleanup', () => {
  it.each([
    ['amqp', Buffer.from([0x01, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00])],
    ['amqps', Buffer.from([0x16, 0x03, 0x03, 0x40, 0x00])],
  ] as const)('closes the actual %s socket while a valid partial protocol record keeps the idle timeout reset', async (scheme, header) => {
    let acceptedSocket: import('node:net').Socket | undefined
    let socketClosed!: () => void
    const actualSocketClose = new Promise<void>(resolve => { socketClosed = resolve })
    let drip: NodeJS.Timeout | undefined
    const server = createServer(socket => {
      acceptedSocket = socket
      socket.once('close', socketClosed)
      socket.once('data', () => {
        socket.write(header)
        drip = setInterval(() => socket.write(Buffer.from([0x00])), 250)
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, 'localhost', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('TCP fixture did not bind')
    const service = new RabbitMQService(`${scheme}://localhost:${address.port}`)
    const disconnectLog = jest.spyOn(logger, 'logInfo').mockImplementation(() => undefined)
    let watchdogFired = false
    const watchdog = setTimeout(() => {
      watchdogFired = true
      acceptedSocket?.destroy()
    }, 6500)

    try {
      const connectError = await service.connect().catch(error => error)
      await service.disconnect()
      await actualSocketClose
      expect(connectError).toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' })
      expect(watchdogFired).toBe(false)
      expect(acceptedSocket?.destroyed).toBe(true)
      expect(disconnectLog).toHaveBeenCalledWith('[chat-service] RabbitMQ disconnect complete')
    } finally {
      clearTimeout(watchdog)
      if (drip) clearInterval(drip)
      await service.disconnect()
      await new Promise<void>(resolve => server.close(() => resolve()))
      disconnectLog.mockRestore()
    }
  }, 10_000)
})
