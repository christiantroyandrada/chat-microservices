import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm'

export enum NotificationType {
  MESSAGE = 'message',
  SYSTEM = 'system',
  ALERT = 'alert'
}

@Entity('notifications')
@Index(['userId', 'createdAt'])
@Index(['userId', 'read'])
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ type: 'varchar', length: 255 })
  @Index()
  userId: string

  @Column({
    type: 'enum',
    enum: NotificationType
  })
  type: NotificationType

  @Column({ type: 'varchar', length: 255 })
  title: string

  @Column({ type: 'text' })
  message: string

  @Column({ type: 'boolean', default: false })
  @Index()
  read: boolean

  @CreateDateColumn()
  createdAt: Date

  @UpdateDateColumn()
  updatedAt: Date
}

export default Notification