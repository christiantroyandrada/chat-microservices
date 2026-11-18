process.env.NODE_ENV = 'production'
export {}

const { requireMessageIntegrationDatabase, assertMessageIntegrationDatabaseIdentity } = require('./messageIntegrationDatabase') as typeof import('./messageIntegrationDatabase')
const fixture = requireMessageIntegrationDatabase(process.env)
process.env.DATABASE_URL = fixture.url
const { readFileSync } = require('node:fs') as typeof import('node:fs')
const { resolve } = require('node:path') as typeof import('node:path')
const { DataSource } = require('typeorm') as typeof import('typeorm')
const { AppDataSource } = require('../../src/database') as typeof import('../../src/database')
const { MessageSubmissionService } = require('../../src/services/MessageSubmissionService') as typeof import('../../src/services/MessageSubmissionService')
const { OutboxWorker } = require('../../src/services/OutboxWorker') as typeof import('../../src/services/OutboxWorker')
const roles: import('typeorm').DataSource[] = []
const { fork, execFileSync } = require('node:child_process') as typeof import('node:child_process')
const { requireMessageIntegrationBroker } = require('./messageIntegrationBroker') as typeof import('./messageIntegrationBroker')
const jwt = require('jsonwebtoken') as typeof import('jsonwebtoken')
const amqp = require('amqplib') as typeof import('amqplib')

async function guard() {
  const [identity] = await AppDataSource.query('SELECT current_database() AS database, current_user AS user, inet_server_addr()::text AS address, inet_server_port() AS port')
  assertMessageIntegrationDatabaseIdentity(fixture, identity)
}

beforeAll(async () => {
  await AppDataSource.initialize()
  await guard()
  await AppDataSource.runMigrations({ transaction: 'each' })
  for (const role of ['user_svc', 'chat_svc', 'notif_svc']) {
    await guard()
    await AppDataSource.query(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE; END IF; END $$`)
  }
  // Earlier migration fixtures recreate public. Apply the owner's separate provisioning prerequisite, without table privileges.
  await guard()
  await AppDataSource.query('GRANT USAGE ON SCHEMA public TO user_svc, chat_svc, notif_svc')
  for (const table of ['users', 'prekeys', 'notifications']) {
    await guard()
    await AppDataSource.query(`CREATE TABLE IF NOT EXISTS ${table} (id integer)`)
  }
  // Extract only the owner's static table-permission statements. Never print the helper or the script.
  const helper = readFileSync(resolve(__dirname, '../../../deploy/release-backend.sh'), 'utf8').match(/grant_service_tables\(\) \{[\s\S]*?\n\}/)?.[0]
  if (!helper) throw new Error('Known deployment grant helper context does not match')
  const sql = Array.from(helper.matchAll(/-c "((?:REVOKE ALL ON ALL TABLES IN SCHEMA public FROM |ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON (?:TABLES|SEQUENCES) FROM |GRANT SELECT, INSERT, UPDATE, DELETE ON )[a-zA-Z_, ]+);"/g), match => match[1] + ';')
  if (sql.length !== 6) throw new Error('Known deployment static grant statement count does not match')
  for (const statement of sql) {
    await guard()
    await AppDataSource.query(statement)
  }
})
afterAll(async () => {
  await Promise.all(roles.map(role => role.destroy()))
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
})

async function asRole(role: string) {
  const url = new URL(fixture.url)
  url.username = role
  if (AppDataSource.options.type !== 'postgres') throw new Error('PostgreSQL fixture required')
  const dataSource = new DataSource({ ...AppDataSource.options, url: url.toString() })
  await dataSource.initialize()
  roles.push(dataSource)
  expect((await dataSource.query('SELECT current_user AS role'))[0].role).toBe(role)
  return dataSource
}

it('runs the actual submission and lease worker as chat_svc with deployment-derived grants', async () => {
  const restricted = await asRole('chat_svc')
  const service = new MessageSubmissionService(restricted)
  await guard()
  await AppDataSource.query('TRUNCATE outbox_events, messages')
  const result = await service.submit({ senderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', receiverId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', encryptedEnvelope: '{"__encrypted":true,"body":"restricted-ciphertext"}', senderName: 'Sender', senderEmail: 'sender@example.test' })
  const seen: string[] = []
  const worker = new OutboxWorker(restricted, { publishNotification: async (_payload, eventId) => { seen.push(eventId!) } }, async payload => payload)
  await worker.runOnce()
  const [event] = await restricted.query('SELECT * FROM outbox_events WHERE payload->>\'envelope\' = $1', [result.message.message])
  expect(event).toMatchObject({ state: 'published', attempts: 1, leaseToken: null, lockedAt: null })
  expect(seen).toContain(event.id)
})

it('denies outbox access to user_svc and notif_svc', async () => {
  for (const role of ['user_svc', 'notif_svc']) {
    const restricted = await asRole(role)
    await expect(restricted.query('SELECT * FROM outbox_events')).rejects.toMatchObject({ code: '42501' })
    await expect(restricted.query("UPDATE outbox_events SET attempts = attempts + 1")).rejects.toMatchObject({ code: '42501' })
    await expect(restricted.query("INSERT INTO outbox_events (id, payload) VALUES (gen_random_uuid(), '{}')")).rejects.toMatchObject({ code: '42501' })
    await guard()
    await expect(restricted.query('DELETE FROM outbox_events')).rejects.toMatchObject({ code: '42501' })
  }
})

it('denies other service tables and DDL to chat_svc', async () => {
  const restricted = await asRole('chat_svc')
  for (const table of ['users', 'prekeys', 'notifications']) {
    await expect(restricted.query(`SELECT * FROM ${table}`)).rejects.toMatchObject({ code: '42501' })
    await expect(restricted.query(`INSERT INTO ${table} (id) VALUES (1)`)).rejects.toMatchObject({ code: '42501' })
    await expect(restricted.query(`UPDATE ${table} SET id = 1`)).rejects.toMatchObject({ code: '42501' })
    await guard()
    await expect(restricted.query(`DELETE FROM ${table}`)).rejects.toMatchObject({ code: '42501' })
  }
  for (const statement of ['CREATE TABLE task6c_forbidden (id integer)', 'ALTER TABLE messages ADD COLUMN task6c_forbidden integer', 'DROP TABLE notifications']) {
    await guard()
    await expect(restricted.query(statement)).rejects.toMatchObject({ code: '42501' })
  }
})

it('accepts durable work during initial broker outage, recovers through the real worker, and exits with an authenticated upgraded socket', async () => {
  const brokerUrl = requireMessageIntegrationBroker(process.env)
  const container = process.env.CHAT_INTEGRATION_BROKER_CONTAINER
  const owner = process.env.CHAT_INTEGRATION_CONTAINER_OWNER
  if (!container || !/^chat-task6c-rabbit-[a-z0-9-]+$/.test(container) || !owner?.startsWith('task6c-')) throw new Error('Owned broker container is required')
  function guardBroker() {
    const [actual] = JSON.parse(execFileSync('docker', ['inspect', container!], { encoding: 'utf8' }))
    if (actual.Config.Labels['chat.fixture'] !== owner || actual.Mounts.some((mount: any) => mount.Type !== 'tmpfs') || !actual.HostConfig.Tmpfs?.['/var/lib/rabbitmq']) throw new Error('Broker container ownership or tmpfs guard failed')
  }
  guardBroker()
  execFileSync('docker', ['stop', container], { stdio: 'pipe' })
  await guard()
  await AppDataSource.query('TRUNCATE outbox_events, messages')
  const url = new URL(fixture.url)
  url.username = 'chat_svc'
  const child = fork(resolve(__dirname, 'runtimeFixture.ts'), [], {
    execPath: process.execPath,
    execArgv: ['-r', 'ts-node/register'],
    cwd: resolve(__dirname, '../..'),
    env: { NODE_ENV: 'production', DATABASE_URL: url.toString(), MESSAGE_BROKER_URL: brokerUrl, JWT_SECRET: 'task6c-runtime-secret', PORT: '0', HOME: process.env.HOME },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  child.stdout?.resume()
  child.stderr?.resume()
  let connection: import('amqplib').ChannelModel | undefined
  let exited = false
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveExit => child.once('exit', (code, signal) => { exited = true; resolveExit({ code, signal }) }))
  async function waitFor(check: () => Promise<boolean>, timeout = 15000) {
    const deadline = Date.now() + timeout
    while (!await check()) {
      if (Date.now() > deadline) throw new Error('Runtime fixture condition timeout')
      await new Promise(resolveWait => setTimeout(resolveWait, 50))
    }
  }
  try {
    const port = await new Promise<number>((resolvePort, reject) => {
      const timer = setTimeout(() => reject(new Error('HTTP acceptance waited for the unavailable broker')), 8000)
      child.once('message', (message: any) => { clearTimeout(timer); resolvePort(message.port) })
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Runtime fixture exited before listening')) })
    })
    const senderId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const receiverId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const token = jwt.sign({ id: senderId, username: 'Sender', email: 'sender@example.test' }, 'task6c-runtime-secret')
    const response = await fetch(`http://127.0.0.1:${port}/send`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: 'jwt=' + token },
      body: JSON.stringify({ receiverId, message: '{"__encrypted":true,"body":"outage-ciphertext"}' }),
    })
    expect(response.status).toBe(200)
    await waitFor(async () => {
      const [event] = await AppDataSource.query('SELECT state, attempts FROM outbox_events')
      return event?.state === 'pending' && event.attempts >= 1
    })
    const [pending] = await AppDataSource.query('SELECT * FROM outbox_events')
    expect(pending.state).toBe('pending')
    expect(pending.attempts).toBeGreaterThanOrEqual(1)
    expect((await AppDataSource.query('SELECT COUNT(*)::integer AS count FROM messages'))[0].count).toBe(1)
    guardBroker()
    execFileSync('docker', ['start', container], { stdio: 'pipe' })
    await waitFor(async () => {
      try { connection = await amqp.connect(brokerUrl, { timeout: 500 }); return true } catch { return false }
    })
    const channel = await connection!.createChannel()
    await channel.assertQueue('USER_DETAILS_REQUEST')
    await channel.assertQueue('NOTIFICATIONS', { durable: true })
    await channel.consume('USER_DETAILS_REQUEST', request => {
      if (!request) return
      channel.sendToQueue(request.properties.replyTo, Buffer.from(JSON.stringify({ id: receiverId, username: 'Receiver', email: 'receiver@example.test' })), { correlationId: request.properties.correlationId })
      channel.ack(request)
    })
    await waitFor(async () => (await AppDataSource.query('SELECT state FROM outbox_events WHERE id = $1', [pending.id]))[0].state === 'published')
    const notification = await channel.get('NOTIFICATIONS', { noAck: true })
    expect(notification).not.toBe(false)
    if (!notification) throw new Error('Confirmed event is absent')
    expect(notification.properties.messageId).toBe(pending.id)
    const payload = JSON.parse(notification.content.toString())
    expect(payload).toMatchObject({ eventId: pending.id, userEmail: 'receiver@example.test', envelope: '{"__encrypted":true,"body":"outage-ciphertext"}' })
    expect(payload).not.toHaveProperty('recipientOnline')
    const retired = await fetch(`http://127.0.0.1:${port}/chat/socket.io/?EIO=4&transport=polling`)
    expect(retired.status).toBe(404)
    await retired.body?.cancel()
    child.kill('SIGTERM')
    child.kill('SIGINT')
    const deadline = setTimeout(() => { if (!exited) child.kill('SIGKILL') }, 8000)
    const result = await exit
    clearTimeout(deadline)
    expect(result).toEqual({ code: 0, signal: null })
  } finally {
    if (!exited) { child.kill('SIGKILL'); await exit }
    await connection?.close().catch(() => undefined)
    guardBroker()
    execFileSync('docker', ['start', container], { stdio: 'pipe' })
  }
}, 40000)
