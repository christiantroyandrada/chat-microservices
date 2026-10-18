process.env.NODE_ENV = 'production'
export {}

const { createServer } = require('node:net') as typeof import('node:net')
const { createRedisContext } = require('../../src/services/RedisService') as typeof import('../../src/services/RedisService')
const logger = require('../../src/utils/logger') as typeof import('../../src/utils/logger')

function readCommand(buffer: Buffer): { command: string, rest: Buffer } | undefined {
  const firstLineEnd = buffer.indexOf('\r\n')
  if (firstLineEnd < 0 || buffer[0] !== 0x2a) return
  const count = Number(buffer.subarray(1, firstLineEnd).toString())
  let offset = firstLineEnd + 2
  const values: string[] = []
  for (let index = 0; index < count; index++) {
    const lengthEnd = buffer.indexOf('\r\n', offset)
    if (lengthEnd < 0 || buffer[offset] !== 0x24) return
    const length = Number(buffer.subarray(offset + 1, lengthEnd).toString())
    const valueStart = lengthEnd + 2
    const valueEnd = valueStart + length
    if (buffer.length < valueEnd + 2) return
    values.push(buffer.subarray(valueStart, valueEnd).toString())
    offset = valueEnd + 2
  }
  return { command: values[0]?.toUpperCase() ?? '', rest: buffer.subarray(offset) }
}

describe('RedisService command deadline', () => {
  it('settles a stalled presence read while the shared Redis connection remains open', async () => {
    const sockets = new Set<import('node:net').Socket>()
    let presenceReadStarted!: () => void
    const actualPresenceRead = new Promise<void>(resolve => { presenceReadStarted = resolve })
    let releasePresenceRead!: () => void
    const presenceReadReleased = new Promise<void>(resolve => { releasePresenceRead = resolve })
    const server = createServer(socket => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      let buffer: Buffer = Buffer.alloc(0)
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk])
        let parsed = readCommand(buffer)
        while (parsed) {
          buffer = parsed.rest
          if (parsed.command === 'INFO') {
            socket.write('$11\r\nloading:0\r\n\r\n')
          } else if (parsed.command === 'SISMEMBER') {
            presenceReadStarted()
            setTimeout(() => {
              socket.write(':0\r\n')
              releasePresenceRead()
            }, 6500)
          } else {
            socket.write('+OK\r\n')
            if (parsed.command === 'QUIT') socket.end()
          }
          parsed = readCommand(buffer)
        }
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Redis fixture did not bind')
    const infoLog = jest.spyOn(logger, 'logInfo').mockImplementation(() => undefined)
    const errorLog = jest.spyOn(logger, 'logError').mockImplementation(() => undefined)
    const warningLog = jest.spyOn(logger, 'logWarn').mockImplementation(() => undefined)
    const context = await createRedisContext(`redis://127.0.0.1:${address.port}`)
    const startedAt = Date.now()

    try {
      const online = await context.presenceStore.isOnline('receiver-1')
      const elapsed = Date.now() - startedAt
      await actualPresenceRead
      await presenceReadReleased

      expect(online).toBe(false)
      expect(elapsed).toBeGreaterThanOrEqual(4500)
      expect(elapsed).toBeLessThan(6000)
      expect(errorLog).toHaveBeenCalledWith(
        '[PresenceStore:redis] isOnline error — assuming offline',
        expect.any(Error),
      )
    } finally {
      await context.shutdown()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
      const warningDeadline = Date.now() + 250
      while (warningLog.mock.calls.length < 3 && Date.now() < warningDeadline) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(infoLog).toHaveBeenCalledWith('[RedisService] Redis clients closed')
      expect(warningLog).toHaveBeenCalledWith('[RedisService] client presence closed')
      expect(warningLog).toHaveBeenCalledWith('[RedisService] client sub closed')
      expect(warningLog).toHaveBeenCalledWith('[RedisService] client pub closed')
      infoLog.mockRestore()
      errorLog.mockRestore()
      warningLog.mockRestore()
    }
  }, 12_000)
})
