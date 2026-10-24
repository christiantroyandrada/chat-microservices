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
}
