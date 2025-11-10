import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm'

@Entity('prekeys')
export class Prekey {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ type: 'varchar', length: 255 })
  userId: string

  @Column({ type: 'varchar', length: 255 })
  deviceId: string

  // Store the bundle as JSON (Postgres JSONB)
  @Column({ type: 'json' })
  bundle: any

  @CreateDateColumn()
  createdAt: Date

  @UpdateDateColumn()
  updatedAt: Date
}

export default Prekey
