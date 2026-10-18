jest.mock('../../src/services/RabbitMQService', () => ({
  RabbitMQService: class {},
  rabbitMQService: { publishNotification: jest.fn() },
}))
jest.mock('../../src/database/connection', () => ({ AppDataSource: {} }))
jest.mock('../../src/utils/messageHandler', () => ({
  enrichMessageReceivedPayload: jest.fn(),
}))

import { OutboxWorker } from '../../src/services/OutboxWorker'

function dataSourceWithQuery(query: jest.Mock) {
  const createQueryRunner = jest.fn(() => {
    let active = false
    return {
      manager: { query },
      connect: jest.fn(async () => ({ end: jest.fn(async () => undefined) })),
      startTransaction: jest.fn(async () => { active = true }),
      commitTransaction: jest.fn(async () => { active = false }),
      rollbackTransaction: jest.fn(async () => { active = false }),
      release: jest.fn(async () => undefined),
      get isTransactionActive() { return active },
    }
  })
  return { createQueryRunner }
}

describe('OutboxWorker lifecycle', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it('starts only one poll and stop removes the next timer', async () => {
    const query = jest.fn(async () => [])
    const dataSource = dataSourceWithQuery(query)
    const worker = new OutboxWorker(dataSource as any, { publishNotification: jest.fn() }, jest.fn())

    worker.start()
    worker.start()
    await jest.advanceTimersByTimeAsync(0)
    await worker.stop()
    await worker.stop()
    await jest.advanceTimersByTimeAsync(1000)

    expect(dataSource.createQueryRunner).toHaveBeenCalledTimes(1)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('joins an in-flight poll before stop resolves', async () => {
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const dataSource = dataSourceWithQuery(jest.fn(async () => []))
    dataSource.createQueryRunner.mockImplementationOnce(() => ({
      manager: { query: jest.fn(async () => []) },
      connect: jest.fn(async () => {
        await blocked
        return { end: jest.fn(async () => undefined) }
      }),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(async () => undefined),
      isTransactionActive: false,
    }))
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

  it('joins blocked siblings when another event database update rejects', async () => {
    const events = [
      { id: 'event-1', payload: { eventId: 'event-1' }, attempts: 0 },
      { id: 'event-2', payload: { eventId: 'event-2' }, attempts: 0 },
    ]
    const updateFailure = new Error('lease update failed')
    let firstFailed!: () => void
    const firstFailure = new Promise<void>(resolve => { firstFailed = resolve })
    let releaseSibling!: () => void
    const blockedSibling = new Promise<void>(resolve => { releaseSibling = resolve })
    const query = jest.fn(async (sql: string, parameters: unknown[] = []) => {
      if (sql.includes('FROM "outbox_events"')) return events
      if (sql.includes('"attempts" = "attempts" + 1')) return []
      if (parameters.includes('event-1')) {
        if (parameters[0] === 'pending') firstFailed()
        throw updateFailure
      }
      return []
    })
    const dataSource = dataSourceWithQuery(query)
    const publisher = {
      publishNotification: jest.fn(async (_payload: unknown, eventId: string) => {
        if (eventId === 'event-2') await blockedSibling
      }),
    }
    const worker = new OutboxWorker(dataSource as any, publisher, async value => value as any)

    let resultSettled = false
    const result = worker.runOnce()
      .catch(error => error)
      .finally(() => { resultSettled = true })
    await firstFailure
    for (let attempt = 0; attempt < 10; attempt++) await Promise.resolve()
    let stopped = false
    let stopError: unknown
    const stopping = worker.stop()
      .catch(error => { stopError = error })
      .finally(() => { stopped = true })
    for (let attempt = 0; attempt < 10; attempt++) await Promise.resolve()
    const resultSettledBeforeRelease = resultSettled
    const stoppedBeforeRelease = stopped
    releaseSibling()
    expect(await result).toBe(updateFailure)
    await stopping
    expect(resultSettledBeforeRelease).toBe(false)
    expect(stoppedBeforeRelease).toBe(false)
    expect(stopError).toBe(updateFailure)
    expect(stopped).toBe(true)
  })

  it('preserves the database work failure after rollback and release also fail', async () => {
    const workFailure = new Error('claim failed')
    const rollbackTransaction = jest.fn(async () => { throw new Error('rollback failed') })
    const release = jest.fn(async () => { throw new Error('release failed') })
    const dataSource = {
      createQueryRunner: jest.fn(() => ({
        manager: { query: jest.fn(async () => { throw workFailure }) },
        connect: jest.fn(async () => ({ end: jest.fn(async () => undefined) })),
        startTransaction: jest.fn(async () => undefined),
        commitTransaction: jest.fn(async () => undefined),
        rollbackTransaction,
        release,
        isTransactionActive: true,
      })),
    }
    const worker = new OutboxWorker(dataSource as any, { publishNotification: jest.fn() }, jest.fn())

    await expect(worker.runOnce()).rejects.toBe(workFailure)
    expect(rollbackTransaction).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
  })
})
