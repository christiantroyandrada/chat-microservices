import { DataSource } from 'typeorm'
import { NotificationInbox, PermanentNotificationError } from '../../src/services/NotificationInbox'

jest.mock('../../src/database/connection', () => ({ AppDataSource: {} }))

const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const eventId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const transaction = jest.fn()
const inbox = new NotificationInbox({ transaction } as unknown as DataSource)

beforeEach(() => transaction.mockReset())

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
  transaction.mockResolvedValue('inserted')
  const payload = { type: 'USER_REGISTERED', userId, message: 'Welcome café 世界 😀', userEmail: '😀@fixture.invalid' }
  await expect(inbox.accept(payload)).resolves.toBe('inserted')
  await expect(inbox.accept({ ...payload, eventId: eventId.toUpperCase() }, eventId)).resolves.toBe('inserted')
  expect(transaction).toHaveBeenCalledTimes(2)
})
