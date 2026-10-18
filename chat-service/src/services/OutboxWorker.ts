import { randomUUID } from 'node:crypto'
import type { DataSource, EntityManager } from 'typeorm'
import { AppDataSource } from '../database/connection'
import { OutboxEventState } from '../database/models/OutboxEventModel'
import type { MessageReceivedEventPayload, NotificationPayload } from '../types'
import { enrichMessageReceivedPayload } from '../utils/messageHandler'
import { logError } from '../utils/logger'
import { RabbitMQService, rabbitMQService } from './RabbitMQService'

const BATCH_SIZE = 10
const LEASE_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 500
const MAX_BACKOFF_MS = 60_000
const DATABASE_OPERATION_TIMEOUT_MS = 5000

type ClaimedEvent = {
  id: string
  payload: MessageReceivedEventPayload
  attempts: number
  leaseToken: string
}

export class OutboxWorker {
  private running = false
  private timer?: NodeJS.Timeout
  private inFlight?: Promise<void>

  constructor(
    private readonly dataSource: DataSource = AppDataSource,
    private readonly publisher: Pick<RabbitMQService, 'publishNotification'> = rabbitMQService,
    private readonly enrich: (
      payload: MessageReceivedEventPayload,
    ) => Promise<NotificationPayload> = enrichMessageReceivedPayload,
  ) {}

  runOnce(): Promise<void> {
    if (this.inFlight) return this.inFlight
    const pending = this.processBatch().finally(() => {
      if (this.inFlight === pending) this.inFlight = undefined
    })
    this.inFlight = pending
    return pending
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.schedule(0)
  }

  async stop(): Promise<void> {
    if (!this.running && !this.timer && !this.inFlight) return
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    await this.inFlight
  }

  private schedule(delay: number): void {
    if (!this.running || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.runOnce()
        .catch(() => logError('[chat-service] Outbox poll failed'))
        .finally(() => {
          if (this.running) this.schedule(POLL_INTERVAL_MS)
        })
    }, delay)
    this.timer.unref?.()
  }

  private async processBatch(): Promise<void> {
    const events = await this.claimBatch()
    const results = await Promise.allSettled(events.map(event => this.processEvent(event)))
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed) throw failed.reason
  }

  private async claimBatch(): Promise<ClaimedEvent[]> {
    return this.transaction(async manager => {
      await manager.query("SET LOCAL statement_timeout = '5000ms'")
      const rows = await manager.query(`
        SELECT "id", "payload", "attempts"
        FROM "outbox_events"
        WHERE (
          "state" = $1 AND "availableAt" <= NOW()
        ) OR (
          "state" = $2 AND "lockedAt" <= NOW() - ($3 * INTERVAL '1 millisecond')
        )
        ORDER BY "createdAt"
        FOR UPDATE SKIP LOCKED
        LIMIT $4
      `, [
        OutboxEventState.Pending,
        OutboxEventState.Leased,
        LEASE_TIMEOUT_MS,
        BATCH_SIZE,
      ]) as Array<Omit<ClaimedEvent, 'leaseToken'>>

      const claimed: ClaimedEvent[] = []
      for (const row of rows) {
        const leaseToken = randomUUID()
        await manager.query(`
          UPDATE "outbox_events"
          SET "state" = $1, "attempts" = "attempts" + 1, "lockedAt" = NOW(),
              "leaseToken" = $2, "lastError" = NULL, "updatedAt" = NOW()
          WHERE "id" = $3
        `, [OutboxEventState.Leased, leaseToken, row.id])
        claimed.push({ ...row, attempts: row.attempts + 1, leaseToken })
      }
      return claimed
    })
  }

  private async processEvent(event: ClaimedEvent): Promise<void> {
    let failure = 'Recipient lookup failed'
    try {
      const notification = await this.enrich(event.payload)
      failure = 'Notification publish failed'
      await this.publisher.publishNotification(notification, event.id)
      await this.complete(event)
    } catch {
      await this.retry(event, failure)
    }
  }

  private async complete(event: ClaimedEvent): Promise<void> {
    await this.updateCurrentLease(`
      UPDATE "outbox_events"
      SET "state" = $1, "lockedAt" = NULL, "leaseToken" = NULL,
          "lastError" = NULL, "updatedAt" = NOW()
      WHERE "id" = $2 AND "state" = $3 AND "leaseToken" = $4
    `, [
      OutboxEventState.Published,
      event.id,
      OutboxEventState.Leased,
      event.leaseToken,
    ])
  }

  private async retry(event: ClaimedEvent, failure: string): Promise<void> {
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * (2 ** Math.min(event.attempts - 1, 6)))
    await this.updateCurrentLease(`
      UPDATE "outbox_events"
      SET "state" = $1, "availableAt" = $2, "lockedAt" = NULL,
          "leaseToken" = NULL, "lastError" = $3, "updatedAt" = NOW()
      WHERE "id" = $4 AND "state" = $5 AND "leaseToken" = $6
    `, [
      OutboxEventState.Pending,
      new Date(Date.now() + delay),
      failure,
      event.id,
      OutboxEventState.Leased,
      event.leaseToken,
    ])
  }

  private async updateCurrentLease(sql: string, parameters: unknown[]): Promise<void> {
    await this.transaction(async (manager: EntityManager) => {
      await manager.query("SET LOCAL statement_timeout = '5000ms'")
      await manager.query(sql, parameters)
    })
  }

  private async transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    const runner = this.dataSource.createQueryRunner()
    let client: { end(): Promise<void> } | undefined
    let timeout: NodeJS.Timeout | undefined
    let timedOut: Error | undefined
    let forcedClose: Promise<void> | undefined
    let workError: unknown
    try {
      client = await runner.connect() as { end(): Promise<void> }
      timeout = setTimeout(() => {
        timedOut = new Error('Outbox database operation timed out')
        try {
          forcedClose = client?.end().catch(() => undefined)
        } catch {
          forcedClose = Promise.resolve()
        }
      }, DATABASE_OPERATION_TIMEOUT_MS)
      timeout.unref?.()
      await runner.startTransaction()
      let result: T
      try {
        result = await work(runner.manager)
      } catch (error) {
        workError = error
        throw error
      }
      await runner.commitTransaction()
      return result
    } catch (error) {
      const failure = workError ?? timedOut ?? error
      if (runner.isTransactionActive) await runner.rollbackTransaction().catch(() => undefined)
      throw failure
    } finally {
      if (timeout) clearTimeout(timeout)
      if (forcedClose) await forcedClose
      await runner.release().catch(() => undefined)
    }
  }
}

export const outboxWorker = new OutboxWorker()
