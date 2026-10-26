import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm'

@Entity('notification_inbox')
export class NotificationInboxRecord {
  @PrimaryColumn({ type: 'text' })
  eventKey: string

  @Column({ type: 'jsonb' })
  canonical: Record<string, unknown>

  @Column({ type: 'jsonb', default: {} })
  advisory: Record<string, unknown>

  @CreateDateColumn({ type: 'timestamptz' })
  receivedAt: Date

  @Column({ type: 'text', default: 'pending' })
  emailState: 'pending' | 'retry' | 'deferred' | 'sent' | 'failed' | 'skipped'

  @Column({ type: 'text', default: 'pending' })
  pushState: 'pending' | 'retry' | 'deferred' | 'sent' | 'failed' | 'skipped'

  @Column({ type: 'integer', default: 0 })
  emailAttempts: number

  @Column({ type: 'integer', default: 0 })
  pushAttempts: number

  @Column({ type: 'timestamptz', default: () => 'now()' })
  emailAvailableAt: Date

  @Column({ type: 'timestamptz', default: () => 'now()' })
  pushAvailableAt: Date

  @Column({ type: 'varchar', length: 64, nullable: true })
  emailReason: string | null

  @Column({ type: 'varchar', length: 64, nullable: true })
  pushReason: string | null

  @Column({ type: 'uuid', nullable: true })
  deliveryLeaseToken: string | null

  @Column({ type: 'timestamptz', nullable: true })
  deliveryLockedAt: Date | null
}
