process.env.NODE_ENV = 'production'
process.env.JWT_SECRET = 'retirement-fixture-secret-with-sufficient-length'
process.env.DATABASE_URL = 'fixture-only'
process.env.MESSAGE_BROKER_URL = 'fixture-only'
process.env.PORT = '0'

jest.mock('uuid', () => ({ v4: () => 'fixture-uuid' }))
jest.mock('../../src/database', () => ({ connectDB: jest.fn(async () => undefined), AppDataSource: {}, Message: class {} }))
jest.mock('../../src/database/connection', () => ({ AppDataSource: { isInitialized: false } }))
jest.mock('../../src/services/RabbitMQService', () => ({ rabbitMQService: {
  connect: jest.fn(async () => undefined), disconnect: jest.fn(async () => undefined), isHealthy: () => false,
} }))
jest.mock('../../src/services/OutboxWorker', () => ({ outboxWorker: { start: jest.fn(), stop: jest.fn(async () => undefined) } }))

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Server } from 'node:http'
import jwt from 'jsonwebtoken'
import { MessageSubmissionService } from '../../src/services/MessageSubmissionService'
import { start, gracefulShutdown } from '../../src/server'
import { AppDataSource } from '../../src/database/connection'
import { rabbitMQService } from '../../src/services/RabbitMQService'

let server: Server
let origin: string
beforeAll(async () => {
  server = await start()
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve))
  origin = 'http://127.0.0.1:' + (server.address() as import('node:net').AddressInfo).port
})
afterAll(async () => { await gracefulShutdown('TEST'); jest.restoreAllMocks() })
afterEach(() => { jest.restoreAllMocks() })

it('has no legacy realtime dependencies in the manifest or installed lock graph', () => {
  const manifest = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8'))
  const lock = JSON.parse(readFileSync(resolve(__dirname, '../../package-lock.json'), 'utf8'))
  for (const name of ['socket.io', '@socket.io/redis-adapter', 'ioredis', '@types/ioredis']) {
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain(name)
    expect(Object.keys(manifest.devDependencies ?? {})).not.toContain(name)
    expect(Object.prototype.hasOwnProperty.call(lock.packages, 'node_modules/' + name)).toBe(false)
  }
  expect(Object.keys(lock.packages).filter(name => /node_modules\/(?:socket\.io(?:-adapter|-parser)?|engine\.io(?:-parser)?|@socket\.io\/[^/]+|ioredis|@ioredis\/[^/]+|redis-errors|redis-parser|ws)$/.test(name))).toEqual([])
})

it('does not expose a Socket.IO handshake or attach an HTTP upgrade listener', async () => {
  const response = await fetch(origin + '/chat/socket.io/?EIO=4&transport=polling')
  expect(response.status).toBe(404)
  await response.body?.cancel()
  expect(server.listenerCount('upgrade')).toBe(0)
})

it('keeps authentication and the authenticated sender precondition before durable HTTP submission', async () => {
  const submit = jest.spyOn(MessageSubmissionService.prototype, 'submit')
  const body = JSON.stringify({ expectedSenderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', receiverId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', message: '{"__encrypted":true,"body":"ciphertext"}' })
  const anonymous = await fetch(origin + '/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body })
  expect(anonymous.status).toBe(401)
  await anonymous.body?.cancel()
  const token = jwt.sign({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, process.env.JWT_SECRET!)
  const changedAccount = await fetch(origin + '/send', { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'jwt=' + token }, body })
  expect(changedAccount.status).toBe(403)
  await changedAccount.body?.cancel()
  expect(submit).not.toHaveBeenCalled()
})

it('preserves the health response shape without a Redis provider', async () => {
  const response = await fetch(origin + '/health')
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ status: 'degraded' })
})

it.each<[boolean, boolean, number, string]>([
  [false, true, 503, 'degraded'],
  [true, false, 503, 'degraded'],
  [true, true, 200, 'ok'],
])('reports health with database=%s and broker=%s', async (databaseReady, brokerReady, status, health) => {
  jest.replaceProperty(AppDataSource, 'isInitialized', databaseReady)
  jest.spyOn(rabbitMQService, 'isHealthy').mockReturnValue(brokerReady)
  const response = await fetch(origin + '/health')
  expect(response.status).toBe(status)
  expect(await response.json()).toEqual({ status: health })
})
