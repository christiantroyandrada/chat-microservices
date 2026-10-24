import 'reflect-metadata'
import { DataSource } from 'typeorm'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Notification, NotificationType } from '../../src/database/models/NotificationModel'
import { InitialSchema1733150000000 } from '../../src/database/migrations/1733150000000-InitialSchema'
import { AddNotificationInbox1792627200000 } from '../../src/database/migrations/1792627200000-AddNotificationInbox'
import { NotificationInbox, PermanentNotificationError } from '../../src/services/NotificationInbox'
import NotificationController from '../../src/controllers/NotificationController'
import { AppDataSource } from '../../src/database'

const url = process.env.NOTIFICATION_INTEGRATION_DATABASE_URL
if (url !== 'postgresql://task7@127.0.0.1:55447/task7_notification_20261022') throw new Error('Explicit Task7 isolated database required')
const database = new DataSource({ type: 'postgres', url, entities: [Notification], migrations: [InitialSchema1733150000000, AddNotificationInbox1792627200000], migrationsTableName: 'typeorm_migrations_notif', synchronize: false })
const inbox = new NotificationInbox(database)
const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const envelope = ' {"__encrypted":true,"body":"fixture-cipher"} '
const event = (extra = {}) => ({ type: 'MESSAGE_RECEIVED', eventId: randomUUID(), userId, senderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', isEncrypted: true, envelope, message: '[Encrypted message]', from: 'sender@fixture.invalid', fromName: 'Sender', ...extra })

async function guard() {
  expect(execFileSync('/opt/homebrew/bin/docker', ['context', 'show'], { encoding: 'utf8' }).trim()).toBe('colima')
  const [container] = JSON.parse(execFileSync('/opt/homebrew/bin/docker', ['--context', 'colima', 'inspect', 'task7a-20261022-postgres'], { encoding: 'utf8' }))
  expect(container.Config.Labels['chat.fixture']).toBe('task7a-20261022')
  expect(container.HostConfig.Tmpfs).toEqual({ '/var/lib/postgresql/data': 'rw' })
  expect(container.Mounts).toEqual([])
  expect(container.HostConfig.PortBindings).toEqual({ '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '55447' }] })
  const [identity] = await database.query('SELECT current_database() AS database, current_user AS role, inet_server_port() AS port')
  expect(identity).toEqual({ database: 'task7_notification_20261022', role: 'task7', port: 5432 })
}
beforeAll(async () => {
  await database.initialize()
  await guard()
  const runner = database.createQueryRunner()
  try { await new InitialSchema1733150000000().up(runner) }
  finally { await runner.release() }
  await database.getRepository(Notification).save({ userId, type: NotificationType.SYSTEM, title: 'Existing', message: 'Existing', read: true })
  await database.runMigrations()
  expect(await database.getRepository(Notification).countBy({ title: 'Existing' })).toBe(1)
})
beforeEach(async () => { await guard(); await database.query('TRUNCATE notification_inbox, notifications') })
afterEach(() => jest.restoreAllMocks())
afterAll(async () => { if (database.isInitialized) await database.destroy() })

test('concurrent receipts create one visible row and one durable identity', async () => {
  const payload = event()
  const results = await Promise.all(Array.from({ length: 12 }, () => inbox.accept(payload, payload.eventId)))
  expect(results.filter(result => result === 'inserted')).toHaveLength(1)
  expect(results.filter(result => result === 'duplicate')).toHaveLength(11)
  expect(await database.getRepository(Notification).count()).toBe(1)
  expect((await database.query('SELECT * FROM notification_inbox'))).toHaveLength(1)
})

test('notification insertion failure rolls back the receipt and permits retry', async () => {
  await database.query('ALTER TABLE notifications ADD CONSTRAINT fixture_reject CHECK (false) NOT VALID')
  const payload = event()
  try { await expect(inbox.accept(payload)).rejects.toThrow() }
  finally { await database.query('ALTER TABLE notifications DROP CONSTRAINT fixture_reject') }
  expect(await database.query('SELECT * FROM notification_inbox')).toEqual([])
  expect(await database.getRepository(Notification).count()).toBe(0)
  await expect(inbox.accept(payload)).resolves.toBe('inserted')
})

test('a lost commit response permits replay without another visible notification', async () => {
  const payload = event()
  const runner = database.createQueryRunner()
  const commit = runner.commitTransaction.bind(runner)
  jest.spyOn(runner, 'commitTransaction').mockImplementationOnce(async () => {
    await commit()
    throw new Error('fixture lost commit response')
  })
  jest.spyOn(database, 'createQueryRunner').mockReturnValueOnce(runner)
  await expect(inbox.accept(payload)).rejects.toThrow('fixture lost commit response')
  expect(await database.getRepository(Notification).count()).toBe(1)
  expect(await database.query('SELECT * FROM notification_inbox')).toHaveLength(1)
  await expect(inbox.accept(payload, payload.eventId)).resolves.toBe('duplicate')
  expect(await database.getRepository(Notification).count()).toBe(1)
  expect(await database.query('SELECT * FROM notification_inbox')).toHaveLength(1)
})

test('advisory replay preserves exact canonical bytes, receipt time, and visible read state', async () => {
  const payload = event({ userEmail: 'first@fixture.invalid', userToken: 'fixture-token', recipientOnline: false })
  await inbox.accept(payload)
  await database.getRepository(Notification).update({ userId }, { read: true })
  const [before] = await database.query('SELECT * FROM notification_inbox')
  await expect(inbox.accept({ ...payload, userEmail: 'second@fixture.invalid', userToken: undefined, recipientOnline: true })).resolves.toBe('duplicate')
  const [after] = await database.query('SELECT * FROM notification_inbox')
  expect(after.canonical).toEqual(before.canonical)
  expect(after.canonical.envelope).toBe(envelope)
  expect(after.receivedAt).toEqual(before.receivedAt)
  expect(after.advisory).toEqual({ userEmail: 'second@fixture.invalid', userToken: 'fixture-token', recipientOnline: true })
  const visible = await database.getRepository(Notification).findOneByOrFail({ userId })
  expect(visible.read).toBe(true)
  expect(Object.keys(visible).sort()).toEqual(['createdAt', 'id', 'message', 'read', 'title', 'type', 'updatedAt', 'userId'])
})

test('canonical conflict cannot overwrite the receipt or create another notification', async () => {
  const payload = event()
  await inbox.accept(payload)
  await expect(inbox.accept({ ...payload, envelope: '{"__encrypted":true,"body":"other"}' })).rejects.toBeInstanceOf(PermanentNotificationError)
  expect((await database.query('SELECT canonical FROM notification_inbox'))[0].canonical.envelope).toBe(envelope)
  expect(await database.getRepository(Notification).count()).toBe(1)
})

test('physical deletion through the controller does not permit replay resurrection', async () => {
  const payload = event()
  await inbox.accept(payload)
  const visible = await database.getRepository(Notification).findOneByOrFail({ userId })
  jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(database.getRepository(Notification))
  const response = { json: jest.fn() }
  const next = jest.fn()
  await NotificationController.deleteNotification({ user: { _id: userId }, params: { notificationId: visible.id } } as Parameters<typeof NotificationController.deleteNotification>[0], response as unknown as Parameters<typeof NotificationController.deleteNotification>[1], next)
  expect(next).not.toHaveBeenCalled()
  expect(response.json).toHaveBeenCalled()
  await expect(inbox.accept(payload)).resolves.toBe('duplicate')
  expect(await database.getRepository(Notification).count()).toBe(0)
  expect(await database.query('SELECT * FROM notification_inbox')).toHaveLength(1)
})

test('registration is idempotent while unkeyed historical messages remain best effort', async () => {
  const welcome = { type: 'USER_REGISTERED', userId, userEmail: 'user@fixture.invalid' }
  await expect(inbox.accept(welcome)).resolves.toBe('inserted')
  const suppliedId = randomUUID()
  await expect(inbox.accept({ ...welcome, eventId: suppliedId, userEmail: 'changed@fixture.invalid' }, suppliedId.toUpperCase())).resolves.toBe('duplicate')
  expect((await database.query('SELECT "eventKey" FROM notification_inbox'))[0].eventKey).toBe(`registration:${userId}`)
  const legacy = { type: 'MESSAGE_RECEIVED', userId, message: 'legacy' }
  await inbox.accept(legacy)
  await inbox.accept(legacy)
  expect(await database.getRepository(Notification).count()).toBe(3)
})

test('stores ordinary Unicode and valid surrogate pairs in canonical and advisory fields', async () => {
  const message = 'café 世界 😀'
  await expect(inbox.accept({ type: 'MESSAGE_RECEIVED', eventId: randomUUID(), userId, message, userToken: message })).resolves.toBe('inserted')
  const [receipt] = await database.query('SELECT canonical, advisory FROM notification_inbox')
  expect(receipt.canonical.message).toBe(message)
  expect(receipt.advisory.userToken).toBe(message)
  expect((await database.getRepository(Notification).findOneByOrFail({ userId })).message).toBe(message)
})

test('validates known payloads and IDs before storage and ignores unknown event types', async () => {
  for (const invalid of [null, {}, event({ userId: '' }), event({ eventId: 'bad' }), event({ recipientOnline: 'yes' }), event({ envelope: 'plaintext' })]) {
    await expect(inbox.accept(invalid)).rejects.toBeInstanceOf(PermanentNotificationError)
  }
  const payload = event()
  await expect(inbox.accept(payload, randomUUID())).rejects.toBeInstanceOf(PermanentNotificationError)
  await expect(inbox.accept({ type: 'USER_LOGGED_IN', userId })).resolves.toBe('ignored')
  expect(await database.query('SELECT * FROM notification_inbox')).toEqual([])
})

test('actual deployment grants allow receipt insertion but deny receipt deletion and other service access', async () => {
  for (const role of ['user_svc', 'chat_svc', 'notif_svc']) {
    await database.query(`DO $$ BEGIN CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`)
  }
  for (const table of ['users', 'prekeys', 'messages', 'outbox_events']) await database.query(`CREATE TABLE IF NOT EXISTS ${table} (id uuid)`)
  await database.query('GRANT USAGE ON SCHEMA public TO user_svc, chat_svc, notif_svc')
  const helper = readFileSync(resolve(__dirname, '../../../deploy/release-backend.sh'), 'utf8').match(/grant_service_tables\(\) \{[\s\S]*?\n\}/)?.[0]
  if (!helper) throw new Error('Known deployment grant helper context does not match')
  const statements = Array.from(helper.matchAll(/-c "((?:REVOKE ALL ON ALL TABLES IN SCHEMA public FROM |ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON (?:TABLES|SEQUENCES) FROM |GRANT SELECT, INSERT, UPDATE(?:, DELETE)? ON )[a-zA-Z_, ]+);"/g), match => match[1] + ';')
  if (statements.length !== 7) throw new Error('Known deployment static grant statement count does not match')
  for (const statement of statements) await database.query(statement)
  const roleUrl = new URL(url!)
  roleUrl.username = 'notif_svc'
  const runtime = new DataSource({ type: 'postgres', url: roleUrl.toString(), entities: [Notification] })
  await runtime.initialize()
  try {
    const payload = event()
    const runtimeInbox = new NotificationInbox(runtime)
    await expect(runtimeInbox.accept(payload)).resolves.toBe('inserted')
    await expect(runtimeInbox.accept({ ...payload, recipientOnline: true })).resolves.toBe('duplicate')
    await expect(runtime.query('DELETE FROM notification_inbox')).rejects.toMatchObject({ code: '42501' })
    await expect(runtime.query('SELECT * FROM users')).rejects.toMatchObject({ code: '42501' })
    await expect(runtime.query('ALTER TABLE notification_inbox ADD COLUMN forbidden text')).rejects.toMatchObject({ code: '42501' })
  } finally { await runtime.destroy() }
  for (const role of ['user_svc', 'chat_svc']) {
    roleUrl.username = role
    const other = new DataSource({ type: 'postgres', url: roleUrl.toString() })
    await other.initialize()
    try {
      for (const sql of [
        'SELECT * FROM notification_inbox',
        `INSERT INTO notification_inbox ("eventKey", canonical) VALUES ('forbidden', '{}')`,
        `UPDATE notification_inbox SET advisory = '{}'`,
        'DELETE FROM notification_inbox',
      ]) await expect(other.query(sql)).rejects.toMatchObject({ code: '42501' })
    } finally { await other.destroy() }
  }
})
