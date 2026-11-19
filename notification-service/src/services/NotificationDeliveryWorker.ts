import { randomUUID } from 'node:crypto'
import type { DataSource, EntityManager } from 'typeorm'
import { AppDataSource } from '../database/connection'
import { notificationTransaction } from '../database/notificationTransaction'
import config from '../config/config'
import { APP_URL, WELCOME_EMAIL_SUBJECT } from '../config/constants'
import { loadTemplate, renderTemplate } from './EmailTemplateService'
import { NotificationProvider, NotificationProviderBoundaryError, ProviderRequest, ProviderResult, validateProviderRequest } from './NotificationProvider'
import { logError } from '../utils/logger'

type Provider = 'email' | 'push'
type Event = { eventKey: string; deliveryLeaseToken: string }
type Receipt = Event & {
  canonical: Record<string, unknown>; advisory: Record<string, unknown>; deliveryLockedAt: Date
  emailState: string; pushState: string; emailAttempts: number; pushAttempts: number
  emailAvailableAt: Date; pushAvailableAt: Date
}
type Reservation = { request: ProviderRequest; advisory: Record<string, unknown>; state: string; attempt: number }
const ACTIVE = ['pending', 'retry', 'deferred']
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)

export class NotificationDeliveryWorker {
  private running = false
  private stopped = false
  private timer?: NodeJS.Timeout
  private inFlight?: Promise<void>

  constructor(
    private readonly database: DataSource = AppDataSource,
    private readonly provider: Pick<NotificationProvider, 'dispatch'> = new NotificationProvider(),
  ) {}

  runOnce(): Promise<void> {
    if (this.inFlight) return this.inFlight
    if (this.stopped) return Promise.resolve()
    const pending = this.processBatch().finally(() => { if (this.inFlight === pending) this.inFlight = undefined })
    this.inFlight = pending
    return pending
  }

  start(): void {
    if (this.running || this.stopped) return
    this.running = true
    this.schedule(0)
  }

  isHealthy(): boolean { return this.running && !this.stopped }

  async stop(): Promise<void> {
    this.stopped = true
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    await this.inFlight
  }

  private schedule(delay: number): void {
    if (!this.running || this.timer || this.stopped) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.runOnce().catch(() => logError('[notification-service] Delivery poll failed')).finally(() => this.schedule(500))
    }, delay)
    this.timer.unref?.()
  }

  private async processBatch(): Promise<void> {
    const events = await this.claimBatch()
    const outcomes = await Promise.allSettled(events.map(event => this.processEvent(event)))
    const failed = outcomes.find((value): value is PromiseRejectedResult => value.status === 'rejected')
    if (failed) throw failed.reason
  }

  private async claimBatch(): Promise<Event[]> {
    if (this.stopped) return []
    return this.transaction(async manager => {
      const rows: Array<{ eventKey: string }> = await manager.query(`SELECT "eventKey" FROM notification_inbox
        WHERE (("emailState" IN ('pending','retry','deferred') AND "emailAvailableAt" <= clock_timestamp())
          OR ("pushState" IN ('pending','retry','deferred') AND "pushAvailableAt" <= clock_timestamp()))
          AND ("deliveryLeaseToken" IS NULL OR "deliveryLockedAt" <= clock_timestamp() - interval '60 seconds')
        ORDER BY "receivedAt" FOR UPDATE SKIP LOCKED LIMIT 2`)
      const events: Event[] = []
      for (const row of rows) {
        const deliveryLeaseToken = randomUUID()
        await manager.query('UPDATE notification_inbox SET "deliveryLeaseToken" = $2, "deliveryLockedAt" = clock_timestamp() WHERE "eventKey" = $1', [row.eventKey, deliveryLeaseToken])
        events.push({ eventKey: row.eventKey, deliveryLeaseToken })
      }
      return events
    })
  }

  private async processEvent(event: Event): Promise<void> {
    let uncertain = false
    try {
      for (const provider of ['email', 'push'] as const) {
        if (this.stopped) break
        const reservation = await this.reserve(event, provider)
        if (!reservation) continue
        if (this.stopped) {
          await this.refund(event, provider, reservation)
          break
        }
        let result: ProviderResult
        try {
          result = await this.provider.dispatch(reservation.request)
        } catch (error) {
          if (error instanceof NotificationProviderBoundaryError) {
            if (error.code === 'PROVIDER_CAPACITY') {
              await this.refund(event, provider, reservation)
              break
            }
            uncertain = true
            this.stopped = true
            this.running = false
            if (this.timer) clearTimeout(this.timer)
            this.timer = undefined
            throw error
          }
          result = { status: 'retry', attempt: 'unknown', reason: 'child_failed' }
        }
        if (!await this.complete(event, provider, reservation, result)) { uncertain = true; break }
      }
    } catch (error) {
      uncertain = true
      throw error
    } finally {
      if (!uncertain) await this.locked(event, async manager => {
        await manager.query('UPDATE notification_inbox SET "deliveryLeaseToken" = NULL, "deliveryLockedAt" = NULL WHERE "eventKey" = $1 AND "deliveryLeaseToken" = $2', [event.eventKey, event.deliveryLeaseToken])
      })
    }
  }

  private async reserve(event: Event, provider: Provider): Promise<Reservation | undefined> {
    return this.locked(event, async (manager, row, now) => {
      const state = row[`${provider}State`]
      const attempt = row[`${provider}Attempts`]
      if (this.stopped || !ACTIVE.includes(state) || row[`${provider}AvailableAt`].getTime() > now.getTime()) return undefined
      let policy: { state: string; reason: string } | undefined
      if (attempt >= 8) policy = { state: 'failed', reason: 'attempt_limit' }
      else if (provider === 'push' && row.canonical.type === 'USER_REGISTERED') policy = { state: 'skipped', reason: 'registration_push' }
      else if (provider === 'email' && row.canonical.type === 'MESSAGE_RECEIVED' && row.advisory.recipientOnline === true) policy = { state: 'skipped', reason: 'recipient_online' }
      else if (!row.advisory[provider === 'email' ? 'userEmail' : 'userToken']) policy = { state: 'deferred', reason: 'missing_destination' }
      let request: ProviderRequest | undefined
      if (!policy) {
        if (provider === 'email') {
          const welcome = row.canonical.type === 'USER_REGISTERED'
          const template = loadTemplate(welcome ? 'welcome.html' : 'message.html')
          if (!template) policy = { state: 'deferred', reason: 'template_unavailable' }
          else {
            const subject = welcome ? WELCOME_EMAIL_SUBJECT : `New message from ${row.canonical.fromName || 'Unknown'}`
            const body = row.canonical.isEncrypted ? 'You have a new encrypted message. Open the app to view it.' : String(row.canonical.message)
            request = { provider: 'email', to: row.advisory.userEmail as string, subject, html: renderTemplate(template, {
              TITLE: escapeHtml(subject), BODY: escapeHtml(body), APP_URL, YEAR: String(new Date().getFullYear()),
              EMAIL_FROM: config.EMAIL_FROM || 'notifications@chat-app',
            }) }
          }
        } else request = { provider: 'push', token: row.advisory.userToken as string, message: row.canonical.message as string, ...(row.canonical.isEncrypted ? { envelope: row.canonical.envelope as string } : {}) }
        if (request) {
          try { request = validateProviderRequest(request) }
          catch { policy = { state: 'failed', reason: 'invalid_payload' } }
        }
      }
      if (policy) {
        await manager.query(`UPDATE notification_inbox SET "${provider}State" = $3, "${provider}Reason" = $4,
          "${provider}AvailableAt" = CASE WHEN $3 = 'deferred' THEN clock_timestamp() + interval '5 minutes' ELSE "${provider}AvailableAt" END
          WHERE "eventKey" = $1 AND "deliveryLeaseToken" = $2`, [event.eventKey, event.deliveryLeaseToken, policy.state, policy.reason])
        return undefined
      }
      await manager.query(`UPDATE notification_inbox SET "${provider}Attempts" = "${provider}Attempts" + 1,
        "deliveryLockedAt" = clock_timestamp() WHERE "eventKey" = $1 AND "deliveryLeaseToken" = $2`, [event.eventKey, event.deliveryLeaseToken])
      return { request: request!, state, attempt: attempt + 1, advisory: row.advisory }
    })
  }

  private async refund(event: Event, provider: Provider, reservation: Reservation): Promise<void> {
    await this.locked(event, async (manager, row) => {
      if (row[`${provider}State`] !== reservation.state || row[`${provider}Attempts`] !== reservation.attempt) return
      await manager.query(`UPDATE notification_inbox SET "${provider}Attempts" = "${provider}Attempts" - 1 WHERE "eventKey" = $1 AND "deliveryLeaseToken" = $2`, [event.eventKey, event.deliveryLeaseToken])
    })
  }

  private async complete(event: Event, provider: Provider, reservation: Reservation, result: ProviderResult): Promise<boolean> {
    return await this.locked(event, async (manager, row) => {
      if (row[`${provider}State`] !== reservation.state || row[`${provider}Attempts`] !== reservation.attempt) return false
      const state = result.status === 'retry' && reservation.attempt >= 8 ? 'failed' : result.status
      const reason = result.status === 'sent' ? null : result.reason
      const delay = Math.min(60000, 1000 * 2 ** (reservation.attempt - 1))
      await manager.query(`UPDATE notification_inbox SET "${provider}State" = $3, "${provider}Reason" = $4,
        "${provider}Attempts" = "${provider}Attempts" - CASE WHEN $3 = 'deferred' THEN 1 ELSE 0 END,
        "${provider}AvailableAt" = CASE
          WHEN $3 = 'deferred' THEN CASE WHEN advisory = $6::jsonb THEN clock_timestamp() + interval '5 minutes' ELSE clock_timestamp() END
          WHEN $3 = 'retry' THEN clock_timestamp() + ($5 * interval '1 millisecond') ELSE "${provider}AvailableAt" END
        WHERE "eventKey" = $1 AND "deliveryLeaseToken" = $2`, [event.eventKey, event.deliveryLeaseToken, state, reason, delay, JSON.stringify(reservation.advisory)])
      return true
    }) ?? false
  }

  private async locked<T>(event: Event, work: (manager: EntityManager, row: Receipt, now: Date) => Promise<T>): Promise<T | undefined> {
    return this.transaction(async manager => {
      const [row] = await manager.query('SELECT * FROM notification_inbox WHERE "eventKey" = $1 AND "deliveryLeaseToken" = $2 FOR UPDATE', [event.eventKey, event.deliveryLeaseToken]) as Receipt[]
      if (!row) return undefined
      const [{ now }] = await manager.query('SELECT clock_timestamp() AS now') as Array<{ now: Date }>
      if (row.deliveryLockedAt.getTime() <= now.getTime() - 60000) return undefined
      return work(manager, row, now)
    })
  }

  private transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    return notificationTransaction(this.database, work, 'Notification delivery database operation timed out')
  }
}
