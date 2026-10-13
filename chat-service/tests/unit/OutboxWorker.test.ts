jest.mock('../../src/services/RabbitMQService', () => ({
  RabbitMQService: class {},
  rabbitMQService: { publishNotification: jest.fn() },
}))
jest.mock('../../src/database/connection', () => ({ AppDataSource: {} }))
jest.mock('../../src/utils/messageHandler', () => ({
  enrichMessageReceivedPayload: jest.fn(),
}))

import { OutboxWorker } from '../../src/services/OutboxWorker'

describe('OutboxWorker lifecycle', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it('starts only one poll and stop removes the next timer', async () => {
    const query = jest.fn(async () => [])
    const dataSource = {
      transaction: jest.fn(async (work: (manager: { query: typeof query }) => Promise<unknown>) =>
        work({ query }),
      ),
    }
    const worker = new OutboxWorker(dataSource as any, { publishNotification: jest.fn() }, jest.fn())

    worker.start()
    worker.start()
    await jest.advanceTimersByTimeAsync(0)
    await worker.stop()
    await worker.stop()
    await jest.advanceTimersByTimeAsync(1000)

    expect(dataSource.transaction).toHaveBeenCalledTimes(1)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('joins an in-flight poll before stop resolves', async () => {
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const dataSource = {
      transaction: jest.fn(async () => {
        await blocked
        return []
      }),
    }
    const worker = new OutboxWorker(dataSource as any, { publishNotification: jest.fn() }, jest.fn())
    worker.start()
    await jest.advanceTimersByTimeAsync(0)

    let stopped = false
    const stopping = worker.stop().then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    release()
    await stopping
    expect(stopped).toBe(true)
    expect(jest.getTimerCount()).toBe(0)
  })
})
