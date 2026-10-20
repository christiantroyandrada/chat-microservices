import { start } from '../../src/server'

start().then(async server => {
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Runtime fixture has no TCP port')
  process.send?.({ port: address.port })
}).catch(() => { process.exitCode = 1 })
