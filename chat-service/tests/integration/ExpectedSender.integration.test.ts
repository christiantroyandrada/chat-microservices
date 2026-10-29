process.env.NODE_ENV = 'production'
export {}

jest.mock('../../src/services/RabbitMQService', () => ({ rabbitMQService: { getUserDetails: jest.fn(), isHealthy: () => false } }))

const url = process.env.CHAT_EXPECTED_SENDER_DATABASE_URL
if (url !== 'postgresql://task7@127.0.0.1:55447/task7_notification_20261022') throw new Error('Explicit Task8 isolated database required')
process.env.DATABASE_URL = url
process.env.JWT_SECRET = 'task8-local-fixture-secret-at-least-32-characters'

const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
const { randomUUID } = require('node:crypto') as typeof import('node:crypto')
const { DataSource } = require('typeorm') as typeof import('typeorm')
const jwt = require('jsonwebtoken') as typeof import('jsonwebtoken')
const { AppDataSource } = require('../../src/database') as typeof import('../../src/database')
const { rabbitMQService } = require('../../src/services/RabbitMQService') as typeof import('../../src/services/RabbitMQService')
const { clearUserDetailCache } = require('../../src/controllers/MessageController') as typeof import('../../src/controllers/MessageController')
const { default: app } = require('../../src/app') as typeof import('../../src/app')
const schema = `task8_sender_${randomUUID().replace(/-/g, '')}`
const admin = new DataSource({ type: 'postgres', url, installExtensions: false })
const senderId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const otherId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const receiverId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const envelope = ' \n{"__encrypted":true,"body":"retained-ciphertext+/="}\t '
let http: import('node:http').Server | undefined
let origin: string
let owned = false

async function guard() {
  expect(execFileSync('/opt/homebrew/bin/docker', ['context', 'show'], { encoding: 'utf8' }).trim()).toBe('colima')
  const [container] = JSON.parse(execFileSync('/opt/homebrew/bin/docker', ['--context', 'colima', 'inspect', 'task7a-20261022-postgres'], { encoding: 'utf8' }))
  expect(container.Config.Labels['chat.fixture']).toBe('task7a-20261022')
  expect(container.HostConfig.Tmpfs).toEqual({ '/var/lib/postgresql/data': 'rw' })
  expect(container.Mounts).toEqual([])
  expect(container.HostConfig.PortBindings).toEqual({ '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '55447' }] })
  const [identity] = await admin.query('SELECT current_database() AS database, current_user AS role, inet_server_port() AS port')
  expect(identity).toEqual({ database: 'task7_notification_20261022', role: 'task7', port: 5432 })
}

beforeAll(async () => {
  await admin.initialize()
  await guard()
  expect(await admin.query("SELECT extname FROM pg_extension WHERE extname = 'uuid-ossp'")).toHaveLength(1)
  await admin.query(`CREATE SCHEMA ${schema}`)
  owned = true
  AppDataSource.setOptions({ schema, installExtensions: false, extra: { options: `-c search_path=${schema},public`, connectionTimeoutMillis: 2000 } })
  await AppDataSource.initialize()
  expect((await AppDataSource.query('SELECT current_schema() AS schema'))[0]).toEqual({ schema })
  await guard()
  await AppDataSource.runMigrations({ transaction: 'each' })
  http = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => http!.once('listening', resolve))
  origin = 'http://127.0.0.1:' + (http.address() as import('node:net').AddressInfo).port
})
beforeEach(async () => { await guard(); await AppDataSource.query(`TRUNCATE ${schema}.outbox_events, ${schema}.messages`) })
beforeEach(() => {
  clearUserDetailCache()
  jest.mocked(rabbitMQService.getUserDetails).mockImplementation(async (_id, callback) => callback(null))
  jest.clearAllMocks()
})
afterEach(() => jest.restoreAllMocks())
afterAll(async () => {
  if (http) await new Promise<void>((resolve, reject) => http!.close(error => error ? reject(error) : resolve()))
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
  if (admin.isInitialized) {
    if (owned) { await guard(); await admin.query(`DROP SCHEMA ${schema} CASCADE`) }
    await admin.destroy()
  }
})

async function rest(body: Record<string, unknown>, user = senderId) {
  const response = await fetch(origin + '/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: 'jwt=' + jwt.sign({ id: user, username: 'Sender', email: 'sender@example.test' }, process.env.JWT_SECRET!) },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as any }
}

async function state() {
  return {
    messages: await AppDataSource.query(`SELECT * FROM ${schema}.messages ORDER BY id`),
    events: await AppDataSource.query(`SELECT * FROM ${schema}.outbox_events ORDER BY id`),
  }
}

async function request(path: string, user: string, method = 'GET') {
  const response = await fetch(origin + path, {
    method,
    headers: { cookie: 'jwt=' + jwt.sign({ id: user, username: 'Sender', email: 'sender@example.test' }, process.env.JWT_SECRET!) },
  })
  return { status: response.status, body: await response.json() as any }
}

const accountRoutes = [
  ['/conversations', 'GET'],
  ['/get/' + receiverId, 'GET'],
  ['/messages/read/' + receiverId, 'PUT'],
] as const

it.each(accountRoutes)('rejects account B for account A at %s before native repository or profile access even with empty results', async (path, method) => {
  const repository = jest.spyOn(AppDataSource, 'getRepository')
  const response = await request(path + '?expectedUserId=' + senderId, otherId, method)
  expect({ status: response.status, repositoryCalls: repository.mock.calls.length, profileCalls: jest.mocked(rabbitMQService.getUserDetails).mock.calls.length }).toEqual({ status: 403, repositoryCalls: 0, profileCalls: 0 })
})

it.each(accountRoutes.slice(0, 2))('rejects account B populated data at %s before native repository or profile access', async (path, method) => {
  expect((await rest({ receiverId: otherId, message: envelope }, receiverId)).status).toBe(200)
  const repository = jest.spyOn(AppDataSource, 'getRepository')
  const response = await request(path + '?expectedUserId=' + senderId, otherId, method)
  expect({ status: response.status, repositoryCalls: repository.mock.calls.length, profileCalls: jest.mocked(rabbitMQService.getUserDetails).mock.calls.length }).toEqual({ status: 403, repositoryCalls: 0, profileCalls: 0 })
})

it('preserves both accounts read states when account B cookie replaces account A before markAsRead', async () => {
  for (const target of [senderId, otherId]) expect((await rest({ receiverId: target, message: envelope }, receiverId)).status).toBe(200)
  const before = await state()
  const response = await request('/messages/read/' + receiverId + '?expectedUserId=' + senderId, otherId, 'PUT')
  expect({ status: response.status, ...await state() }).toEqual({ status: 403, ...before })
})

it.each(accountRoutes)('rejects malformed and repeated expectedUserId at %s without repository access', async (path, method) => {
  const repository = jest.spyOn(AppDataSource, 'getRepository')
  for (const query of ['expectedUserId=', 'expectedUserId=null', 'expectedUserId=invalid', 'expectedUserId=' + encodeURIComponent(' ' + senderId + ' '), 'expectedUserId=' + senderId + '&expectedUserId=' + senderId]) {
    const response = await request(path + '?' + query, senderId, method)
    expect({ status: response.status, repositoryCalls: repository.mock.calls.length }).toEqual({ status: 400, repositoryCalls: 0 })
  }
})

it.each([false, true])('accepts matching case-normalized account preconditions and legacy omission %p for GET and read mutation', async legacy => {
  for (const target of [senderId, otherId]) expect((await rest({ receiverId: target, message: envelope }, receiverId)).status).toBe(200)
  const query = legacy ? '' : '?expectedUserId=' + senderId.toUpperCase()
  const conversations = await request('/conversations' + query, senderId.toUpperCase())
  expect(conversations).toMatchObject({ status: 200, body: { data: [{ id: receiverId, unreadCount: 1 }] } })
  const history = await request('/get/' + receiverId.toUpperCase() + query, senderId.toUpperCase())
  expect(history).toMatchObject({ status: 200, body: { data: [{ senderId: receiverId, receiverId: senderId, message: envelope, status: 'NotDelivered' }] } })
  expect(await request('/messages/read/' + receiverId.toUpperCase() + query, senderId.toUpperCase(), 'PUT')).toMatchObject({ status: 200, body: { data: { modifiedCount: 1 } } })
  const stored = await state()
  expect(stored.messages.find((message: any) => message.receiverId === senderId).status).toBe('Seen')
  expect(stored.messages.find((message: any) => message.receiverId === otherId).status).toBe('NotDelivered')
})

it('rejects account B authentication for account A command with zero native messages and outbox events', async () => {
  const response = await rest({ expectedSenderId: senderId, receiverId, message: envelope, clientMessageId: randomUUID() }, otherId)
  expect({ status: response.status, ...await state() }).toEqual({ status: 403, messages: [], events: [] })
})

it('preserves account A stored command when account B repeats its pending envelope', async () => {
  const body = { expectedSenderId: senderId, receiverId, message: envelope, clientMessageId: randomUUID() }
  expect((await rest(body)).status).toBe(200)
  const before = await state()
  const response = await rest(body, otherId)
  expect({ status: response.status, ...await state() }).toEqual({ status: 403, ...before })
})

it('accepts canonical sender matches and replays exact bytes under authentication without trusting a supplied senderId', async () => {
  const body = { expectedSenderId: senderId.toUpperCase(), senderId: otherId, receiverId, message: envelope, clientMessageId: randomUUID() }
  const first = await rest(body)
  const replay = await rest({ ...body, expectedSenderId: senderId }, senderId.toUpperCase())
  expect(first).toMatchObject({ status: 200, body: { data: { senderId, message: envelope } } })
  expect(replay).toEqual(first)
  const stored = await state()
  expect(stored.messages).toHaveLength(1)
  expect(stored.events).toHaveLength(1)
  expect(stored.events[0].payload).toMatchObject({ senderId, envelope })
})

it.each([null, [], [senderId], '', 7, 'not-a-uuid', ` ${senderId} `])('rejects malformed expectedSenderId %p without native writes', async expectedSenderId => {
  const response = await rest({ expectedSenderId, receiverId, message: envelope })
  expect({ status: response.status, ...await state() }).toEqual({ status: 400, messages: [], events: [] })
})

it('retains legacy sends when expectedSenderId is absent', async () => {
  expect((await rest({ receiverId, message: envelope }, otherId)).status).toBe(200)
  const stored = await state()
  expect(stored.messages).toHaveLength(1)
  expect(stored.messages[0].senderId).toBe(otherId)
  expect(stored.events).toHaveLength(1)
})
