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

const envelope = JSON.stringify({ __encrypted: true, body: 'ciphertext' })

async function resetToLegacySchema(): Promise<void> {
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
}

async function insertMessage(senderId: string, receiverId: string, clientMessageId?: string): Promise<void> {
  if (clientMessageId === undefined) {
    await AppDataSource.query(
      `INSERT INTO "messages" ("id", "senderId", "receiverId", "message", "isEncrypted", "status")
       VALUES ($1, $2, $3, $4, true, 'NotDelivered')`,
      [randomUUID(), senderId, receiverId, envelope],
    )
    return
  }

  await AppDataSource.query(
    `INSERT INTO "messages" ("id", "senderId", "receiverId", "message", "isEncrypted", "status", "clientMessageId")
     VALUES ($1, $2, $3, $4, true, 'NotDelivered', $5)`,
    [randomUUID(), senderId, receiverId, envelope, clientMessageId],
  )
}

async function hasColumn(table: string, column: string): Promise<boolean> {
  const [{ exists }] = await AppDataSource.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2
     )`,
    [table, column],
  )
  return exists
}

async function hasTable(table: string): Promise<boolean> {
  const [{ exists }] = await AppDataSource.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name = $1
     )`,
    [table],
  )
  return exists
}

describe('message idempotency and outbox migration', () => {
  beforeAll(async () => {
    await AppDataSource.initialize()
    const [identity] = await AppDataSource.query(`
      SELECT current_database() AS database, current_user AS user,
             inet_server_addr()::text AS address, inet_server_port() AS port
    `)
    assertMessageIntegrationDatabaseIdentity(integrationDatabase, identity)
  })

  beforeEach(resetToLegacySchema)

  afterAll(async () => {
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
  })

  it('measures duplicate acceptance in the real legacy schema before the additive migration', async () => {
    await insertMessage('sender-legacy', 'receiver-legacy')
    await insertMessage('sender-legacy', 'receiver-legacy')

    const [{ count }] = await AppDataSource.query('SELECT COUNT(*)::integer AS count FROM "messages"')
    expect(count).toBe(2)
  })

  it('runs the registered migration up/down/up and enforces sender-scoped keyed uniqueness', async () => {
    await AppDataSource.runMigrations({ transaction: 'each' })

    expect(await hasColumn('messages', 'clientMessageId')).toBe(true)
    expect(await hasTable('outbox_events')).toBe(true)

    const key = randomUUID()
    await insertMessage('sender-a', 'receiver-a', key)
    await expect(insertMessage('sender-a', 'receiver-a', key)).rejects.toThrow(/duplicate key|IDX_messages_sender_client_message/)
    await insertMessage('sender-b', 'receiver-a', key)
    await insertMessage('sender-a', 'receiver-a')
    await insertMessage('sender-a', 'receiver-a')

    await AppDataSource.undoLastMigration({ transaction: 'each' })
    expect(await hasColumn('messages', 'clientMessageId')).toBe(false)
    expect(await hasTable('outbox_events')).toBe(false)
    const [{ count }] = await AppDataSource.query('SELECT COUNT(*)::integer AS count FROM "messages"')
    expect(count).toBe(4)

    await AppDataSource.runMigrations({ transaction: 'each' })
    expect(await hasColumn('messages', 'clientMessageId')).toBe(true)
    expect(await hasTable('outbox_events')).toBe(true)
  })
})
