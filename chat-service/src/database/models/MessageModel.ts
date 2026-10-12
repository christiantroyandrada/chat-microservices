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
@Index('IDX_messages_sender_client_message', ['senderId', 'clientMessageId'], {
  unique: true,
  where: '"clientMessageId" IS NOT NULL',
})
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ type: 'varchar', length: 255 })
  senderId: string

  @Column({ type: 'varchar', length: 255 })
  receiverId: string

  @Column({ type: 'text' })
  message: string

  @Column({ type: 'uuid', nullable: true })
  clientMessageId: string | null

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
