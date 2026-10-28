import { DataSource } from 'typeorm'
import { NotificationInbox, PermanentNotificationError } from '../../src/services/NotificationInbox'

jest.mock('../../src/database/connection', () => ({ AppDataSource: {} }))

const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const eventId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const query = jest.fn()
const visibleInsert = jest.fn()
let active = false
const runner = {
  manager: { query, getRepository: jest.fn(() => ({ insert: visibleInsert })) },
  connect: jest.fn(async () => ({ end: jest.fn(async () => undefined) })),
  startTransaction: jest.fn(async () => { active = true }),
  commitTransaction: jest.fn(async () => { active = false }),
  rollbackTransaction: jest.fn(async () => { active = false }),
  release: jest.fn(async () => undefined),
  get isTransactionActive() { return active },
}
const transaction = jest.fn(() => runner)
const inbox = new NotificationInbox({ createQueryRunner: transaction } as unknown as DataSource)

beforeEach(() => {
  jest.clearAllMocks()
  active = false
  query.mockImplementation(async (sql: string) => sql.includes('INSERT INTO') ? [{ eventKey: 'fixture' }] : [])
})

test.each(['\u0000', '\ud800', '\udfff'])('rejects PostgreSQL-invalid Unicode %j before storage', async invalid => {
  for (const type of ['MESSAGE_RECEIVED', 'USER_REGISTERED']) {
    for (const field of ['userId', 'message', 'userEmail', 'userToken']) {
      await expect(inbox.accept({ type, userId, [field]: `before${invalid}after` })).rejects.toBeInstanceOf(PermanentNotificationError)
    }
  }
  for (const field of ['senderId', 'from', 'fromName', 'envelope']) {
    await expect(inbox.accept({ type: 'MESSAGE_RECEIVED', userId, [field]: invalid })).rejects.toBeInstanceOf(PermanentNotificationError)
  }
  expect(transaction).not.toHaveBeenCalled()
})

test.each(['MESSAGE_RECEIVED', 'USER_REGISTERED'])('validates every supplied ID for %s before storage', async type => {
  await expect(inbox.accept({ type, userId, eventId: 'bad' })).rejects.toBeInstanceOf(PermanentNotificationError)
  await expect(inbox.accept({ type, userId }, 'bad')).rejects.toBeInstanceOf(PermanentNotificationError)
  await expect(inbox.accept({ type, userId, eventId }, userId)).rejects.toBeInstanceOf(PermanentNotificationError)
  expect(transaction).not.toHaveBeenCalled()
})

test('accepts ordinary Unicode, valid surrogate pairs, and registrations with absent or matching IDs', async () => {
  const payload = { type: 'USER_REGISTERED', userId, message: 'Welcome café 世界 😀', userEmail: '😀@fixture.invalid' }
  await expect(inbox.accept(payload)).resolves.toBe('inserted')
  await expect(inbox.accept({ ...payload, eventId: eventId.toUpperCase() }, eventId)).resolves.toBe('inserted')
  expect(transaction).toHaveBeenCalledTimes(2)
  expect(runner.connect).toHaveBeenCalledTimes(2)
  expect(query).toHaveBeenCalledWith("SET LOCAL statement_timeout = '5000ms'")
  expect(visibleInsert).toHaveBeenCalledTimes(2)
  expect(runner.commitTransaction).toHaveBeenCalledTimes(2)
  expect(runner.release).toHaveBeenCalledTimes(2)
})

test('receipt failure retains primary error identity through rollback and release failures', async () => {
  const primary = new Error('fixture receipt failed')
  query.mockRejectedValueOnce(primary)
  runner.rollbackTransaction.mockRejectedValueOnce(new Error('fixture rollback failed'))
  runner.release.mockRejectedValueOnce(new Error('fixture release failed'))
  await expect(inbox.accept({ type: 'USER_REGISTERED', userId })).rejects.toBe(primary)
  expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1)
  expect(runner.release).toHaveBeenCalledTimes(1)
})
