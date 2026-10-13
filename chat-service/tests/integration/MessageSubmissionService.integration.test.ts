process.env.NODE_ENV = 'production'
export {}

const {
  assertMessageIntegrationDatabaseIdentity,
  requireMessageIntegrationDatabase,
} = require('./messageIntegrationDatabase') as typeof import('./messageIntegrationDatabase')
const integrationDatabase = requireMessageIntegrationDatabase(process.env)
process.env.DATABASE_URL = integrationDatabase.url

const { randomUUID } = require('node:crypto') as typeof import('node:crypto')
const { DataSource } = require('typeorm') as typeof import('typeorm')
const { AppDataSource } = require('../../src/database') as typeof import('../../src/database')
const { InitialSchema1733150000000 } = require('../../src/database/migrations/1733150000000-InitialSchema') as typeof import('../../src/database/migrations/1733150000000-InitialSchema')
const { AddPerformanceIndexes1740000000000 } = require('../../src/database/migrations/1740000000000-AddPerformanceIndexes') as typeof import('../../src/database/migrations/1740000000000-AddPerformanceIndexes')
const { MessageSubmissionService } = require('../../src/services/MessageSubmissionService') as typeof import('../../src/services/MessageSubmissionService')

const senderId = '10000000-0000-0000-0000-000000000001'
const receiverId = '20000000-0000-0000-0000-000000000002'
const envelope = JSON.stringify({ __encrypted: true, body: 'ciphertext+/=' })

function command(overrides: Record<string, unknown> = {}) {
  return {
    senderId,
    receiverId,
    encryptedEnvelope: envelope,
    clientMessageId: randomUUID(),
    senderName: 'Sender Name',
    senderEmail: 'sender@example.test',
    ...overrides,
  }
}

async function resetDatabase(): Promise<void> {
  await AppDataSource.query('DROP SCHEMA public CASCADE')
  await AppDataSource.query('CREATE SCHEMA public')
  await AppDataSource.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"')

  const legacy = new DataSource({
    type: 'postgres',
    url: integrationDatabase.url,
    migrations: [InitialSchema1733150000000, AddPerformanceIndexes1740000000000],
    migrationsTableName: 'typeorm_migrations_chat',
  })
  await legacy.initialize()
  await legacy.runMigrations({ transaction: 'each' })
  await legacy.destroy()
  await AppDataSource.runMigrations({ transaction: 'each' })
}

async function counts(): Promise<{ messages: number; events: number }> {
  const [[messageCount], [eventCount]] = await Promise.all([
    AppDataSource.query('SELECT COUNT(*)::integer AS count FROM "messages"'),
    AppDataSource.query('SELECT COUNT(*)::integer AS count FROM "outbox_events"'),
  ])
  return { messages: messageCount.count, events: eventCount.count }
}

describe('MessageSubmissionService live PostgreSQL transaction', () => {
  let service: InstanceType<typeof MessageSubmissionService>

  beforeAll(async () => {
    await AppDataSource.initialize()
    const [identity] = await AppDataSource.query(`
      SELECT current_database() AS database, current_user AS user,
             inet_server_addr()::text AS address, inet_server_port() AS port
    `)
    assertMessageIntegrationDatabaseIdentity(integrationDatabase, identity)
    service = new MessageSubmissionService(AppDataSource)
  })

  beforeEach(resetDatabase)

  afterAll(async () => {
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
  })

  it('atomically stores one encrypted message and its stable pending event payload', async () => {
    const key = randomUUID()
    const submitted = command({ clientMessageId: key.toUpperCase() })

    const result = await service.submit(submitted)

    expect(result.replayed).toBe(false)
    expect(result.message).toMatchObject({
      senderId,
      receiverId,
      message: envelope,
      clientMessageId: key,
      isEncrypted: true,
      status: 'NotDelivered',
    })
    const [event] = await AppDataSource.query('SELECT * FROM "outbox_events"')
    expect(event).toMatchObject({ state: 'pending', attempts: 0, lockedAt: null, leaseToken: null, lastError: null })
    expect(event.payload).toEqual({
      type: 'MESSAGE_RECEIVED',
      eventId: event.id,
      senderId,
      userId: receiverId,
      message: '[Encrypted message]',
      from: 'sender@example.test',
      fromName: 'Sender Name',
      isEncrypted: true,
      envelope,
    })
    expect(await counts()).toEqual({ messages: 1, events: 1 })
  })

  it('returns the original row with current delivery state on exact keyed replay', async () => {
    const submitted = command()
    const first = await service.submit(submitted)
    await AppDataSource.query('UPDATE "messages" SET "status" = \'Delivered\' WHERE "id" = $1', [first.message.id])

    const replay = await service.submit({ ...submitted, senderName: 'Changed display name' })

    expect(replay).toMatchObject({ replayed: true, message: { id: first.message.id, status: 'Delivered' } })
    expect(await counts()).toEqual({ messages: 1, events: 1 })
  })

  it('preserves original envelope bytes for exact replay and conflicts on boundary-whitespace changes', async () => {
    const exactEnvelope = ` \n${envelope}\t `
    const submitted = command({ encryptedEnvelope: exactEnvelope })

    const first = await service.submit(submitted)
    const replay = await service.submit(submitted)

    expect(first.message.message).toBe(exactEnvelope)
    expect(replay).toMatchObject({ replayed: true, message: { id: first.message.id, message: exactEnvelope } })
    const [event] = await AppDataSource.query('SELECT "payload" FROM "outbox_events"')
    expect(event.payload.envelope).toBe(exactEnvelope)
    await expect(service.submit({ ...submitted, encryptedEnvelope: `${exactEnvelope} ` }))
      .rejects.toMatchObject({ statusCode: 409 })
    expect(await counts()).toEqual({ messages: 1, events: 1 })
  })

  it('rejects an oversized original envelope whose trimmed view is valid without writing', async () => {
    const oversized = `${' '.repeat(5001 - envelope.length)}${envelope}`

    await expect(service.submit(command({ encryptedEnvelope: oversized })))
      .rejects.toMatchObject({ statusCode: 400 })
    expect(await counts()).toEqual({ messages: 0, events: 0 })
  })

  it('serializes concurrent same-key submissions to one message and one event', async () => {
    const submitted = command()

    const results = await Promise.all(Array.from({ length: 8 }, () => service.submit(submitted)))

    expect(new Set(results.map((result: { message: { id: string } }) => result.message.id)).size).toBe(1)
    expect(results.filter((result: { replayed: boolean }) => !result.replayed)).toHaveLength(1)
    expect(await counts()).toEqual({ messages: 1, events: 1 })
  })

  it.each([
    ['recipient', { receiverId: '30000000-0000-0000-0000-000000000003' }],
    ['ciphertext', { encryptedEnvelope: JSON.stringify({ __encrypted: true, body: 'different' }) }],
  ])('rejects a same-key %s conflict without extra rows', async (_case, changed) => {
    const submitted = command()
    await service.submit(submitted)

    await expect(service.submit({ ...submitted, ...changed })).rejects.toMatchObject({ statusCode: 409 })
    expect(await counts()).toEqual({ messages: 1, events: 1 })
  })

  it('scopes a reused key to the sender and leaves unkeyed legacy submissions independent', async () => {
    const key = randomUUID()
    await service.submit(command({ clientMessageId: key }))
    await service.submit(command({ senderId: '40000000-0000-0000-0000-000000000004', clientMessageId: key }))
    await service.submit(command({ clientMessageId: undefined }))
    await service.submit(command({ clientMessageId: undefined }))

    expect(await counts()).toEqual({ messages: 4, events: 4 })
  })

  it('rolls back the message when the event insert fails', async () => {
    await AppDataSource.query(`
      CREATE FUNCTION fail_outbox_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected outbox failure'; END $$
    `)
    await AppDataSource.query(`
      CREATE TRIGGER fail_outbox_insert BEFORE INSERT ON "outbox_events"
      FOR EACH ROW EXECUTE FUNCTION fail_outbox_insert()
    `)

    await expect(service.submit(command())).rejects.toThrow('injected outbox failure')
    expect(await counts()).toEqual({ messages: 0, events: 0 })
  })

  it.each([
    ['null key', { clientMessageId: null }],
    ['empty key', { clientMessageId: '' }],
    ['non-string key', { clientMessageId: 7 }],
    ['malformed key', { clientMessageId: 'not-a-uuid' }],
    ['empty envelope', { encryptedEnvelope: '   ' }],
    ['plaintext', { encryptedEnvelope: 'hello' }],
    ['missing marker', { encryptedEnvelope: JSON.stringify({ body: 'ciphertext' }) }],
    ['null marker', { encryptedEnvelope: JSON.stringify({ __encrypted: null, body: 'ciphertext' }) }],
    ['missing body', { encryptedEnvelope: JSON.stringify({ __encrypted: true }) }],
    ['null body', { encryptedEnvelope: JSON.stringify({ __encrypted: true, body: null }) }],
    ['oversize envelope', { encryptedEnvelope: JSON.stringify({ __encrypted: true, body: 'x'.repeat(5000) }) }],
    ['same sender and receiver', { receiverId: senderId }],
  ])('rejects %s before any write', async (_case, changed) => {
    await expect(service.submit(command(changed))).rejects.toMatchObject({ statusCode: 400 })
    expect(await counts()).toEqual({ messages: 0, events: 0 })
  })
})
