import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm'
import type { StoredBundle } from '../../types'

@Entity('prekeys')
@Index('IDX_prekeys_user_device', ['userId', 'deviceId'], { unique: true })
export class Prekey {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ type: 'varchar', length: 255 })
  userId: string

  @Column({ type: 'varchar', length: 255 })
  deviceId: string

  // Store the bundle as PostgreSQL JSON.
  // StoredBundle is either a full PrekeyBundle or an encrypted-only backup blob
  @Column({ type: 'json' })
  bundle: StoredBundle

  // Track last backup time for rate limiting (CVE-008)
  @Column({ type: 'timestamp', nullable: true })
  lastBackupTimestamp?: Date

  @CreateDateColumn()
  createdAt: Date

  @UpdateDateColumn()
  updatedAt: Date
}

export default Prekey
