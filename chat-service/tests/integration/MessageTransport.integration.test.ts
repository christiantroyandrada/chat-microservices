process.env.NODE_ENV = 'production'
export {}

jest.mock('../../src/services/websocketRelay', () => ({ relayAcceptedMessage: jest.fn(), relayReceipt: jest.fn() }))

const { requireMessageIntegrationDatabase, assertMessageIntegrationDatabaseIdentity } = require('./messageIntegrationDatabase') as typeof import('./messageIntegrationDatabase')
const fixture = requireMessageIntegrationDatabase(process.env)
process.env.DATABASE_URL = fixture.url
process.env.JWT_SECRET = 'transport-fixture-secret-with-sufficient-length'
process.env.MESSAGE_BROKER_URL = process.env.CHAT_INTEGRATION_BROKER_URL

const { randomUUID } = require('node:crypto') as typeof import('node:crypto')
const jwt = require('jsonwebtoken') as typeof import('jsonwebtoken')
const { AppDataSource, Message } = require('../../src/database') as typeof import('../../src/database')
const { MessageSubmissionService } = require('../../src/services/MessageSubmissionService') as typeof import('../../src/services/MessageSubmissionService')
const { markMessageDelivered, markConversationSeen } = require('../../src/services/messageReceipts') as typeof import('../../src/services/messageReceipts')
const { relayAcceptedMessage, relayReceipt } = require('../../src/services/websocketRelay') as typeof import('../../src/services/websocketRelay')
const { default: app } = require('../../src/app') as typeof import('../../src/app')
const { chatMessagesSentTotal } = require('../../src/utils/metrics') as typeof import('../../src/utils/metrics')

const senderId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const receiverId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const foreignId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const envelope = ' \n' + JSON.stringify({ __encrypted: true, body: 'ciphertext+/=' }) + '\t '
const service = new MessageSubmissionService()
let http: import('node:http').Server
let origin: string

async function guard() {
  const [identity] = await AppDataSource.query('SELECT current_database() AS database, current_user AS user, inet_server_addr()::text AS address, inet_server_port() AS port')
  assertMessageIntegrationDatabaseIdentity(fixture, identity)
}

async function counts() {
  const [row] = await AppDataSource.query('SELECT (SELECT COUNT(*)::integer FROM messages) AS messages, (SELECT COUNT(*)::integer FROM outbox_events) AS events')
  return row
}

function command(overrides = {}) {
  return { senderId, receiverId, encryptedEnvelope: envelope, senderName: 'Sender', senderEmail: 'sender@example.test', ...overrides }
}

async function request(path: string, user = senderId, method = 'GET', body?: Record<string, unknown>) {
  const response = await fetch(origin + path, {
    method,
    headers: { 'content-type': 'application/json', cookie: 'jwt=' + jwt.sign({ id: user, username: 'Sender', email: 'sender@example.test' }, process.env.JWT_SECRET!) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as any }
}
const rest = (body: Record<string, unknown>, user = senderId) => request('/send', user, 'POST', body)

beforeAll(async () => {
  await AppDataSource.initialize()
  await guard()
  await AppDataSource.runMigrations({ transaction: 'each' })
  http = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => http.once('listening', resolve))
  origin = 'http://127.0.0.1:' + (http.address() as import('node:net').AddressInfo).port
})
beforeEach(async () => {
  await guard()
  await AppDataSource.query('TRUNCATE outbox_events, messages')
  jest.clearAllMocks()
})
afterAll(async () => {
  if (http) await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()))
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
})

it('accepts concurrent HTTP retries as one durable command with exact bytes, canonical UUIDs and one Go relay', async () => {
  const clientMessageId = randomUUID()
  const body = { expectedSenderId: senderId.toUpperCase(), senderId: foreignId, receiverId: receiverId.toUpperCase(), message: envelope, clientMessageId }
  const [first, retry] = await Promise.all([rest(body, senderId.toUpperCase()), rest(body)])
  expect(first).toMatchObject({ status: 200, body: { status: 200, data: { senderId, receiverId, message: envelope, clientMessageId } } })
  expect(retry).toEqual(first)
  expect(await counts()).toEqual({ messages: 1, events: 1 })
  expect(relayAcceptedMessage).toHaveBeenCalledTimes(1)
  expect(relayAcceptedMessage).toHaveBeenCalledWith(expect.objectContaining({ id: first.body.data.id, senderId, receiverId, message: envelope, clientMessageId }), 'Sender')
})

it('keeps an HTTP command reachable through uppercase URLs and retries its Seen state without recounting or relaying again', async () => {
  const total = async () => (await chatMessagesSentTotal.get()).values.reduce((sum, value) => sum + value.value, 0)
  const before = await total()
  const clientMessageId = randomUUID()
  const body = { receiverId: receiverId.toUpperCase(), message: envelope, clientMessageId }
  const accepted = await rest(body)
  expect(accepted.status).toBe(200)
  expect(await request('/get/' + senderId.toUpperCase(), receiverId.toUpperCase())).toMatchObject({ status: 200, body: { data: [{ id: accepted.body.data.id, senderId, receiverId, message: envelope }], pagination: { total: 1, limit: 50, offset: 0, hasMore: false } } })
  expect(await request('/messages/read/' + senderId.toUpperCase(), receiverId.toUpperCase(), 'PUT')).toMatchObject({ status: 200, body: { data: { modifiedCount: 1 } } })
  const replay = await rest(body, senderId.toUpperCase())
  expect(replay).toMatchObject({ status: 200, body: { data: { id: accepted.body.data.id, status: 'Seen', message: envelope } } })
  expect((await rest({ ...body, message: envelope + ' ' })).status).toBe(409)
  expect((await rest({ ...body, receiverId: foreignId })).status).toBe(409)
  expect(await total() - before).toBe(1)
  expect(relayAcceptedMessage).toHaveBeenCalledTimes(1)
  expect(relayReceipt).toHaveBeenCalledWith({ type: 'read', userId: senderId, by: receiverId })
  expect(await counts()).toEqual({ messages: 1, events: 1 })
})

it('stores native uppercase relationships in canonical form before replay comparison', async () => {
  const clientMessageId = randomUUID()
  const first = await service.submit(command({ senderId: senderId.toUpperCase(), receiverId: receiverId.toUpperCase(), clientMessageId }))
  expect(first.message).toMatchObject({ senderId, receiverId, message: envelope })
  expect(await service.submit(command({ clientMessageId }))).toMatchObject({ replayed: true, message: { id: first.message.id, senderId, receiverId } })
  expect(await counts()).toEqual({ messages: 1, events: 1 })
})

it('keeps foreign and missing HTTP receipts opaque without changing storage or relaying to Go', async () => {
  const { message } = await service.submit(command())
  for (const id of [message.id, randomUUID()]) {
    const result = await request(`/messages/${id}/delivered?expectedUserId=${foreignId}`, foreignId, 'PUT')
    expect(result).toMatchObject({ status: 404, body: { message: 'Message not found' } })
  }
  expect((await AppDataSource.getRepository(Message).findOneByOrFail({ id: message.id })).status).toBe('NotDelivered')
  expect(relayReceipt).not.toHaveBeenCalled()
  expect(await counts()).toEqual({ messages: 1, events: 1 })
})

it('accepts delivery only for the authenticated receiver, then replays without another Go receipt', async () => {
  const { message } = await service.submit(command())
  const path = `/messages/${message.id.toUpperCase()}/delivered?expectedUserId=${receiverId.toUpperCase()}`
  expect((await request(path, foreignId, 'PUT')).status).toBe(403)
  expect(await request(path, receiverId.toUpperCase(), 'PUT')).toMatchObject({ status: 200, body: { data: { modifiedCount: 1 } } })
  expect(await request(path, receiverId, 'PUT')).toMatchObject({ status: 200, body: { data: { modifiedCount: 0 } } })
  expect((await AppDataSource.getRepository(Message).findOneByOrFail({ id: message.id })).status).toBe('Delivered')
  expect(relayReceipt).toHaveBeenCalledTimes(1)
  expect(relayReceipt).toHaveBeenCalledWith({ type: 'delivered', userId: senderId, by: receiverId, messageId: message.id })
})

it.each([null, '', 7, 'not-a-uuid'])('rejects a provided invalid key %p at the HTTP boundary', async clientMessageId => {
  expect((await rest({ receiverId, message: envelope, clientMessageId })).status).toBe(400)
  expect(await counts()).toEqual({ messages: 0, events: 0 })
  expect(relayAcceptedMessage).not.toHaveBeenCalled()
})

it('rejects same-user case variants at native storage and HTTP boundaries', async () => {
  await expect(service.submit(command({ receiverId: senderId.toUpperCase() }))).rejects.toMatchObject({ statusCode: 400 })
  expect((await rest({ receiverId: senderId.toUpperCase(), message: envelope })).status).toBe(400)
  expect(await counts()).toEqual({ messages: 0, events: 0 })
})

it('cannot downgrade a concurrent Seen update after reading NotDelivered', async () => {
  const { message } = await service.submit(command())
  const repo = AppDataSource.getRepository(Message)
  const findOne = repo.findOne.bind(repo)
  const lookup = jest.spyOn(repo, 'findOne').mockImplementation(async options => {
    const stale = await findOne(options)
    await markConversationSeen(senderId, receiverId)
    return stale
  })
  try {
    expect(await markMessageDelivered(message.id, receiverId)).toMatchObject({ changed: false })
    expect((await repo.findOneByOrFail({ id: message.id })).status).toBe('Seen')
    expect(relayReceipt).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'delivered' }))
  } finally { lookup.mockRestore() }
})
