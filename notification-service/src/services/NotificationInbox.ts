import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { AppDataSource } from '../database/connection'
import { Notification, NotificationType } from '../database/models/NotificationModel'

export class PermanentNotificationError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const WELCOME = 'Thanks for registering. Welcome to Chat App!'

function string(value: unknown, limit: number, required = false): string | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || value.length > limit || /[\u0000\uD800-\uDFFF]/u.test(value) || (required && !value.trim())) {
    throw new PermanentNotificationError('Invalid notification field')
  }
  return value
}

function id(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !UUID.test(value)) throw new PermanentNotificationError('Invalid notification event ID')
  return value.toLowerCase()
}

function normalize(payload: unknown, messageId?: string) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new PermanentNotificationError('Invalid notification payload')
  const value = payload as Record<string, unknown>
  if (typeof value.type !== 'string' || !value.type) throw new PermanentNotificationError('Invalid notification type')
  if (value.type !== 'MESSAGE_RECEIVED' && value.type !== 'USER_REGISTERED') return undefined
  const payloadId = id(value.eventId)
  const brokerId = id(messageId)
  if (payloadId && brokerId && payloadId !== brokerId) throw new PermanentNotificationError('Notification event IDs disagree')
  const originalUserId = string(value.userId, 255, true)!
  const userId = UUID.test(originalUserId) ? originalUserId.toLowerCase() : originalUserId
  const advisory: Record<string, unknown> = {}
  for (const [field, limit] of [['userEmail', 320], ['userToken', 4096]] as const) {
    const supplied = string(value[field], limit)
    if (supplied !== undefined) advisory[field] = supplied
  }
  if (value.recipientOnline !== undefined) {
    if (typeof value.recipientOnline !== 'boolean') throw new PermanentNotificationError('Invalid recipient presence')
    advisory.recipientOnline = value.recipientOnline
  }
  if (value.type === 'USER_REGISTERED') {
    const message = string(value.message, 5000) || WELCOME
    return {
      eventKey: `registration:${userId}`, canonical: { type: value.type, userId, message }, advisory,
      notification: { userId, type: NotificationType.SYSTEM, title: 'Welcome to Chat App', message, read: false },
    }
  }
  if (value.isEncrypted !== undefined && typeof value.isEncrypted !== 'boolean') throw new PermanentNotificationError('Invalid encryption flag')
  const isEncrypted = value.isEncrypted === true
  const canonical: Record<string, unknown> = { type: value.type, userId, isEncrypted }
  for (const [field, limit] of [['senderId', 255], ['from', 320], ['fromName', 200]] as const) {
    const supplied = string(value[field], limit)
    if (supplied !== undefined) canonical[field] = field === 'senderId' && UUID.test(supplied) ? supplied.toLowerCase() : supplied
  }
  const suppliedMessage = string(value.message, 5000)
  if (value.envelope !== undefined) {
    if (typeof value.envelope !== 'string' && (!value.envelope || typeof value.envelope !== 'object' || Array.isArray(value.envelope))) {
      throw new PermanentNotificationError('Invalid notification envelope')
    }
    canonical.envelope = typeof value.envelope === 'string' ? value.envelope : JSON.stringify(value.envelope)
    string(canonical.envelope, 5000, true)
  }
  if (isEncrypted) {
    const envelope = canonical.envelope ?? suppliedMessage
    try {
      const parsed = JSON.parse(string(envelope, 5000, true)!)
      if (parsed?.__encrypted !== true || typeof parsed.body !== 'string') throw new Error('Invalid envelope')
    } catch { throw new PermanentNotificationError('Invalid encrypted notification envelope') }
    canonical.envelope = envelope
  }
  const message = isEncrypted ? '[Encrypted message]' : suppliedMessage || 'You have a new message'
  canonical.message = message
  // Unkeyed historical events cannot distinguish redelivery from another identical message.
  const eventKey = payloadId || brokerId ? `event:${payloadId || brokerId}` : `legacy:${randomUUID()}`
  return {
    eventKey, canonical, advisory,
    notification: { userId, type: NotificationType.MESSAGE, title: `New message from ${canonical.fromName || 'Unknown'}`, message, read: false },
  }
}

export class NotificationInbox {
  constructor(private readonly database: DataSource = AppDataSource) {}

  async accept(payload: unknown, messageId?: string): Promise<'inserted' | 'duplicate' | 'ignored'> {
    const event = normalize(payload, messageId)
    if (!event) return 'ignored'
    return this.database.transaction(async manager => {
      const inserted = await manager.query(`
        INSERT INTO notification_inbox ("eventKey", canonical, advisory)
        VALUES ($1, $2::jsonb, $3::jsonb)
        ON CONFLICT ("eventKey") DO NOTHING RETURNING "eventKey"
      `, [event.eventKey, JSON.stringify(event.canonical), JSON.stringify(event.advisory)])
      if (inserted.length) {
        await manager.getRepository(Notification).insert(event.notification)
        return 'inserted'
      }
      const [existing] = await manager.query('SELECT canonical = $2::jsonb AS matches FROM notification_inbox WHERE "eventKey" = $1', [event.eventKey, JSON.stringify(event.canonical)])
      if (!existing?.matches) throw new PermanentNotificationError('Notification event identity conflict')
      await manager.query(`UPDATE notification_inbox SET advisory = advisory || $2::jsonb,
        "emailAvailableAt" = CASE WHEN "emailState" = 'deferred' THEN NOW() ELSE "emailAvailableAt" END,
        "pushAvailableAt" = CASE WHEN "pushState" = 'deferred' THEN NOW() ELSE "pushAvailableAt" END
        WHERE "eventKey" = $1 AND advisory IS DISTINCT FROM (advisory || $2::jsonb)`, [event.eventKey, JSON.stringify(event.advisory)])
      return 'duplicate'
    })
  }
}

export const notificationInbox = new NotificationInbox()
