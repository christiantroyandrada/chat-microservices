process.env.NODE_ENV = 'production'
export {}

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
