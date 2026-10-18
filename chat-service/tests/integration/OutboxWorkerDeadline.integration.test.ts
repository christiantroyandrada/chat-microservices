process.env.NODE_ENV = 'production'
export {}

const { createServer } = require('node:net') as typeof import('node:net')
const { Client } = require('pg') as { Client: new (options: Record<string, unknown>) => any }
const { OutboxWorker } = require('../../src/services/OutboxWorker') as typeof import('../../src/services/OutboxWorker')
const logger = require('../../src/utils/logger') as typeof import('../../src/utils/logger')

describe('OutboxWorker database transport deadline', () => {
  it.each(['START', 'COMMIT', 'ROLLBACK'] as const)(
    'destroys the acquired pg socket and finishes stop when %s stalls',
    async stalledOperation => {
    let acceptedSocket: import('node:net').Socket | undefined
    let queryStarted!: () => void
    const actualQueryStart = new Promise<void>(resolve => { queryStarted = resolve })
    let socketClosed!: () => void
    const actualSocketClose = new Promise<void>(resolve => { socketClosed = resolve })
    const server = createServer(socket => {
      acceptedSocket = socket
      socket.once('close', socketClosed)
      let buffer = Buffer.alloc(0)
      let startupComplete = false
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk])
        if (!startupComplete) {
          if (buffer.length < 4) return
          const startupLength = buffer.readUInt32BE(0)
          if (buffer.length < startupLength) return
          buffer = buffer.subarray(startupLength)
          startupComplete = true
          socket.write(Buffer.from([
            0x52, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00,
            0x5a, 0x00, 0x00, 0x00, 0x05, 0x49,
          ]))
        }
        if (buffer[0] === 0x51) queryStarted()
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('PostgreSQL fixture did not bind')
    const client = new Client({ host: '127.0.0.1', port: address.port, user: 'fixture', database: 'fixture' })
    client.on('error', () => undefined)
    await client.connect()
    const runner: any = {
      isTransactionActive: false,
      manager: {
        query: jest.fn(async () => {
          if (stalledOperation === 'ROLLBACK') throw new Error('work failed')
          return []
        }),
      },
      connect: jest.fn(async () => client),
      startTransaction: jest.fn(async () => {
        runner.isTransactionActive = true
        if (stalledOperation === 'START') await client.query('START TRANSACTION')
      }),
      commitTransaction: jest.fn(async () => {
        if (stalledOperation === 'COMMIT') await client.query('COMMIT')
        runner.isTransactionActive = false
      }),
      rollbackTransaction: jest.fn(async () => {
        if (stalledOperation === 'ROLLBACK') await client.query('ROLLBACK')
        runner.isTransactionActive = false
      }),
      release: jest.fn(async () => undefined),
    }
    const dataSource = {
      createQueryRunner: jest.fn(() => runner),
      transaction: jest.fn(async () => {
        await client.query('START TRANSACTION')
        return []
      }),
    }
    const pollError = jest.spyOn(logger, 'logError').mockImplementation(() => undefined)
    const worker = new OutboxWorker(dataSource as any, { publishNotification: jest.fn() }, jest.fn())
    let watchdogFired = false
    const watchdog = setTimeout(() => {
      watchdogFired = true
      acceptedSocket?.destroy()
    }, 7000)

    try {
      worker.start()
      await actualQueryStart
      const stopError = await worker.stop().catch(error => error)
      await actualSocketClose

      expect(stopError).toBeInstanceOf(Error)
      expect(stopError.message).toBe(
        stalledOperation === 'ROLLBACK' ? 'work failed' : 'Outbox database operation timed out',
      )
      expect(watchdogFired).toBe(false)
      expect(acceptedSocket?.destroyed).toBe(true)
      expect(pollError).toHaveBeenCalledWith('[chat-service] Outbox poll failed')
    } finally {
      clearTimeout(watchdog)
      await worker.stop().catch(() => undefined)
      await client.end().catch(() => undefined)
      acceptedSocket?.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
      pollError.mockRestore()
    }
  }, 10_000)
})
