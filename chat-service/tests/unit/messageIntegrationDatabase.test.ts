import {
  assertMessageIntegrationDatabaseIdentity,
  requireMessageIntegrationDatabase,
} from '../integration/messageIntegrationDatabase'

describe('message integration database guard', () => {
  it('accepts only the dedicated loopback task database URL', () => {
    expect(requireMessageIntegrationDatabase({
      CHAT_INTEGRATION_DATABASE_URL: 'postgresql://task6a@127.0.0.1:55432/chat_task6_message_submission',
    })).toEqual({
      url: 'postgresql://task6a@127.0.0.1:55432/chat_task6_message_submission',
      database: 'chat_task6_message_submission',
      user: 'task6a',
    })
  })

  it.each([
    [undefined],
    ['postgresql://prod@127.0.0.1:5432/chat_task6_message_submission'],
    ['postgresql://task6a@db.internal:5432/chat_task6_message_submission'],
    ['postgresql://task6a:secret@127.0.0.1:5432/chat_task6_message_submission'],
    ['postgresql://task6a@127.0.0.1:5432/production'],
  ])('rejects unsafe fixture URLs before connection or DDL', (url) => {
    expect(() => requireMessageIntegrationDatabase({
      CHAT_INTEGRATION_DATABASE_URL: url,
    })).toThrow(/CHAT_INTEGRATION_DATABASE_URL/)
  })

  it('rejects a connected server whose identity does not match the guarded URL', () => {
    const expected = requireMessageIntegrationDatabase({
      CHAT_INTEGRATION_DATABASE_URL: 'postgresql://task6a@127.0.0.1:55432/chat_task6_message_submission',
    })
    expect(() => assertMessageIntegrationDatabaseIdentity(expected, {
      database: 'production', user: 'task6a', address: '172.16.0.2', port: 5432,
    })).toThrow('Chat integration database server identity mismatch')
  })
})
