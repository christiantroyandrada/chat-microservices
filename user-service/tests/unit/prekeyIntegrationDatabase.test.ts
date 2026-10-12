import {
  assertPrekeyIntegrationDatabaseIdentity,
  requirePrekeyIntegrationDatabase,
} from '../utils/prekeyIntegrationDatabase'

describe('prekey integration database safety', () => {
  it('refuses an inherited generic DATABASE_URL before any connection can be created', () => {
    expect(() => requirePrekeyIntegrationDatabase({
      DATABASE_URL: 'postgresql://production_admin@database.example.com/production',
    })).toThrow(/PREKEY_INTEGRATION_DATABASE_URL/)
  })

  it.each([
    ['remote host', 'postgresql://task5@database.example.com:5432/task5_prekey_review'],
    ['wrong user', 'postgresql://postgres@127.0.0.1:5432/task5_prekey_review'],
    ['wrong database', 'postgresql://task5@127.0.0.1:5432/production'],
    ['password-bearing URL', 'postgresql://task5:secret@127.0.0.1:5432/task5_prekey_review'],
  ])('refuses an unsafe dedicated fixture URL: %s', (_label, url) => {
    expect(() => requirePrekeyIntegrationDatabase({ PREKEY_INTEGRATION_DATABASE_URL: url })).toThrow(/unsafe/i)
  })

  it('accepts only the explicit loopback fixture user and database prefix', () => {
    expect(requirePrekeyIntegrationDatabase({
      PREKEY_INTEGRATION_DATABASE_URL: 'postgresql://task5@127.0.0.1:5432/task5_prekey_review',
    })).toEqual({
      url: 'postgresql://task5@127.0.0.1:5432/task5_prekey_review',
      database: 'task5_prekey_review',
      user: 'task5',
      hostname: '127.0.0.1',
    })
  })

  it('refuses a server identity that differs from the validated URL or is not private PostgreSQL', () => {
    const expected = requirePrekeyIntegrationDatabase({
      PREKEY_INTEGRATION_DATABASE_URL: 'postgresql://task5@127.0.0.1:5432/task5_prekey_review',
    })
    expect(() => assertPrekeyIntegrationDatabaseIdentity(expected, {
      database: 'production', user: 'task5', address: '10.0.0.2', port: 5432,
    })).toThrow(/identity/i)
    expect(() => assertPrekeyIntegrationDatabaseIdentity(expected, {
      database: 'task5_prekey_review', user: 'task5', address: '203.0.113.10', port: 5432,
    })).toThrow(/identity/i)
  })
})
