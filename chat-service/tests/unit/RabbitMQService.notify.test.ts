// uuid ships ESM which ts-jest doesn't transform; stub it for this unit test.
jest.mock('uuid', () => ({ v4: () => 'fixed-correlation-id' }))

import { rabbitMQService } from '../../src/services/RabbitMQService'

describe('RabbitMQService.notifyReceiver', () => {
  afterEach(() => jest.restoreAllMocks())

  it('includes the resolved recipient email and publishes persistently', async () => {
    const channel = { sendToQueue: jest.fn() }
    ;(rabbitMQService as any).channel = channel

    await rabbitMQService.notifyReceiver(
      'receiver-1',
      '[Encrypted message]',
      'sender@example.com',
      'Sender',
      true,
      '{"__encrypted":true,"body":"x"}',
      'receiver@example.com',
    )

    expect(channel.sendToQueue).toHaveBeenCalledTimes(1)
    const [queue, buf, opts] = channel.sendToQueue.mock.calls[0]
    expect(queue).toBe('NOTIFICATIONS')
    const payload = JSON.parse(buf.toString())
    expect(payload.userEmail).toBe('receiver@example.com')
    expect(payload.userId).toBe('receiver-1')
    expect(payload.isEncrypted).toBe(true)
    expect(opts).toEqual({ persistent: true })
  })

  it('omits userEmail when none could be resolved (graceful degrade)', async () => {
    const channel = { sendToQueue: jest.fn() }
    ;(rabbitMQService as any).channel = channel

    await rabbitMQService.notifyReceiver('receiver-1', '[Encrypted message]', 's@x', 'S', true)

    const payload = JSON.parse(channel.sendToQueue.mock.calls[0][1].toString())
    expect(payload.userEmail).toBeUndefined()
  })
})

describe('RabbitMQService.getUserDetails RPC', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('sets replyTo so the user-service reply reaches us', () => {
    const channel = { sendToQueue: jest.fn() }
    ;(rabbitMQService as any).channel = channel

    rabbitMQService.getUserDetails('user-9', () => {})

    const [queue, , opts] = channel.sendToQueue.mock.calls[0]
    expect(queue).toBe('USER_DETAILS_REQUEST')
    expect(opts.replyTo).toBe('USER_DETAILS_RESPONSE')
    expect(typeof opts.correlationId).toBe('string')
  })
})
