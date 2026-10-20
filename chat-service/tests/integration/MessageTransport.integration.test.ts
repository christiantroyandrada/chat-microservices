process.env.NODE_ENV = 'production'
export {}

const { requireMessageIntegrationDatabase, assertMessageIntegrationDatabaseIdentity } = require('./messageIntegrationDatabase') as typeof import('./messageIntegrationDatabase')
const fixture = requireMessageIntegrationDatabase(process.env)
process.env.DATABASE_URL = fixture.url
process.env.JWT_SECRET = 'task6c-local-only-signing-secret'
process.env.MESSAGE_BROKER_URL = process.env.CHAT_INTEGRATION_BROKER_URL

const { randomUUID } = require('node:crypto') as typeof import('node:crypto')
const jwt = require('jsonwebtoken') as typeof import('jsonwebtoken')
const { AppDataSource, Message } = require('../../src/database') as typeof import('../../src/database')
const { MessageSubmissionService } = require('../../src/services/MessageSubmissionService') as typeof import('../../src/services/MessageSubmissionService')
const { handleMessageDelivered, handleMarkRead } = require('../../src/websocket/socketHandler') as typeof import('../../src/websocket/socketHandler')
const { createSocketServer } = require('../../src/websocket') as typeof import('../../src/websocket')
const { LocalPresenceStore } = require('../../src/services/PresenceStore') as typeof import('../../src/services/PresenceStore')
const { default: app } = require('../../src/app') as typeof import('../../src/app')

const senderId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const receiverId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const envelope = ' \n' + JSON.stringify({ __encrypted: true, body: 'ciphertext+/=' }) + '\t '
const service = new MessageSubmissionService()
const { chatMessagesSentTotal } = require('../../src/utils/metrics') as typeof import('../../src/utils/metrics')
let http: import('node:http').Server
let io: import('socket.io').Server
let origin: string
const clients: WebSocket[] = []

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

async function rest(body: Record<string, unknown>, user = senderId) {
  const response = await fetch(origin + '/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: 'jwt=' + jwt.sign({ id: user, username: 'Sender', email: 'sender@example.test' }, process.env.JWT_SECRET!) },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as any }
}

async function socket(user: string) {
  const ws = new WebSocket(origin.replace('http', 'ws') + '/chat/socket.io/?EIO=4&transport=websocket')
  clients.push(ws)
  const packets: string[] = []
  const waiters = new Set<() => void>()
  ws.addEventListener('message', event => {
    const packet = String(event.data)
    if (packet === '2') ws.send('3')
    else packets.push(packet)
    for (const notify of waiters) notify()
  })
  async function packet(prefix: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(check); reject(new Error('Socket packet timeout: ' + prefix)) }, 3000)
      function check() {
        const index = packets.findIndex(value => value.startsWith(prefix))
        if (index < 0) return
        clearTimeout(timer)
        waiters.delete(check)
        resolve(packets.splice(index, 1)[0])
      }
      waiters.add(check)
      check()
    })
  }
  await packet('0')
  ws.send('40' + JSON.stringify({ token: jwt.sign({ id: user, username: 'Sender', email: 'sender@example.test' }, process.env.JWT_SECRET!) }))
  await packet('40')
  let sequence = 0
  return {
    async send(body: Record<string, unknown>) {
      const id = ++sequence
      ws.send('42' + id + JSON.stringify(['sendMessage', body]))
      return JSON.parse((await packet('43' + id + '[')).slice(String(id).length + 2))[0]
    },
    async receive() {
      return JSON.parse((await packet('42["receiveMessage"')).slice(2))[1]
    },
  }
}

beforeAll(async () => {
  await AppDataSource.initialize()
  await guard()
  await AppDataSource.runMigrations({ transaction: 'each' })
  http = app.listen(0, '127.0.0.1')
  io = createSocketServer(http, new LocalPresenceStore())
  await new Promise<void>(resolve => http.once('listening', resolve))
  origin = 'http://127.0.0.1:' + (http.address() as import('node:net').AddressInfo).port
})
beforeEach(async () => {
  await guard()
  await AppDataSource.query('TRUNCATE outbox_events, messages')
})
afterEach(() => { for (const ws of clients.splice(0)) ws.close() })
afterAll(async () => {
  if (io) await new Promise<void>(resolve => io.close(() => resolve()))
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
})

it('accepts a real REST send and concurrent WebSocket retry as one durable command with exact bytes and canonical UUIDs', async () => {
  const sender = await socket(senderId.toUpperCase())
  const receiver = await socket(receiverId.toUpperCase())
  const clientMessageId = randomUUID()
  const body = { senderId: senderId.toUpperCase(), receiverId: receiverId.toUpperCase(), message: envelope, clientMessageId }
  const [accepted, ack] = await Promise.all([rest(body, senderId.toUpperCase()), sender.send(body)])
  expect(accepted).toMatchObject({ status: 200, body: { status: 200, message: 'Message sent successfully', data: { senderId, receiverId, message: envelope, clientMessageId } } })
  expect(ack).toEqual({ ok: true, id: accepted.body.data.id })
  expect(await receiver.receive()).toMatchObject({ id: ack.id, receiverId, message: envelope, status: 'NotDelivered', isEncrypted: true, clientMessageId, read: false, isRead: false })
  expect(await counts()).toEqual({ messages: 1, events: 1 })
})

it('keeps an accepted REST command reachable through uppercase URLs and retries its current Seen state over WebSocket without recounting', async () => {
  const before = await chatMessagesSentTotal.get()
  const totalBefore = before.values.reduce((sum, value) => sum + value.value, 0)
  const clientMessageId = randomUUID()
  const accepted = await rest({ receiverId: receiverId.toUpperCase(), message: envelope, clientMessageId })
  expect(accepted.status).toBe(200)
  const token = jwt.sign({ id: receiverId.toUpperCase(), username: 'Receiver', email: 'receiver@example.test' }, process.env.JWT_SECRET!)
  const headers = { cookie: 'jwt=' + token }
  const conversation = await fetch(origin + '/get/' + senderId.toUpperCase(), { headers })
  expect(conversation.status).toBe(200)
  expect(await conversation.json()).toMatchObject({ data: [{ id: accepted.body.data.id, senderId, receiverId, message: envelope }], pagination: { total: 1, limit: 50, offset: 0, hasMore: false } })
  const read = await fetch(origin + '/messages/read/' + senderId.toUpperCase(), { method: 'PUT', headers })
  expect(read.status).toBe(200)
  expect(await read.json()).toMatchObject({ data: { modifiedCount: 1 } })
  const sender = await socket(senderId.toUpperCase())
  const receiver = await socket(receiverId.toUpperCase())
  expect(await sender.send({ senderId: senderId.toUpperCase(), receiverId: receiverId.toUpperCase(), message: envelope, clientMessageId })).toEqual({ ok: true, id: accepted.body.data.id })
  expect(await receiver.receive()).toMatchObject({ status: 'Seen', read: true, isRead: true, isEncrypted: true, clientMessageId })
  expect((await rest({ receiverId, message: envelope + ' ', clientMessageId })).status).toBe(409)
  expect((await rest({ receiverId, message: envelope, clientMessageId })).status).toBe(200)
  const after = await chatMessagesSentTotal.get()
  expect(after.values.reduce((sum, value) => sum + value.value, 0) - totalBefore).toBe(1)
  expect(await counts()).toEqual({ messages: 1, events: 1 })
})

it('stores native uppercase relationships in canonical form before replay comparison', async () => {
  const clientMessageId = randomUUID()
  const first = await service.submit(command({ senderId: senderId.toUpperCase(), receiverId: receiverId.toUpperCase(), clientMessageId }))
  expect(first.message).toMatchObject({ senderId, receiverId, message: envelope })
  const replay = await service.submit(command({ clientMessageId }))
  expect(replay).toMatchObject({ replayed: true, message: { id: first.message.id, senderId, receiverId } })
  expect(await counts()).toEqual({ messages: 1, events: 1 })
})

it('forwards only owned stored ciphertext, preserves Seen, binds keyed content, and keeps legacy display-copy compatibility', async () => {
  const sender = await socket(senderId)
  const receiver = await socket(receiverId)
  const first = await service.submit(command({ clientMessageId: randomUUID() }))
  await AppDataSource.getRepository(Message).update(first.message.id, { status: 'Seen' as any })
  const body = { senderId, receiverId, _id: first.message.id, message: envelope, clientMessageId: first.message.clientMessageId }
  expect(await sender.send(body)).toEqual({ ok: true, id: first.message.id })
  expect(await receiver.receive()).toMatchObject({ status: 'Seen', read: true, isRead: true, message: envelope })
  for (const changed of [{ message: envelope + ' ' }, { clientMessageId: randomUUID() }, { clientMessageId: undefined }]) {
    expect(await sender.send({ ...body, ...changed })).toMatchObject({ ok: false })
  }
  const legacy = await service.submit(command())
  expect(await sender.send({ senderId, receiverId, _id: legacy.message.id, message: 'display copy plaintext'.repeat(400) })).toEqual({ ok: true, id: legacy.message.id })
  expect(await receiver.receive()).toMatchObject({ message: envelope, isEncrypted: true })
  expect(await counts()).toEqual({ messages: 2, events: 2 })
})

it('keeps foreign, missing and malformed IDs opaque and never falls back to a new send', async () => {
  const sender = await socket(senderId)
  const foreign = await service.submit(command({ senderId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }))
  const errors = []
  for (const _id of [foreign.message.id, randomUUID(), '', null, 42, 'bad-id']) {
    errors.push(await sender.send({ senderId, receiverId, _id, message: envelope }))
  }
  expect(errors).toEqual(Array(6).fill({ ok: false, error: 'Message not found' }))
  expect(await counts()).toEqual({ messages: 1, events: 1 })
})

it.each([null, '', 7, 'not-a-uuid'])('rejects a provided invalid key %p at REST and socket boundaries', async clientMessageId => {
  const sender = await socket(senderId)
  expect((await rest({ receiverId, message: envelope, clientMessageId })).status).toBe(400)
  expect(await sender.send({ senderId, receiverId, message: envelope, clientMessageId })).toMatchObject({ ok: false })
  expect(await counts()).toEqual({ messages: 0, events: 0 })
})

it('rejects same-user case variants at native storage, REST and WebSocket boundaries', async () => {
  await expect(service.submit(command({ receiverId: senderId.toUpperCase() }))).rejects.toMatchObject({ statusCode: 400 })
  expect((await rest({ receiverId: senderId.toUpperCase(), message: envelope })).status).toBe(400)
  const sender = await socket(senderId)
  expect(await sender.send({ senderId, receiverId: senderId.toUpperCase(), message: envelope })).toMatchObject({ ok: false })
  expect(await counts()).toEqual({ messages: 0, events: 0 })
})

it('cannot downgrade a concurrent Seen update after reading NotDelivered', async () => {
  const { message } = await service.submit(command())
  const repo = AppDataSource.getRepository(Message)
  const findOne = repo.findOne.bind(repo)
  const lookup = jest.spyOn(repo, 'findOne').mockImplementation(async options => {
    const stale = await findOne(options)
    await handleMarkRead({ to: () => ({ emit() {} }) } as any, receiverId, { senderId })
    return stale
  })
  try {
    await handleMessageDelivered({ to: () => ({ emit() {} }) } as any, receiverId, { messageId: message.id })
    expect((await repo.findOneByOrFail({ id: message.id })).status).toBe('Seen')
  } finally { lookup.mockRestore() }
})
