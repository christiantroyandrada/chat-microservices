jest.mock('../../src/config/config', () => ({ __esModule: true, default: { msgBrokerURL: 'amqp://broker' } }))
jest.mock('../../src/database', () => ({ AppDataSource: { getRepository: jest.fn() }, User: {} }))
jest.mock('amqplib', () => ({ __esModule: true, default: { connect: jest.fn() } }))

import amqp from 'amqplib'
import { rabbitMQService } from '../../src/services/RabbitMQService'

const connect = amqp.connect as jest.Mock

describe('RabbitMQ recovery contract', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    connect.mockReset()
  })

  afterEach(async () => {
    await rabbitMQService.disconnect()
    jest.useRealTimers()
  })

  test('retries after an initial connection rejection without a fixed cap', async () => {
    connect.mockRejectedValueOnce(new Error('broker unavailable')).mockRejectedValue(new Error('still unavailable'))

    await expect(rabbitMQService.connect()).rejects.toThrow('broker unavailable')
    await jest.advanceTimersByTimeAsync(1000)

    expect(connect).toHaveBeenCalledTimes(2)
  })

  test('keeps notification backpressure best-effort after enqueue', async () => {
    const channel = { sendToQueue: jest.fn().mockReturnValue(false) }
    ;(rabbitMQService as any).channel = channel
    ;(rabbitMQService as any).connection = {}

    await expect(rabbitMQService.publishNotification({ kind: 'test' })).resolves.toBe(true)
  })
})
