process.env.NODE_ENV = 'production'
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_which_is_long_enough_32_chars'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL must point to the isolated Task 5 PostgreSQL database')

const { DataSource } = require('typeorm') as typeof import('typeorm')
const { AppDataSource } = require('../../src/database') as typeof import('../../src/database')
const { InitialSchema1733150000000 } = require('../../src/database/migrations/1733150000000-InitialSchema') as typeof import('../../src/database/migrations/1733150000000-InitialSchema')
const { PrekeyMutationService } = require('../../src/services/PrekeyMutationService') as typeof import('../../src/services/PrekeyMutationService')

const constraintName = 'IDX_prekeys_user_device'
const published = (tag: string, preKeys = [{ id: 1, publicKey: `pk-${tag}` }]) => ({
  identityKey: `identity-${tag}`,
  registrationId: tag.length,
  signedPreKey: { id: tag.length, publicKey: `signed-${tag}`, signature: `signature-${tag}` },
  preKeys,
})
const backup = (tag: string) => ({
  encrypted: `encrypted-${tag}`,
  iv: `iv-${tag}`,
  salt: `salt-${tag}`,
  version: 1,
  deviceId: 'device-1',
})

type Seed = {
  id: string
  userId?: string
  deviceId?: string
  bundle: unknown
  lastBackupTimestamp?: string | null
  createdAt?: string
  updatedAt?: string
}

async function resetToLegacySchema(): Promise<void> {
  await AppDataSource.query('DROP SCHEMA public CASCADE')
  await AppDataSource.query('CREATE SCHEMA public')
  await AppDataSource.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"')

  const legacy = new DataSource({
    type: 'postgres',
    url: databaseUrl,
    migrations: [InitialSchema1733150000000],
    migrationsTableName: 'typeorm_migrations_user',
  })
  await legacy.initialize()
  await legacy.runMigrations({ transaction: 'each' })
  await legacy.destroy()
}

async function seed(...values: Seed[]): Promise<void> {
  for (const value of values) {
    await AppDataSource.query(
      `INSERT INTO "prekeys"
        ("id", "userId", "deviceId", "bundle", "lastBackupTimestamp", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4::json, $5, $6, $7)`,
      [
        value.id,
        value.userId ?? 'user-1',
        value.deviceId ?? 'device-1',
        JSON.stringify(value.bundle),
        value.lastBackupTimestamp ?? null,
        value.createdAt ?? '2026-01-01T00:00:00.000Z',
        value.updatedAt ?? '2026-01-01T00:00:00.000Z',
      ],
    )
  }
}

async function rows(userId = 'user-1', deviceId = 'device-1'): Promise<any[]> {
  return AppDataSource.query(
    'SELECT * FROM "prekeys" WHERE "userId" = $1 AND "deviceId" = $2 ORDER BY "id"',
    [userId, deviceId],
  )
}

async function hasConstraint(): Promise<boolean> {
  const [{ exists }] = await AppDataSource.query(
    'SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1)',
    [constraintName],
  )
  return exists
}

async function backupTimestamp(userId = 'user-1'): Promise<string | null> {
  const [{ value }] = await AppDataSource.query(
    `SELECT to_char("lastBackupTimestamp", 'YYYY-MM-DD HH24:MI:SS.US') AS value
     FROM "prekeys" WHERE "userId" = $1 AND "deviceId" = 'device-1'`,
    [userId],
  )
  return value
}

async function migrate(): Promise<void> {
  await AppDataSource.runMigrations({ transaction: 'each' })
}

describe('prekey uniqueness migration', () => {
  beforeAll(async () => {
    await AppDataSource.initialize()
  })

  beforeEach(resetToLegacySchema)

  afterAll(async () => {
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
  })

  it('merges complementary duplicates, preserves unknown fields, and proves registered up/down/up behavior', async () => {
    const encrypted = backup('new')
    await seed(
      {
        id: '00000000-0000-0000-0000-000000000001',
        bundle: { ...published('published'), publishedOnly: { retained: true } },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
      {
        id: '00000000-0000-0000-0000-000000000002',
        bundle: { _encryptedKeyBundle: encrypted, backupOnly: 'retained' },
        lastBackupTimestamp: '2026-01-03T00:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-03T00:00:00.000Z',
      },
    )

    await migrate()

    let merged = await rows()
    expect(merged).toHaveLength(1)
    expect(merged[0].bundle).toEqual({
      ...published('published'),
      publishedOnly: { retained: true },
      backupOnly: 'retained',
      _encryptedKeyBundle: encrypted,
    })
    expect(await backupTimestamp()).toBe('2026-01-03 00:00:00.000000')
    expect(await hasConstraint()).toBe(true)
    await expect(seed({
      id: '00000000-0000-0000-0000-000000000003',
      bundle: published('rejected'),
    })).rejects.toThrow(/duplicate key|IDX_prekeys_user_device/)

    const bytesAfterUp = JSON.stringify(merged)
    await AppDataSource.undoLastMigration({ transaction: 'each' })
    expect(await hasConstraint()).toBe(false)
    expect(JSON.stringify(await rows())).toBe(bytesAfterUp)
    await seed({
      id: '00000000-0000-0000-0000-000000000003',
      bundle: { ...published('republished'), _encryptedKeyBundle: encrypted },
      updatedAt: '2026-01-04T00:00:00.000Z',
    })
    expect(await rows()).toHaveLength(2)

    await migrate()

    merged = await rows()
    expect(merged).toHaveLength(1)
    expect(await hasConstraint()).toBe(true)
  })

  it('selects complete published and encrypted halves from their distinct latest sources', async () => {
    await seed(
      {
        id: '00000000-0000-0000-0000-000000000010',
        bundle: { ...published('new-public'), _encryptedKeyBundle: backup('old-backup'), unknownA: true },
        lastBackupTimestamp: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-04T00:00:00.000Z',
      },
      {
        id: '00000000-0000-0000-0000-000000000011',
        bundle: { ...published('old-public'), _encryptedKeyBundle: backup('new-backup'), unknownB: true },
        lastBackupTimestamp: '2026-01-05T00:00:00.000Z',
        updatedAt: '2026-01-03T00:00:00.000Z',
      },
    )

    await migrate()

    const [merged] = await rows()
    expect(merged.bundle).toEqual({
      ...published('new-public'),
      _encryptedKeyBundle: backup('new-backup'),
      unknownA: true,
      unknownB: true,
    })
    expect(await backupTimestamp()).toBe('2026-01-05 00:00:00.000000')
  })

  it('keeps an empty preKeys array when it belongs to the latest complete published bundle', async () => {
    await seed(
      {
        id: '00000000-0000-0000-0000-000000000020',
        bundle: published('old'),
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
      {
        id: '00000000-0000-0000-0000-000000000021',
        bundle: published('new', []),
        updatedAt: '2026-01-03T00:00:00.000Z',
      },
    )

    await migrate()

    const [merged] = await rows()
    expect(merged.bundle).toEqual(published('new', []))
  })

  it('breaks equal timestamp ties by id without mixing nested bundle components', async () => {
    const tied = {
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
      lastBackupTimestamp: '2026-01-04T00:00:00.000Z',
    }
    await seed(
      {
        id: '00000000-0000-0000-0000-000000000030',
        bundle: { ...published('lower-id'), _encryptedKeyBundle: backup('lower-id') },
        ...tied,
      },
      {
        id: '00000000-0000-0000-0000-000000000031',
        bundle: { ...published('higher-id'), _encryptedKeyBundle: backup('higher-id') },
        ...tied,
      },
    )

    await migrate()

    const [merged] = await rows()
    expect(merged.id).toBe('00000000-0000-0000-0000-000000000031')
    expect(merged.bundle).toEqual({
      ...published('higher-id'),
      _encryptedKeyBundle: backup('higher-id'),
    })
  })

  it('rolls back all reconciliation when duplicate JSON is malformed', async () => {
    await seed(
      {
        id: '00000000-0000-0000-0000-000000000040',
        userId: 'a-valid-group',
        bundle: published('valid'),
      },
      {
        id: '00000000-0000-0000-0000-000000000041',
        userId: 'a-valid-group',
        bundle: { _encryptedKeyBundle: backup('valid') },
      },
      {
        id: '00000000-0000-0000-0000-000000000042',
        userId: 'z-malformed-group',
        bundle: published('valid'),
      },
      {
        id: '00000000-0000-0000-0000-000000000043',
        userId: 'z-malformed-group',
        bundle: { identityKey: 'partial' },
      },
    )
    const before = await AppDataSource.query('SELECT * FROM "prekeys" ORDER BY "id"')

    await expect(migrate()).rejects.toThrow(/malformed prekey bundle/i)

    expect(await AppDataSource.query('SELECT * FROM "prekeys" ORDER BY "id"')).toEqual(before)
    expect(await hasConstraint()).toBe(false)
  })

  it('preserves singleton rows byte-for-byte even when their legacy JSON shape is unsupported', async () => {
    await seed({
      id: '00000000-0000-0000-0000-000000000050',
      userId: 'singleton',
      bundle: ['legacy', 'shape'],
      lastBackupTimestamp: '2026-01-04T00:00:00.000Z',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
    })
    const before = await rows('singleton')

    await migrate()

    expect(await rows('singleton')).toEqual(before)
  })

  it('serializes concurrent publish and backup first writes through the real service after migration', async () => {
    await migrate()
    const now = new Date('2026-02-01T00:00:00.000Z')
    const service = new PrekeyMutationService()

    const [publishResult, backupResult] = await Promise.all([
      service.publish('concurrent-user', 'device-1', published('concurrent')),
      service.storeBackup('concurrent-user', 'device-1', backup('concurrent'), now),
    ])

    expect([publishResult.created, backupResult.created].sort()).toEqual([false, true])
    const result = await rows('concurrent-user')
    expect(result).toHaveLength(1)
    expect(result[0].bundle).toEqual({
      ...published('concurrent'),
      _encryptedKeyBundle: backup('concurrent'),
    })
    expect(result[0].lastBackupTimestamp.toISOString()).toBe(now.toISOString())
  })
})
