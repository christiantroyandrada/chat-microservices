import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm'

export enum MessageStatus {
  NotDelivered = 'NotDelivered',
  Delivered = 'Delivered',
  Seen = 'Seen',
}

@Entity('messages')
@Index(['senderId', 'receiverId']) // Composite index for conversation queries
@Index(['senderId']) // Index for sender queries
@Index(['receiverId']) // Index for receiver queries
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ type: 'varchar', length: 255 })
  senderId: string

  @Column({ type: 'varchar', length: 255 })
  receiverId: string

  @Column({ type: 'text' })
  message: string

  @Column({ type: 'boolean', default: false })
  isEncrypted: boolean

  @Column({
    type: 'enum',
    enum: MessageStatus,
    default: MessageStatus.NotDelivered
  })
  status: MessageStatus

  @CreateDateColumn()
  createdAt: Date

  @UpdateDateColumn()
  updatedAt: Date
}

export default Message