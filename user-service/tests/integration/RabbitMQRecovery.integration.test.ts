import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import net from 'node:net'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import amqp, { Channel, ChannelModel } from 'amqplib'
import { assertPrekeyIntegrationDatabaseIdentity, requirePrekeyIntegrationDatabase } from '../utils/prekeyIntegrationDatabase'

const database = requirePrekeyIntegrationDatabase(process.env)
const rabbit = process.env.TASK6D_RABBITMQ_CONTAINER
const postgres = process.env.TASK6D_POSTGRES_CONTAINER
const brokerUrl = process.env.MESSAGE_BROKER_URL || ''
const parsedBroker = new URL(brokerUrl)
if (rabbit !== 'task6d-20261020-rabbit' || postgres !== 'task6d-20261020-postgres' ||
    parsedBroker.protocol !== 'amqp:' || parsedBroker.hostname !== '127.0.0.1' || parsedBroker.port !== '56737' ||
    parsedBroker.username || parsedBroker.password || parsedBroker.search || parsedBroker.hash ||
    database.database !== 'task5_prekey_20261020d' || new URL(database.url).port !== '55437') {
  throw new Error('Task6D requires its explicit isolated fixture')
}
process.env.NODE_ENV = 'production'
process.env.DATABASE_URL = database.url
const { AppDataSource } = require('../../src/database') as typeof import('../../src/database')
const execute = promisify(execFile)
const node22 = '/opt/homebrew/opt/node@22/bin/node'
const fixtureLabel = 'task6d-20261020'
const userId = '66666666-6666-4666-8666-666666666666'
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function inspectOwned(name: string, directory: string, port: string, hostPort: string) {
  const { stdout: context } = await execute('docker', ['context', 'show'])
  expect(context.trim()).toBe('colima')
  const { stdout } = await execute('docker', ['--context', 'colima', 'inspect', name])
  const [container] = JSON.parse(stdout)
  expect(container.Name).toBe(`/${name}`)
  expect(container.Config.Labels['chat.fixture']).toBe(fixtureLabel)
  expect(container.HostConfig.Tmpfs).toEqual({ [directory]: 'rw' })
  expect(container.Mounts).toEqual([])
  expect(container.HostConfig.PortBindings).toEqual({ [port]: [{ HostIp: '127.0.0.1', HostPort: hostPort }] })
  return container.State.Running as boolean
}
async function setBroker(running: boolean) {
  const active = await inspectOwned(rabbit!, '/var/lib/rabbitmq', '5672/tcp', '56737')
  if (active !== running) {
    await execute('docker', ['--context', 'colima', running ? 'start' : 'stop', ...(running ? [] : ['--time', '1']), rabbit!])
  }
}
async function freePort(): Promise<number> {
  const listener = net.createServer()
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
  const port = (listener.address() as net.AddressInfo).port
  await new Promise<void>(resolve => listener.close(() => resolve()))
  return port
}

test('actual profile responder recovers initial and established broker outages, then exits on repeated signals', async () => {
  await inspectOwned(postgres!, '/var/lib/postgresql/data', '5432/tcp', '55437')
  await setBroker(false)
  await AppDataSource.initialize()
  let child: ReturnType<typeof spawn> | undefined
  let client: ChannelModel | undefined
  let channel: Channel | undefined
  const clientEvents: string[] = []
  let logs = ''
  try {
    const [identity] = await AppDataSource.query('SELECT current_database() AS database, current_user AS user, inet_server_addr()::text AS address, inet_server_port() AS port')
    assertPrekeyIntegrationDatabaseIdentity(database, identity)
    await AppDataSource.query('DROP SCHEMA public CASCADE')
    await AppDataSource.query('CREATE SCHEMA public')
    await AppDataSource.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"')
    await AppDataSource.runMigrations({ transaction: 'each' })
    await AppDataSource.query('INSERT INTO users (id, username, email, password, "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, $5)',
      [userId, 'task6d_profile', 'profile@fixture.invalid', 'never-return-fixture-password', '2026-01-01T00:00:00.000Z'])
    const port = await freePort()
    child = spawn(node22, [path.resolve('build/src/server.js')], {
      cwd: path.resolve('.'),
      env: {
        NODE_ENV: 'production', TZ: 'UTC', DATABASE_URL: database.url, PORT: String(port), MESSAGE_BROKER_URL: brokerUrl,
        JWT_SECRET: 'task6d-fixture-secret-at-least-32-characters'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout!.on('data', data => { logs += data.toString() })
    child.stderr!.on('data', data => { logs += data.toString() })
    let exited = false
    const exit = once(child, 'exit').then(([code, signal]) => { exited = true; return { code, signal } })
    async function health(status: number, expected: string) {
      const deadline = Date.now() + 90000
      while (Date.now() < deadline) {
        expect(exited).toBe(false)
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) }).catch(() => undefined)
        if (response?.status === status) {
          expect(await response.json()).toEqual({ status: expected })
          console.log(`TASK6D health=${status} status=${expected} pid=${child!.pid}`)
          return
        }
        await delay(100)
      }
      throw new Error(`Task6D health ${status} timeout; process logs: ${logs}`)
    }
    async function openClient() {
      client = await amqp.connect(brokerUrl, { timeout: 2000 })
      client.on('error', () => { clientEvents.push('connection-error') })
      client.on('close', () => { clientEvents.push('connection-close') })
      channel = await client.createChannel()
      channel.on('error', () => { clientEvents.push('channel-error') })
      channel.on('close', () => { clientEvents.push('channel-close') })
    }
    async function rpc(body: unknown) {
      const active = channel!
      const { queue } = await active.assertQueue('', { exclusive: true })
      const correlationId = randomUUID()
      let timer: ReturnType<typeof setTimeout> | undefined
      let consumerTag: string | undefined
      try {
        const response = new Promise<unknown>((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Task6D RPC timeout')), 5000)
          void active.consume(queue, message => {
            if (message?.properties.correlationId !== correlationId) return
            try { resolve(JSON.parse(message.content.toString())) } catch (error) { reject(error) }
          }, { noAck: true }).then(registered => {
            consumerTag = registered.consumerTag
            active.sendToQueue('USER_DETAILS_REQUEST', Buffer.from(JSON.stringify(body)), { replyTo: queue, correlationId })
          }).catch(reject)
        })
        return await response
      } finally {
        if (timer) clearTimeout(timer)
        if (consumerTag) await active.cancel(consumerTag)
        await active.deleteQueue(queue)
      }
    }
    async function profile() {
      const response = await rpc({ userId })
      expect(response).toEqual({ id: userId, username: 'task6d_profile', email: 'profile@fixture.invalid', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })
      expect(response).not.toHaveProperty('password')
      console.log('TASK6D profile=selected-fields password=absent correlation=matched')
    }

    await health(503, 'degraded')
    expect(logs).toContain('reconnect scheduled')
    await setBroker(true)
    await health(200, 'ok')
    await openClient()
    await profile()
    expect(await rpc({})).toEqual({ error: 'Invalid message format' })
    await setBroker(false)
    await health(503, 'degraded')
    expect(clientEvents).toContain('connection-close')
    expect(clientEvents).toContain('channel-close')
    await setBroker(true)
    await health(200, 'ok')
    await openClient()
    await profile()
    await channel!.close()
    await client!.close()
    channel = undefined
    client = undefined
    await setBroker(false)
    await health(503, 'degraded')
    child.kill('SIGTERM')
    child.kill('SIGINT')
    let exitDeadline: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([exit, new Promise<never>((_, reject) => {
        exitDeadline = setTimeout(() => reject(new Error('Task6D process did not exit after shutdown')), 10000)
      })])
      expect(result).toEqual({ code: 0, signal: null })
      expect(logs.match(/Starting graceful shutdown/g)).toHaveLength(1)
      expect(logs.match(/Graceful shutdown complete/g)).toHaveLength(1)
      expect(logs).not.toContain('never-return-fixture-password')
      console.log(`TASK6D shutdown code=${result.code} signal=${result.signal} repeated-signals=joined client-events=${clientEvents.join(',')}`)
    } finally { if (exitDeadline) clearTimeout(exitDeadline) }
  } finally {
    try { await channel?.close() } catch { /* The broker can already own the close. */ }
    try { await client?.close() } catch { /* The broker can already own the close. */ }
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      const finished = once(child, 'exit')
      const force = setTimeout(() => child!.kill('SIGKILL'), 10000)
      try { await finished } finally { clearTimeout(force) }
    }
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
    await setBroker(false)
  }
}, 180000)
