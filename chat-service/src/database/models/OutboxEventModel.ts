import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm'
import type { MessageReceivedEventPayload } from '../../types'

export enum OutboxEventState {
  Pending = 'pending',
  Leased = 'leased',
  Published = 'published',
}

@Entity('outbox_events')
@Index('IDX_outbox_events_state_available_at', ['state', 'availableAt'])
export class OutboxEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ type: 'jsonb' })
  payload: MessageReceivedEventPayload

  @Column({ type: 'enum', enum: OutboxEventState, default: OutboxEventState.Pending })
  state: OutboxEventState

  @Column({ type: 'integer', default: 0 })
  attempts: number

  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  availableAt: Date

  @Column({ type: 'timestamptz', nullable: true })
  lockedAt: Date | null

  @Column({ type: 'uuid', nullable: true })
  leaseToken: string | null

  @Column({ type: 'text', nullable: true })
  lastError: string | null

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date
}

export default OutboxEvent
