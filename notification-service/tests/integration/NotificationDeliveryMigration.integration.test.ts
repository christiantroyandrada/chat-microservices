import 'reflect-metadata'
import { requireNotificationIntegrationDatabase } from './notificationIntegrationDatabase'
import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { Notification } from '../../src/database/models/NotificationModel'
import { InitialSchema1733150000000 } from '../../src/database/migrations/1733150000000-InitialSchema'
import { AddNotificationInbox1792627200000 } from '../../src/database/migrations/1792627200000-AddNotificationInbox'
import { AddNotificationDelivery1792800000000 } from '../../src/database/migrations/1792800000000-AddNotificationDelivery'
import { NotificationInbox } from '../../src/services/NotificationInbox'

const fixture = requireNotificationIntegrationDatabase(process.env)
const { url } = fixture
const schema = `task7b_delivery_${randomUUID().replace(/-/g, '')}`
const admin = new DataSource({ type: 'postgres', url, installExtensions: false })
const database = new DataSource({ type: 'postgres', url, schema, installExtensions: false, entities: [Notification], extra: { options: `-c search_path=${schema},public` } })

const guard = () => fixture.assertIdentity(admin)

beforeAll(async () => {
  await admin.initialize()
  await guard()
  await admin.query(`CREATE SCHEMA ${schema}`)
  await database.initialize()
})
afterAll(async () => {
  if (database.isInitialized) await database.destroy()
  if (admin.isInitialized) {
    await guard()
    await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await admin.destroy()
  }
})

test('adds independent delivery state while preserving receipts and 7A writes', async () => {
  await guard()
  const runner = database.createQueryRunner()
  await runner.connect()
  try {
    await new InitialSchema1733150000000().up(runner)
    await new AddNotificationInbox1792627200000().up(runner)
    const inbox = new NotificationInbox(database)
    const payload = { type: 'MESSAGE_RECEIVED', eventId: randomUUID(), userId: 'fixture-user', message: 'original', userEmail: 'person@fixture.invalid' }
    await inbox.accept(payload)
    await database.getRepository(Notification).update({ userId: payload.userId }, { read: true })
    const [before] = await database.query('SELECT * FROM notification_inbox')
    const visible = await database.getRepository(Notification).find()
    await new AddNotificationDelivery1792800000000().up(runner)
    const [after] = await database.query('SELECT * FROM notification_inbox')
    expect(after).toMatchObject(before)
    expect(await database.getRepository(Notification).find()).toEqual(visible)
    for (const provider of ['email', 'push']) {
      expect(after[`${provider}State`]).toBe('pending')
      expect(after[`${provider}Attempts`]).toBe(0)
      expect(after[`${provider}AvailableAt`]).toBeInstanceOf(Date)
      expect(after[`${provider}Reason`]).toBeNull()
    }
    expect(after.deliveryLeaseToken).toBeNull()
    expect(after.deliveryLockedAt).toBeNull()
    await expect(inbox.accept(payload)).resolves.toBe('duplicate')
    await expect(inbox.accept({ ...payload, eventId: randomUUID() })).resolves.toBe('inserted')
    const key = before.eventKey
    await database.query('UPDATE notification_inbox SET "emailState" = $2, "emailAvailableAt" = $3 WHERE "eventKey" = $1', [key, 'retry', new Date('2030-01-01T00:00:00Z')])
    const [changed] = await database.query('SELECT * FROM notification_inbox WHERE "eventKey" = $1', [key])
    expect(changed.emailAvailableAt.toISOString()).toBe('2030-01-01T00:00:00.000Z')
    expect(changed.pushAvailableAt).toEqual(after.pushAvailableAt)
    expect(changed.pushState).toBe('pending')
    for (const provider of ['email', 'push']) {
      for (const state of ['pending', 'retry', 'deferred', 'sent', 'failed', 'skipped']) {
        await database.query(`UPDATE notification_inbox SET "${provider}State" = $2 WHERE "eventKey" = $1`, [key, state])
      }
      await expect(database.query(`UPDATE notification_inbox SET "${provider}State" = 'invalid' WHERE "eventKey" = $1`, [key])).rejects.toMatchObject({ code: '23514' })
      for (const attempts of [-1, 9]) await expect(database.query(`UPDATE notification_inbox SET "${provider}Attempts" = $2 WHERE "eventKey" = $1`, [key, attempts])).rejects.toMatchObject({ code: '23514' })
      await database.query(`UPDATE notification_inbox SET "${provider}Attempts" = 8 WHERE "eventKey" = $1`, [key])
      await expect(database.query(`UPDATE notification_inbox SET "${provider}Reason" = $2 WHERE "eventKey" = $1`, [key, 'x'.repeat(65)])).rejects.toMatchObject({ code: '22001' })
    }
    await expect(database.query('UPDATE notification_inbox SET "deliveryLeaseToken" = $2 WHERE "eventKey" = $1', [key, randomUUID()])).rejects.toMatchObject({ code: '23514' })
    await expect(database.query('UPDATE notification_inbox SET "deliveryLockedAt" = now() WHERE "eventKey" = $1', [key])).rejects.toMatchObject({ code: '23514' })
    await database.query('UPDATE notification_inbox SET "deliveryLeaseToken" = $2, "deliveryLockedAt" = now() WHERE "eventKey" = $1', [key, randomUUID()])
    const indexes = await database.query('SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2', [schema, 'notification_inbox'])
    for (const provider of ['email', 'push']) {
      expect(indexes.some(({ indexdef }: { indexdef: string }) => indexdef.includes(`("${provider}AvailableAt", "receivedAt")`) && ['pending', 'retry', 'deferred'].every(state => indexdef.includes(`'${state}'`)) && indexdef.includes(`"${provider}State"`))).toBe(true)
    }
  } finally { await runner.release() }
})
