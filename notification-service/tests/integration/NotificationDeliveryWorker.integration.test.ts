process.env.NODE_ENV = 'production'
import 'reflect-metadata'
import { requireNotificationIntegrationDatabase } from './notificationIntegrationDatabase'
import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { Notification } from '../../src/database/models/NotificationModel'
import { InitialSchema1733150000000 } from '../../src/database/migrations/1733150000000-InitialSchema'
import { AddNotificationInbox1792627200000 } from '../../src/database/migrations/1792627200000-AddNotificationInbox'
import { AddNotificationDelivery1792800000000 } from '../../src/database/migrations/1792800000000-AddNotificationDelivery'
import { NotificationInbox } from '../../src/services/NotificationInbox'
import { NotificationDeliveryWorker } from '../../src/services/NotificationDeliveryWorker'
import { NotificationProviderBoundaryError, ProviderResult } from '../../src/services/NotificationProvider'
import { loadTemplate } from '../../src/services/EmailTemplateService'

jest.mock('../../src/services/EmailTemplateService', () => ({ ...jest.requireActual('../../src/services/EmailTemplateService'), loadTemplate: jest.fn() }))
jest.mock('../../src/config/config', () => ({ __esModule: true, default: { EMAIL_FROM: 'sender@fixture.invalid' } }))
const fixture = requireNotificationIntegrationDatabase(process.env)
const { url } = fixture
const schema = `task7b_delivery_${randomUUID().replace(/-/g, '')}`
const admin = new DataSource({ type: 'postgres', url, installExtensions: false })
const database = new DataSource({ type: 'postgres', url, schema, installExtensions: false, entities: [Notification], extra: { options: `-c search_path=${schema},public`, connectionTimeoutMillis: 2000 } })
const inbox = new NotificationInbox(database)
const sent: ProviderResult = { status: 'sent', attempt: 'started' }
const template = '<h1>{{TITLE}}</h1><main>{{BODY}}</main><a href="{{APP_URL}}">app</a>{{YEAR}}{{EMAIL_FROM}}{{LOGO_DATA_URI}}'
const guard = () => fixture.assertIdentity(admin)
beforeAll(async () => {
  await admin.initialize(); await guard()
  await admin.query(`CREATE SCHEMA ${schema}`)
  await database.initialize()
  const runner = database.createQueryRunner()
  try {
    await new InitialSchema1733150000000().up(runner)
    await new AddNotificationInbox1792627200000().up(runner)
    await new AddNotificationDelivery1792800000000().up(runner)
  } finally { await runner.release() }
})
beforeEach(async () => {
  await guard()
  await database.query('TRUNCATE notification_inbox, notifications')
  ;(loadTemplate as jest.Mock).mockReturnValue(template)
})
afterEach(() => jest.restoreAllMocks())
afterAll(async () => {
  if (database.isInitialized) await database.destroy()
  if (admin.isInitialized) { await guard(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.destroy() }
})
async function seed(extra = {}, both = false) {
  const identity = randomUUID()
  const payload = { type: 'MESSAGE_RECEIVED', eventId: identity, userId: randomUUID(), message: 'fixture body', fromName: 'Sender', userEmail: `${identity}@fixture.invalid`, userToken: identity, ...extra }
  await inbox.accept(payload)
  const [row] = await database.query('SELECT * FROM notification_inbox WHERE "eventKey" = $1', [payload.type === 'USER_REGISTERED' ? `registration:${payload.userId}` : `event:${payload.eventId}`])
  if (!both) await database.query('UPDATE notification_inbox SET "pushState" = \'skipped\' WHERE "eventKey" = $1', [row.eventKey])
  return { ...row, payload }
}
async function row(key: string) { return (await database.query('SELECT * FROM notification_inbox WHERE "eventKey" = $1', [key]))[0] }
function worker(dispatch: jest.Mock = jest.fn(async (_request: unknown): Promise<ProviderResult> => sent)) { return { dispatch, worker: new NotificationDeliveryWorker(database, { dispatch }) } }
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
async function databaseNow() { return (await database.query('SELECT clock_timestamp() AS now'))[0].now.getTime() as number }

test('two workers claim disjoint batches of two without counting attempts and skip locked rows', async () => {
  const events = await Promise.all(Array.from({ length: 5 }, () => seed()))
  const locked = database.createQueryRunner()
  await locked.startTransaction()
  try {
    await locked.query('SELECT * FROM notification_inbox WHERE "eventKey" = $1 FOR UPDATE', [events[0].eventKey])
    const a = worker().worker as any, b = worker().worker as any
    const batches = await Promise.all([a.claimBatch(), b.claimBatch()])
    expect(batches.map(value => value.length)).toEqual([2, 2])
    const keys = batches.flat().map(value => value.eventKey)
    expect(new Set(keys).size).toBe(4)
    expect(keys).not.toContain(events[0].eventKey)
    for (const key of keys) expect(await row(key)).toMatchObject({ emailAttempts: 0, pushAttempts: 0 })
  } finally { await locked.rollbackTransaction(); await locked.release() }
})

test('dispatch observes committed attempt and renewed lease without a row lock; events overlap and providers remain sequential', async () => {
  const events = [await seed({}, true), await seed({}, true)]
  const emailGate = gate(), entered = gate()
  let active = 0, peak = 0, emails = 0
  const order: string[] = []
  const { worker: current, dispatch } = worker(jest.fn(async (request: any) => {
    const match = events.find(value => request.provider === 'email' ? value.payload.userEmail === request.to : value.payload.userToken === request.token)
    expect(match).toBeDefined()
    const rows = await database.query('SELECT * FROM notification_inbox WHERE "deliveryLeaseToken" IS NOT NULL')
    if (request.provider === 'email') {
      const owned = rows.find((value: any) => value.eventKey === match!.eventKey)
      expect(owned).toMatchObject({ emailAttempts: 1 })
      expect(owned.deliveryLockedAt.getTime()).toBeGreaterThan(await databaseNow() - 1000)
      active++; peak = Math.max(active, peak); if (++emails === 2) entered.release()
      const check = database.createQueryRunner(); await check.startTransaction()
      try { await check.query('SELECT * FROM notification_inbox WHERE "eventKey" = $1 FOR UPDATE NOWAIT', [match!.eventKey]) } finally { await check.rollbackTransaction(); await check.release() }
      await emailGate.promise
      active--
    } else expect(order).toContain(`email:${match!.eventKey}`)
    order.push(`${request.provider}:${match!.eventKey}`)
    return sent
  }))
  const claim = (current as any).claimBatch.bind(current)
  jest.spyOn(current as any, 'claimBatch').mockImplementation(async () => {
    const claimed = await claim()
    for (const value of claimed) await database.query(`UPDATE notification_inbox SET "deliveryLockedAt" = clock_timestamp() - interval '30 seconds' WHERE "eventKey" = $1`, [value.eventKey])
    return claimed
  })
  const pending = current.runOnce()
  await entered.promise
  expect(peak).toBe(2)
  expect(dispatch).toHaveBeenCalledTimes(2)
  emailGate.release(); await pending
  for (const value of events) expect(order.indexOf(`email:${value.eventKey}`)).toBeLessThan(order.indexOf(`push:${value.eventKey}`))
  for (const value of events) expect(await row(value.eventKey)).toMatchObject({ emailState: 'sent', pushState: 'sent', emailAttempts: 1, pushAttempts: 1, deliveryLeaseToken: null })
})

test('reclaims expired leases but leaves future and terminal providers untouched', async () => {
  const expired = await seed(), future = await seed(), terminal = await seed()
  await database.query('UPDATE notification_inbox SET "deliveryLeaseToken" = $2, "deliveryLockedAt" = clock_timestamp() - interval \'61 seconds\' WHERE "eventKey" = $1', [expired.eventKey, randomUUID()])
  await database.query('UPDATE notification_inbox SET "emailAvailableAt" = clock_timestamp() + interval \'1 hour\' WHERE "eventKey" = $1', [future.eventKey])
  await database.query('UPDATE notification_inbox SET "emailState" = \'sent\' WHERE "eventKey" = $1', [terminal.eventKey])
  const { worker: current, dispatch } = worker()
  await current.runOnce()
  expect(dispatch).toHaveBeenCalledTimes(1)
  expect(await row(expired.eventKey)).toMatchObject({ emailState: 'sent', emailAttempts: 1 })
  expect(await row(future.eventKey)).toMatchObject({ emailState: 'pending', emailAttempts: 0 })
  expect(await row(terminal.eventKey)).toMatchObject({ emailState: 'sent', emailAttempts: 0 })
})

test('refreshes advisory after claim and escapes HTML while preserving plain subject', async () => {
  const value = await seed({ fromName: '<sender>&\"\'', message: '<script>&\"\'' })
  const { worker: current, dispatch } = worker()
  const claim = (current as any).claimBatch.bind(current)
  jest.spyOn(current as any, 'claimBatch').mockImplementation(async () => {
    const events = await claim()
    await inbox.accept({ ...value.payload, userEmail: 'changed@fixture.invalid' })
    return events
  })
  await current.runOnce()
  expect(dispatch.mock.calls[0][0]).toMatchObject({ to: 'changed@fixture.invalid', subject: 'New message from <sender>&\"\'' })
  expect((dispatch.mock.calls[0][0] as any).html).toContain('&lt;script&gt;&amp;&quot;&#39;')
  expect((dispatch.mock.calls[0][0] as any).html).toContain('&lt;sender&gt;&amp;&quot;&#39;')
})

test.each(['future', 'sent', 'failed', 'skipped'])('rereads provider %s eligibility after claim', async changed => {
  const value = await seed()
  const { worker: current, dispatch } = worker()
  const claim = (current as any).claimBatch.bind(current)
  jest.spyOn(current as any, 'claimBatch').mockImplementation(async () => {
    const events = await claim()
    if (changed === 'future') await database.query(`UPDATE notification_inbox SET "emailAvailableAt" = clock_timestamp() + interval '1 hour' WHERE "eventKey" = $1`, [value.eventKey])
    else await database.query('UPDATE notification_inbox SET "emailState" = $2 WHERE "eventKey" = $1', [value.eventKey, changed])
    return events
  })
  await current.runOnce()
  expect(dispatch).not.toHaveBeenCalled()
  expect(await row(value.eventKey)).toMatchObject({ emailState: changed === 'future' ? 'pending' : changed, emailAttempts: 0, deliveryLeaseToken: null })
})

test('sends generic encrypted email and byte-exact encrypted push envelope', async () => {
  const envelope = ' {"__encrypted":true,"body":"fixture-cipher"} '
  await seed({ isEncrypted: true, envelope, message: '[Encrypted message]' }, true)
  const { worker: current, dispatch } = worker()
  await current.runOnce()
  expect((dispatch.mock.calls[0][0] as any).html).toContain('You have a new encrypted message. Open the app to view it.')
  expect((dispatch.mock.calls[0][0] as any).html).not.toContain('fixture-cipher')
  expect(dispatch.mock.calls[1][0]).toMatchObject({ provider: 'push', envelope, message: '[Encrypted message]' })
})

test('replay wakes only changed merged advisory on deferred providers and preserves delivery ownership', async () => {
  const value = await seed()
  const token = randomUUID()
  await database.query(`UPDATE notification_inbox SET "emailState" = 'deferred', "emailAttempts" = 3,
    "emailReason" = 'provider_disabled', "emailAvailableAt" = clock_timestamp() + interval '1 hour',
    "deliveryLeaseToken" = $2, "deliveryLockedAt" = clock_timestamp() WHERE "eventKey" = $1`, [value.eventKey, token])
  const before = await row(value.eventKey)
  await inbox.accept({ ...value.payload, userEmail: undefined })
  expect(await row(value.eventKey)).toEqual(before)
  await inbox.accept({ ...value.payload, userEmail: 'new@fixture.invalid' })
  const after = await row(value.eventKey)
  expect(after).toMatchObject({ emailState: 'deferred', emailAttempts: 3, emailReason: 'provider_disabled', deliveryLeaseToken: token,
    deliveryLockedAt: before.deliveryLockedAt, pushState: 'skipped', pushAvailableAt: before.pushAvailableAt })
  expect(after.emailAvailableAt.getTime()).toBeLessThanOrEqual(await databaseNow())
})

test.each([
  [{ userEmail: '' }, 'deferred', 'missing_destination'],
  [{ recipientOnline: true }, 'skipped', 'recipient_online'],
])('applies email policy without an attempt: %j', async (extra, state, reason) => {
  const value = await seed(extra)
  const { worker: current, dispatch } = worker()
  await current.runOnce()
  const after = await row(value.eventKey)
  expect(after).toMatchObject({ emailState: state, emailReason: reason, emailAttempts: 0, deliveryLeaseToken: null })
  if (state === 'deferred') expect(after.emailAvailableAt.getTime() - await databaseNow()).toBeGreaterThan(299000)
  expect(dispatch).not.toHaveBeenCalled()
})

test('welcome ignores online presence and always skips registration push', async () => {
  const value = await seed({ type: 'USER_REGISTERED', recipientOnline: true }, true)
  const { worker: current, dispatch } = worker()
  await current.runOnce()
  expect(dispatch).toHaveBeenCalledTimes(1)
  expect(dispatch.mock.calls[0][0]).toMatchObject({ provider: 'email', subject: 'Welcome to Chat App' })
  expect(await row(value.eventKey)).toMatchObject({ emailState: 'sent', pushState: 'skipped', pushReason: 'registration_push', pushAttempts: 0 })
})

test('missing push destination defers without an attempt', async () => {
  const value = await seed({ userToken: '' }, true)
  const { worker: current, dispatch } = worker()
  await current.runOnce()
  expect(dispatch).toHaveBeenCalledTimes(1)
  expect(await row(value.eventKey)).toMatchObject({ emailState: 'sent', pushState: 'deferred', pushAttempts: 0, pushReason: 'missing_destination' })
})

test.each([
  [undefined, 'deferred', 'template_unavailable'],
  ['x'.repeat(100001), 'failed', 'invalid_payload'],
])('does not reserve unavailable templates or invalid payloads', async (availableTemplate, state, reason) => {
  const value = await seed()
  ;(loadTemplate as jest.Mock).mockReturnValue(availableTemplate)
  const { worker: current, dispatch } = worker()
  await current.runOnce()
  expect(dispatch).not.toHaveBeenCalled()
  expect(await row(value.eventKey)).toMatchObject({ emailState: state, emailReason: reason, emailAttempts: 0 })
})

test.each([
  [1, 'retry', 1000], [2, 'retry', 2000], [7, 'retry', 60000], [8, 'failed', 0],
])('persists retry %i with bounded backoff and fails the eighth attempt', async (attempt, state, delay) => {
  const value = await seed()
  await database.query('UPDATE notification_inbox SET "emailAttempts" = $2 WHERE "eventKey" = $1', [value.eventKey, attempt - 1])
  const { worker: current } = worker(jest.fn(async (): Promise<ProviderResult> => ({ status: 'retry', attempt: 'unknown', reason: 'timeout' })))
  const before = await databaseNow()
  await current.runOnce()
  const after = await row(value.eventKey)
  expect(after).toMatchObject({ emailAttempts: attempt, emailState: state, emailReason: 'timeout' })
  if (delay) {
    expect(after.emailAvailableAt.getTime()).toBeGreaterThanOrEqual(before + delay)
    expect(after.emailAvailableAt.getTime()).toBeLessThanOrEqual(await databaseNow() + delay)
  }
})

test('fails an exhausted active provider without dispatch and preserves all terminal providers', async () => {
  const value = await seed({}, true)
  await database.query(`UPDATE notification_inbox SET "emailAttempts" = 8, "pushState" = 'failed', "pushReason" = 'provider_rejected' WHERE "eventKey" = $1`, [value.eventKey])
  const { worker: current, dispatch } = worker()
  await current.runOnce()
  expect(dispatch).not.toHaveBeenCalled()
  expect(await row(value.eventKey)).toMatchObject({ emailAttempts: 8, emailState: 'failed', emailReason: 'attempt_limit',
    pushAttempts: 0, pushState: 'failed', pushReason: 'provider_rejected' })
})

test.each(['sent', 'failed'] as const)('persists provider %s outcome', async status => {
  const value = await seed()
  const result: ProviderResult = status === 'sent' ? sent : { status, attempt: 'started', reason: 'invalid_destination' }
  const { worker: current } = worker(jest.fn(async () => result))
  await current.runOnce()
  expect(await row(value.eventKey)).toMatchObject({ emailAttempts: 1, emailState: status, emailReason: status === 'sent' ? null : 'invalid_destination' })
})

test.each([false, true])('verified deferred outcome refunds the attempt and respects advisory change: %s', async changed => {
  const value = await seed()
  const { worker: current } = worker(jest.fn(async (): Promise<ProviderResult> => {
    if (changed) await inbox.accept({ ...value.payload, userEmail: 'changed@fixture.invalid' })
    return { status: 'deferred', attempt: 'not_started', reason: 'provider_disabled' }
  }))
  await current.runOnce()
  const after = await row(value.eventKey)
  expect(after).toMatchObject({ emailState: 'deferred', emailAttempts: 0, emailReason: 'provider_disabled' })
  if (changed) expect(after.emailAvailableAt.getTime()).toBeLessThanOrEqual(await databaseNow())
  else expect(after.emailAvailableAt.getTime() - await databaseNow()).toBeGreaterThan(299000)
})

test.each(['token', 'expiry', 'state', 'attempt'] as const)('blocks stale results and refunds after changed %s', async changed => {
  const value = await seed()
  const current = worker().worker as any
  const [event] = await current.claimBatch()
  const reservation = await current.reserve(event, 'email')
  const updates = {
    token: '"deliveryLeaseToken" = $2', expiry: '"deliveryLockedAt" = clock_timestamp() - interval \'61 seconds\'',
    state: '"emailState" = \'sent\'', attempt: '"emailAttempts" = 2',
  }
  await database.query(`UPDATE notification_inbox SET ${updates[changed]} WHERE "eventKey" = $1`, changed === 'token' ? [value.eventKey, randomUUID()] : [value.eventKey])
  const before = await row(value.eventKey)
  expect(await current.complete(event, 'email', reservation, sent)).toBe(false)
  expect(await current.complete(event, 'email', reservation, { status: 'retry', attempt: 'unknown', reason: 'timeout' })).toBe(false)
  expect(await current.complete(event, 'email', reservation, { status: 'deferred', attempt: 'not_started', reason: 'provider_disabled' })).toBe(false)
  await current.refund(event, 'email', reservation)
  expect(await row(value.eventKey)).toEqual(before)
})

test('checks lease expiry after the row lock completes', async () => {
  const value = await seed()
  const current = worker().worker as any
  const [event] = await current.claimBatch()
  await database.query(`UPDATE notification_inbox SET "deliveryLockedAt" = clock_timestamp() - interval '59 seconds' WHERE "eventKey" = $1`, [value.eventKey])
  const holder = database.createQueryRunner()
  await holder.startTransaction()
  let pending: Promise<unknown> | undefined
  try {
    await holder.query('SELECT * FROM notification_inbox WHERE "eventKey" = $1 FOR UPDATE', [value.eventKey])
    pending = current.reserve(event, 'email')
    const deadline = Date.now() + 3000
    const waitFor = async (sql: string, parameters: unknown[] = []) => {
      while (!(await database.query(sql, parameters))[0].ready) {
        if (Date.now() >= deadline) throw new Error('fixture lock or expiry barrier timed out')
        await new Promise<void>(resolve => setImmediate(resolve))
      }
    }
    await waitFor(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock'
      AND query LIKE 'SELECT * FROM notification_inbox WHERE%') AS ready`)
    expect((await database.query(`SELECT "deliveryLockedAt" + interval '60 seconds' > clock_timestamp() AS valid
      FROM notification_inbox WHERE "eventKey" = $1`, [value.eventKey]))[0].valid).toBe(true)
    await waitFor(`SELECT "deliveryLockedAt" + interval '60 seconds' <= clock_timestamp() AS ready
      FROM notification_inbox WHERE "eventKey" = $1`, [value.eventKey])
    await holder.commitTransaction()
    expect(await pending).toBeUndefined()
  } finally {
    if (holder.isTransactionActive) await holder.rollbackTransaction()
    await holder.release()
    await pending
  }
  expect(await row(value.eventKey)).toMatchObject({ emailAttempts: 0 })
})

test('a committed reservation with a lost response leaves its lease and does not dispatch', async () => {
  const value = await seed()
  const { worker: current, dispatch } = worker()
  const createRunner = database.createQueryRunner.bind(database)
  let calls = 0
  jest.spyOn(database, 'createQueryRunner').mockImplementation(mode => {
    const runner = createRunner(mode)
    if (++calls === 2) {
      const commit = runner.commitTransaction.bind(runner)
      jest.spyOn(runner, 'commitTransaction').mockImplementationOnce(async () => {
        await commit()
        throw new Error('fixture lost reservation response')
      })
    }
    return runner
  })
  await expect(current.runOnce()).rejects.toThrow('fixture lost reservation response')
  expect(dispatch).not.toHaveBeenCalled()
  expect(await row(value.eventKey)).toMatchObject({ emailState: 'pending', emailAttempts: 1 })
  expect((await row(value.eventKey)).deliveryLeaseToken).not.toBeNull()
})

test('a committed result with a lost response preserves sent and leaves its lease', async () => {
  const value = await seed()
  const { worker: current, dispatch } = worker()
  const createRunner = database.createQueryRunner.bind(database)
  let calls = 0
  jest.spyOn(database, 'createQueryRunner').mockImplementation(mode => {
    const runner = createRunner(mode)
    if (++calls === 3) {
      const commit = runner.commitTransaction.bind(runner)
      jest.spyOn(runner, 'commitTransaction').mockImplementationOnce(async () => {
        await commit()
        throw new Error('fixture lost result response')
      })
    }
    return runner
  })
  await expect(current.runOnce()).rejects.toThrow('fixture lost result response')
  expect(dispatch).toHaveBeenCalledTimes(1)
  expect(await row(value.eventKey)).toMatchObject({ emailState: 'sent', emailAttempts: 1 })
  expect((await row(value.eventKey)).deliveryLeaseToken).not.toBeNull()
})

test('stop during claim joins it and releases unused leases without calls', async () => {
  const value = await seed()
  const { worker: current, dispatch } = worker()
  const claim = (current as any).claimBatch.bind(current)
  const claimed = gate(), release = gate()
  jest.spyOn(current as any, 'claimBatch').mockImplementation(async () => {
    const events = await claim()
    claimed.release(); await release.promise
    return events
  })
  const pending = current.runOnce()
  await claimed.promise
  let joined = false
  const stopping = current.stop().then(() => { joined = true })
  await Promise.resolve()
  expect(joined).toBe(false)
  release.release(); await Promise.all([pending, stopping])
  expect(dispatch).not.toHaveBeenCalled()
  expect(await row(value.eventKey)).toMatchObject({ emailAttempts: 0, deliveryLeaseToken: null })
})

test('stop after reservation refunds only its counter and preserves a concurrent replay wake', async () => {
  const value = await seed()
  await database.query(`UPDATE notification_inbox SET "emailState" = 'deferred', "emailReason" = 'provider_disabled' WHERE "eventKey" = $1`, [value.eventKey])
  const { worker: current, dispatch } = worker()
  const reserve = (current as any).reserve.bind(current)
  const reserved = gate(), release = gate()
  jest.spyOn(current as any, 'reserve').mockImplementation(async (...args: any[]) => {
    const reservation = await reserve(...args)
    reserved.release(); await release.promise
    return reservation
  })
  const pending = current.runOnce()
  await reserved.promise
  await inbox.accept({ ...value.payload, userEmail: 'changed@fixture.invalid' })
  const awakened = await row(value.eventKey)
  const stopping = current.stop()
  release.release(); await Promise.all([pending, stopping])
  expect(dispatch).not.toHaveBeenCalled()
  expect(await row(value.eventKey)).toMatchObject({ emailAttempts: 0, emailState: awakened.emailState, emailReason: awakened.emailReason,
    emailAvailableAt: awakened.emailAvailableAt, deliveryLeaseToken: null })
})

test('stop during dispatch joins all active siblings and prevents both push calls', async () => {
  const values = [await seed({}, true), await seed({}, true)]
  const started = gate(), first = gate(), second = gate()
  let calls = 0
  const { worker: current, dispatch } = worker(jest.fn(async (): Promise<ProviderResult> => {
    const own = ++calls
    if (calls === 2) started.release()
    await (own === 1 ? first.promise : second.promise)
    return sent
  }))
  const pending = current.runOnce()
  await started.promise
  let joined = false
  const stopping = current.stop().then(() => { joined = true })
  first.release()
  await row(values[0].eventKey)
  expect(joined).toBe(false)
  second.release(); await Promise.all([pending, stopping])
  expect(dispatch).toHaveBeenCalledTimes(2)
  for (const value of values) expect(await row(value.eventKey)).toMatchObject({ emailState: 'sent', pushState: 'pending', pushAttempts: 0, deliveryLeaseToken: null })
})

test('capacity refunds only the reserved attempt without changing state, date, reason or replay wake', async () => {
  const value = await seed()
  await database.query(`UPDATE notification_inbox SET "emailState" = 'deferred', "emailReason" = 'provider_disabled' WHERE "eventKey" = $1`, [value.eventKey])
  let awakened: any
  const { worker: current, dispatch } = worker(jest.fn(async (): Promise<ProviderResult> => {
    await inbox.accept({ ...value.payload, userEmail: 'changed@fixture.invalid' })
    awakened = await row(value.eventKey)
    throw new NotificationProviderBoundaryError('PROVIDER_CAPACITY')
  }))
  await current.runOnce()
  expect(dispatch).toHaveBeenCalledTimes(1)
  expect(await row(value.eventKey)).toMatchObject({ emailAttempts: 0, emailState: awakened.emailState, emailReason: awakened.emailReason,
    emailAvailableAt: awakened.emailAvailableAt, deliveryLeaseToken: null })
})

test('unconfirmed termination permanently stops new work and joins the active sibling', async () => {
  const values = [await seed({}, true), await seed({}, true)]
  const started = gate(), sibling = gate()
  let calls = 0
  const { worker: current, dispatch } = worker(jest.fn(async (): Promise<ProviderResult> => {
    const own = ++calls
    if (calls === 2) started.release()
    await started.promise
    if (own === 1) throw new NotificationProviderBoundaryError('PROVIDER_TERMINATION_UNCONFIRMED')
    await sibling.promise
    return sent
  }))
  current.start()
  expect(current.isHealthy()).toBe(true)
  let finished = false
  const pending = current.runOnce().finally(() => { finished = true })
  // Attach rejection handling before releasing the fatal callback.
  const result = pending.catch(error => error)
  await started.promise
  await row(values[0].eventKey)
  expect(finished).toBe(false)
  sibling.release()
  expect(await result).toMatchObject({ code: 'PROVIDER_TERMINATION_UNCONFIRMED' })
  expect(current.isHealthy()).toBe(false)
  await current.runOnce(); current.start()
  expect(current.isHealthy()).toBe(false)
  await current.stop()
  expect(dispatch).toHaveBeenCalledTimes(2)
  const rows = await Promise.all(values.map(value => row(value.eventKey)))
  expect(rows.filter(value => value.deliveryLeaseToken !== null)).toHaveLength(1)
  expect(rows.every(value => value.pushAttempts === 0)).toBe(true)
})

test.each(['START', 'COMMIT', 'ROLLBACK'] as const)('closes the acquired PostgreSQL socket when %s stalls', async stalledOperation => {
  const { createServer } = require('node:net') as typeof import('node:net')
  const { Client } = require('pg') as { Client: new (options: Record<string, unknown>) => any }
  let socket: import('node:net').Socket | undefined
  const queryStarted = gate(), socketClosed = gate()
  const server = createServer(accepted => {
    socket = accepted
    accepted.once('close', socketClosed.release)
    let buffer = Buffer.alloc(0), startupComplete = false
    accepted.on('data', chunk => {
      buffer = Buffer.concat([buffer, typeof chunk === 'string' ? Buffer.from(chunk) : chunk])
      if (!startupComplete) {
        if (buffer.length < 4 || buffer.length < buffer.readUInt32BE(0)) return
        buffer = buffer.subarray(buffer.readUInt32BE(0))
        startupComplete = true
        accepted.write(Buffer.from([
          0x52, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00,
          0x5a, 0x00, 0x00, 0x00, 0x05, 0x49,
        ]))
      }
      if (buffer[0] === 0x51) queryStarted.release()
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture PostgreSQL socket did not bind')
  const client = new Client({ host: '127.0.0.1', port: address.port, user: 'fixture', database: 'fixture' })
  client.on('error', () => undefined)
  await client.connect()
  const primary = new Error('fixture work failed')
  const runner: any = {
    isTransactionActive: false,
    manager: { query: jest.fn(async () => { if (stalledOperation === 'ROLLBACK') throw primary; return [] }) },
    connect: jest.fn(async () => client),
    startTransaction: jest.fn(async () => {
      runner.isTransactionActive = true
      if (stalledOperation === 'START') await client.query('START TRANSACTION')
    }),
    commitTransaction: jest.fn(async () => {
      if (stalledOperation === 'COMMIT') await client.query('COMMIT')
      runner.isTransactionActive = false
    }),
    rollbackTransaction: jest.fn(async () => {
      if (stalledOperation === 'ROLLBACK') await client.query('ROLLBACK')
      runner.isTransactionActive = false
    }),
    release: jest.fn(async () => undefined),
  }
  const dispatch = jest.fn()
  const current = new NotificationDeliveryWorker({ createQueryRunner: () => runner } as unknown as DataSource, { dispatch })
  let watchdogFired = false
  const watchdog = setTimeout(() => { watchdogFired = true; socket?.destroy() }, 7000)
  const startedAt = Date.now()
  try {
    const pending = current.runOnce().catch(error => error)
    await queryStarted.promise
    const stopping = current.stop().catch(error => error)
    const error = await pending
    expect(await stopping).toBe(error)
    await socketClosed.promise
    expect(error).toBeInstanceOf(Error)
    if (stalledOperation === 'ROLLBACK') expect(error).toBe(primary)
    else expect(error.message).toBe('Notification delivery database operation timed out')
    expect(Date.now() - startedAt).toBeLessThan(6500)
    expect(watchdogFired).toBe(false)
    expect(socket?.destroyed).toBe(true)
    expect(dispatch).not.toHaveBeenCalled()
    expect(runner.release).toHaveBeenCalledTimes(1)
  } finally {
    clearTimeout(watchdog)
    await current.stop().catch(() => undefined)
    await client.end().catch(() => undefined)
    socket?.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}, 10000)
