import type { DataSource } from 'typeorm'
import { NotificationDeliveryWorker } from '../../src/services/NotificationDeliveryWorker'

jest.mock('../../src/database/connection', () => ({ AppDataSource: {} }))
jest.mock('../../src/config/config', () => ({ __esModule: true, default: { EMAIL_FROM: 'sender@fixture.invalid' } }))
jest.mock('../../src/utils/logger', () => ({ logError: jest.fn(), logInfo: jest.fn() }))

function fixture(query = jest.fn(async (..._args: unknown[]) => [])) {
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

test('singleflights manual runs, polls once every 500ms, and permanently stops', async () => {
  jest.useFakeTimers()
  const { worker, createQueryRunner } = fixture()
  const first = worker.runOnce()
  expect(worker.runOnce()).toBe(first)
  await first
  worker.start(); worker.start()
  await jest.advanceTimersByTimeAsync(0)
  expect(createQueryRunner).toHaveBeenCalledTimes(2)
  await jest.advanceTimersByTimeAsync(499)
  expect(createQueryRunner).toHaveBeenCalledTimes(2)
  await jest.advanceTimersByTimeAsync(1)
  expect(createQueryRunner).toHaveBeenCalledTimes(3)
  await worker.stop()
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
