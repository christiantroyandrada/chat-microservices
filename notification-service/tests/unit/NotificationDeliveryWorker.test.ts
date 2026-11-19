import type { DataSource } from 'typeorm'
import { NotificationDeliveryWorker } from '../../src/services/NotificationDeliveryWorker'
import * as templates from '../../src/services/EmailTemplateService'

jest.mock('../../src/database/connection', () => ({ AppDataSource: {} }))
jest.mock('../../src/config/config', () => ({ __esModule: true, default: { EMAIL_FROM: 'sender@fixture.invalid' } }))
jest.mock('../../src/utils/logger', () => ({ logError: jest.fn(), logInfo: jest.fn() }))

function fixture(query: jest.Mock<Promise<unknown[]>, unknown[]> = jest.fn(async () => [])) {
  const createQueryRunner = jest.fn(() => {
    let active = false
    return {
      manager: { query }, connect: jest.fn(async () => ({ end: jest.fn(async () => undefined) })),
      startTransaction: jest.fn(async () => { active = true }), commitTransaction: jest.fn(async () => { active = false }),
      rollbackTransaction: jest.fn(async () => { active = false }), release: jest.fn(async () => undefined),
      get isTransactionActive() { return active },
    }
  })
  const dispatch = jest.fn()
  return { createQueryRunner, dispatch, worker: new NotificationDeliveryWorker({ createQueryRunner } as unknown as DataSource, { dispatch }) }
}

afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks() })

test.each([true, false])('reserves welcome email only when its template is available (%s)', async (available) => {
  if (!available) jest.spyOn(templates, 'loadTemplate').mockReturnValue('')
  const now = new Date()
  let emailAttempts = 0
  const query = jest.fn(async (statement: unknown) => {
    const sql = String(statement)
    if (sql.startsWith('SELECT "eventKey"')) return [{ eventKey: 'registration:fixture' }]
    if (sql.startsWith('SELECT * FROM notification_inbox')) {
      return [{
        canonical: { type: 'USER_REGISTERED' },
        advisory: { userEmail: 'recipient@fixture.invalid' },
        deliveryLockedAt: now,
        emailState: 'pending',
        emailAttempts,
        emailAvailableAt: now,
        pushState: 'skipped',
      }]
    }
    if (sql.startsWith('SELECT clock_timestamp()')) return [{ now }]
    if (sql.includes('"emailAttempts" = "emailAttempts" + 1')) emailAttempts++
    return []
  })
  const { worker, dispatch } = fixture(query)
  dispatch.mockResolvedValue({ status: 'sent', attempt: 'started' })

  await worker.runOnce()

  if (available) {
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'email',
      to: 'recipient@fixture.invalid',
      subject: 'Welcome to Secret',
      html: expect.stringContaining('Your account is ready.'),
    }))
  } else {
    expect(dispatch).not.toHaveBeenCalled()
    expect(query).toHaveBeenCalledWith(expect.stringContaining('UPDATE notification_inbox'), [
      'registration:fixture', expect.any(String), 'deferred', 'template_unavailable',
    ])
  }
})

test('singleflights manual runs, polls once every 500ms, and permanently stops', async () => {
  jest.useFakeTimers()
  const { worker, createQueryRunner } = fixture()
  expect((worker as any).isHealthy()).toBe(false)
  const first = worker.runOnce()
  expect(worker.runOnce()).toBe(first)
  await first
  worker.start(); worker.start()
  expect((worker as any).isHealthy()).toBe(true)
  await jest.advanceTimersByTimeAsync(0)
  expect(createQueryRunner).toHaveBeenCalledTimes(2)
  await jest.advanceTimersByTimeAsync(499)
  expect(createQueryRunner).toHaveBeenCalledTimes(2)
  await jest.advanceTimersByTimeAsync(1)
  expect(createQueryRunner).toHaveBeenCalledTimes(3)
  await worker.stop()
  expect((worker as any).isHealthy()).toBe(false)
  worker.start()
  await worker.runOnce()
  await jest.advanceTimersByTimeAsync(1000)
  expect(createQueryRunner).toHaveBeenCalledTimes(3)
  expect(jest.getTimerCount()).toBe(0)
})

test('stop before any claim prevents manual runs', async () => {
  const { worker, createQueryRunner } = fixture()
  await worker.stop()
  await worker.runOnce()
  expect(createQueryRunner).not.toHaveBeenCalled()
})

test('preserves the primary database error when rollback and release also fail', async () => {
  const primary = new Error('fixture primary failure')
  const { worker, createQueryRunner } = fixture(jest.fn(async () => { throw primary }))
  const runner = createQueryRunner()
  runner.rollbackTransaction.mockRejectedValue(new Error('fixture rollback failure'))
  runner.release.mockRejectedValue(new Error('fixture release failure'))
  createQueryRunner.mockReturnValue(runner)
  await expect(worker.runOnce()).rejects.toBe(primary)
  expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1)
  expect(runner.release).toHaveBeenCalledTimes(1)
})
