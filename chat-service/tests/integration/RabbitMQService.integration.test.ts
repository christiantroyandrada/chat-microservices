process.env.NODE_ENV = 'production'
export {}

const { createServer } = require('node:net') as typeof import('node:net')
const amqp = require('amqplib') as typeof import('amqplib')
const { requireMessageIntegrationBroker } = require('./messageIntegrationBroker') as typeof import('./messageIntegrationBroker')
const brokerUrl = requireMessageIntegrationBroker(process.env)
const { RabbitMQService } = require('../../src/services/RabbitMQService') as typeof import('../../src/services/RabbitMQService')

const payload = {
  type: 'MESSAGE_RECEIVED' as const,
  eventId: '11111111-1111-4111-8111-111111111111',
  senderId: 'sender-1',
  userId: 'receiver-1',
  message: '[Encrypted message]',
  from: 'sender@example.test',
  fromName: 'Sender',
  isEncrypted: true as const,
  envelope: '{"__encrypted":true,"body":"ciphertext"}',
}

async function waitFor(check: () => boolean, deadlineMs = 5000): Promise<void> {
  const deadline = Date.now() + deadlineMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('condition timed out')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

describe('RabbitMQService isolated live broker', () => {
  let service: InstanceType<typeof RabbitMQService>
  let observerConnection: import('amqplib').ChannelModel
  let observer: import('amqplib').Channel

  beforeEach(async () => {
    observerConnection = await amqp.connect(brokerUrl, { timeout: 2000 })
    observer = await observerConnection.createChannel()
    await observer.assertQueue('NOTIFICATIONS', { durable: true })
    await observer.purgeQueue('NOTIFICATIONS')
    service = new RabbitMQService(brokerUrl)
    await service.connect()
  })

  afterEach(async () => {
    await service.disconnect()
    await observer.close().catch(() => undefined)
    await observerConnection.close().catch(() => undefined)
  })

  it('receives an actual broker confirm and preserves persistent event identity', async () => {
    await service.publishNotification(payload, payload.eventId)

    const message = await observer.get('NOTIFICATIONS', { noAck: true })
    expect(message).not.toBe(false)
    if (!message) throw new Error('notification missing')
    expect(JSON.parse(message.content.toString())).toEqual(payload)
    expect(message.properties.messageId).toBe(payload.eventId)
    expect(message.properties.deliveryMode).toBe(2)
  })

  it('reconnects after the live connection closes and confirms another publication', async () => {
    await (service as any).connection.close()
    await waitFor(() => service.isHealthy())

    await service.publishNotification(payload, payload.eventId)

    const message = await observer.get('NOTIFICATIONS', { noAck: true })
    expect(message).not.toBe(false)
    expect(service.isHealthy()).toBe(true)
  })
})

describe('RabbitMQService stalled TCP handshake cleanup', () => {
  it('uses the production connect deadline to close the accepted socket before the outer watchdog', async () => {
    let acceptedSocket: import('node:net').Socket | undefined
    let socketClosed!: () => void
    const actualSocketClose = new Promise<void>(resolve => { socketClosed = resolve })
    const server = createServer(socket => {
      acceptedSocket = socket
      socket.once('close', socketClosed)
      socket.resume()
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('TCP fixture did not bind')
    const service = new RabbitMQService(`amqp://127.0.0.1:${address.port}`)
    let watchdogFired = false
    const watchdog = setTimeout(() => {
      watchdogFired = true
      acceptedSocket?.destroy()
    }, 7000)

    try {
      await expect(service.connect()).rejects.toThrow('connect ETIMEDOUT')
      await service.disconnect()
      await actualSocketClose
      expect(watchdogFired).toBe(false)
      expect(acceptedSocket?.destroyed).toBe(true)
    } finally {
      clearTimeout(watchdog)
      await service.disconnect()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }, 10_000)
})
