process.env.NODE_ENV = 'production'
export {}

const {
  assertMessageIntegrationDatabaseIdentity,
  requireMessageIntegrationDatabase,
} = require('./messageIntegrationDatabase') as typeof import('./messageIntegrationDatabase')
const integrationDatabase = requireMessageIntegrationDatabase(process.env)
process.env.DATABASE_URL = integrationDatabase.url

const { randomUUID } = require('node:crypto') as typeof import('node:crypto')
const { AppDataSource } = require('../../src/database') as typeof import('../../src/database')
const { OutboxEvent, OutboxEventState } = require('../../src/database/models/OutboxEventModel') as typeof import('../../src/database/models/OutboxEventModel')
const { OutboxWorker } = require('../../src/services/OutboxWorker') as typeof import('../../src/services/OutboxWorker')
const typeImports = {} as {
  payload: import('../../src/types').MessageReceivedEventPayload
  notification: import('../../src/types').NotificationPayload
}
void typeImports

function payload(eventId: string): import('../../src/types').MessageReceivedEventPayload {
  return {
    type: 'MESSAGE_RECEIVED',
    eventId,
    senderId: '10000000-0000-0000-0000-000000000001',
    userId: '20000000-0000-0000-0000-000000000002',
    message: '[Encrypted message]',
    from: 'sender@example.test',
    fromName: 'Sender Name',
    isEncrypted: true,
    envelope: '{"__encrypted":true,"body":"ciphertext+/="}',
  }
}

async function insertEvent(overrides: Partial<InstanceType<typeof OutboxEvent>> = {}): Promise<string> {
  const id = overrides.id ?? randomUUID()
  await AppDataSource.getRepository(OutboxEvent).insert({
    id,
    payload: payload(id),
    ...overrides,
  })
  return id
}

async function row(id: string): Promise<Record<string, any>> {
  const [value] = await AppDataSource.query('SELECT * FROM "outbox_events" WHERE "id" = $1', [id])
  return value
}

const passThrough = async (
  value: import('../../src/types').MessageReceivedEventPayload,
): Promise<import('../../src/types').NotificationPayload> => value

describe('OutboxWorker live PostgreSQL claims and lease fencing', () => {
  beforeAll(async () => {
    await AppDataSource.initialize()
    const [identity] = await AppDataSource.query(`
      SELECT current_database() AS database, current_user AS user,
             inet_server_addr()::text AS address, inet_server_port() AS port
    `)
    assertMessageIntegrationDatabaseIdentity(integrationDatabase, identity)
    await AppDataSource.runMigrations({ transaction: 'each' })
  })

  beforeEach(async () => {
    await AppDataSource.query('TRUNCATE TABLE "outbox_events"')
  })

  afterAll(async () => {
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
  })

  it('commits a claim before I/O and publishes the preserved event identity with retry-time enrichment', async () => {
    const id = await insertEvent()
    const publishNotification = jest.fn(async () => undefined)
    const enrich = jest.fn(async (canonical: import('../../src/types').MessageReceivedEventPayload) => {
      expect(await row(id)).toMatchObject({
        state: OutboxEventState.Leased,
        attempts: 1,
        leaseToken: expect.any(String),
      })
      return {
        ...canonical,
        recipientOnline: true,
        userEmail: 'receiver@example.test',
      }
    })
    const worker = new OutboxWorker(AppDataSource, { publishNotification }, enrich)

    await worker.runOnce()

    expect(enrich).toHaveBeenCalledWith(payload(id))
    expect(publishNotification).toHaveBeenCalledWith({
      ...payload(id),
      recipientOnline: true,
      userEmail: 'receiver@example.test',
    }, id)
    expect(await row(id)).toMatchObject({
      state: OutboxEventState.Published,
      attempts: 1,
      lockedAt: null,
      leaseToken: null,
      lastError: null,
    })
  })

  it('gives concurrent workers disjoint bounded batches', async () => {
    const ids = await Promise.all(Array.from({ length: 12 }, () => insertEvent()))
    const published: string[] = []
    const publisher = {
      publishNotification: jest.fn(async (_payload: unknown, eventId: string) => {
        published.push(eventId)
        await new Promise(resolve => setTimeout(resolve, 5))
      }),
    }
    const first = new OutboxWorker(AppDataSource, publisher, passThrough)
    const second = new OutboxWorker(AppDataSource, publisher, passThrough)

    await Promise.all([first.runOnce(), second.runOnce()])

    expect(published).toHaveLength(12)
    expect(new Set(published)).toEqual(new Set(ids))
    const [{ count }] = await AppDataSource.query(
      'SELECT COUNT(*)::integer AS count FROM "outbox_events" WHERE "state" = $1',
      [OutboxEventState.Published],
    )
    expect(count).toBe(12)
  })

  it('skips a row locked by another transaction and reclaims a stale lease', async () => {
    const lockedId = await insertEvent()
    const staleId = await insertEvent({
      state: OutboxEventState.Leased,
      lockedAt: new Date(Date.now() - 60_000),
      leaseToken: randomUUID(),
    })
    const queryRunner = AppDataSource.createQueryRunner()
    await queryRunner.connect()
    await queryRunner.startTransaction()
    await queryRunner.query('SELECT "id" FROM "outbox_events" WHERE "id" = $1 FOR UPDATE', [lockedId])
    const publishNotification = jest.fn(async () => undefined)

    try {
      await new OutboxWorker(AppDataSource, { publishNotification }, passThrough).runOnce()
    } finally {
      await queryRunner.rollbackTransaction()
      await queryRunner.release()
    }

    expect(publishNotification).toHaveBeenCalledTimes(1)
    expect(publishNotification).toHaveBeenCalledWith(payload(staleId), staleId)
    expect(await row(lockedId)).toMatchObject({ state: OutboxEventState.Pending, attempts: 0 })
    expect(await row(staleId)).toMatchObject({ state: OutboxEventState.Published, attempts: 1 })
  })

  it.each(['success', 'failure'])('fences a late old-lease %s after another worker reclaims it', async outcome => {
    const id = await insertEvent()
    let settle!: () => void
    let started!: () => void
    const publishing = new Promise<void>((resolve, reject) => {
      settle = () => outcome === 'success' ? resolve() : reject(new Error('late failure'))
    })
    const publishStarted = new Promise<void>(resolve => { started = resolve })
    const worker = new OutboxWorker(AppDataSource, {
      publishNotification: jest.fn(async () => {
        started()
        return publishing
      }),
    }, passThrough)

    const run = worker.runOnce()
    await publishStarted
    const newLease = randomUUID()
    await AppDataSource.query(`
      UPDATE "outbox_events"
      SET "state" = $1, "leaseToken" = $2, "lockedAt" = NOW(), "attempts" = 7
      WHERE "id" = $3
    `, [OutboxEventState.Leased, newLease, id])
    settle()
    await run

    expect(await row(id)).toMatchObject({
      state: OutboxEventState.Leased,
      leaseToken: newLease,
      attempts: 7,
      lastError: null,
    })
  })

  it('retains failed work with bounded retry metadata instead of leaking the broker error', async () => {
    const id = await insertEvent()
    const before = Date.now()
    const worker = new OutboxWorker(AppDataSource, {
      publishNotification: jest.fn(async () => {
        throw new Error('amqps://user:secret@broker.invalid/vhost')
      }),
    }, passThrough)

    await worker.runOnce()

    const failed = await row(id)
    expect(failed).toMatchObject({
      state: OutboxEventState.Pending,
      attempts: 1,
      lockedAt: null,
      leaseToken: null,
      lastError: 'Notification publish failed',
    })
    expect(new Date(failed.availableAt).getTime()).toBeGreaterThanOrEqual(before + 900)
    expect(new Date(failed.availableAt).getTime()).toBeLessThanOrEqual(before + 60_000)
  })
})
