import { Repository } from 'typeorm'
import { AppDataSource, Prekey } from '../database'
import type { EncryptedKeyBundle, PrekeyBundle, StoredBundle } from '../types'

export type StoreBackupResult = { created: boolean; hoursRemaining?: number }

const ADVISORY_LOCK_SQL = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))'

// Serializes the publish/backup race for one (userId, deviceId) pair. The
// advisory transaction lock covers the absent-row case (no row to lock yet);
// the pessimistic write lock then pins the existing row. The lock releases
// with commit/rollback, so release() only frees the connection.
export class PrekeyMutationService {
  private async mutate<T>(userId: string, deviceId: string, work: (repo: Repository<Prekey>) => Promise<T>): Promise<T> {
    const qr = AppDataSource.createQueryRunner()
    await qr.connect()
    await qr.startTransaction()
    let result: T
    try {
      await qr.query(ADVISORY_LOCK_SQL, [`prekey:${userId}:${deviceId}`])
      const repo = qr.manager.getRepository(Prekey)
      result = await work(repo)
      await qr.commitTransaction()
    } catch (primary) {
      try {
        await qr.rollbackTransaction()
      } catch {
        // Cleanup already failed: the primary error below is the one that matters.
      }
      try {
        await qr.release()
      } catch {
        // Same: never let a failed release mask the primary error.
      }
      throw primary
    }
    await qr.release()
    return result
  }

  async publish(userId: string, deviceId: string, bundle: PrekeyBundle): Promise<{ created: boolean }> {
    return this.mutate(userId, deviceId, async (repo) => {
      const existing = await repo.findOne({ where: { userId, deviceId }, lock: { mode: 'pessimistic_write' } })
      if (existing) {
        // Merge published fields so the backup half written by storeBackup survives a republish.
        const current = ((existing.bundle as unknown) as Record<string, unknown>) || {}
        existing.bundle = { ...current, ...(bundle as unknown as Record<string, unknown>) } as StoredBundle
        await repo.save(existing)
        return { created: false }
      }
      await repo.save(repo.create({ userId, deviceId, bundle }))
      return { created: true }
    })
  }

  async storeBackup(
    userId: string,
    deviceId: string,
    bundle: EncryptedKeyBundle,
    now?: Date,
  ): Promise<StoreBackupResult> {
    return this.mutate(userId, deviceId, async (repo) => {
      const existing = await repo.findOne({ where: { userId, deviceId }, lock: { mode: 'pessimistic_write' } })
      // Evaluated inside the locked transaction so concurrent backups cannot both pass.
      const at = now ?? new Date()
      if (!existing) {
        await repo.save(repo.create({ userId, deviceId, bundle: { _encryptedKeyBundle: bundle }, lastBackupTimestamp: at }))
        return { created: true }
      }
      if (existing.lastBackupTimestamp) {
        const hoursSince = (at.getTime() - existing.lastBackupTimestamp.getTime()) / (1000 * 60 * 60)
        if (hoursSince < 24) {
          return { created: false, hoursRemaining: Math.ceil(24 - hoursSince) }
        }
      }
      // Merge the backup half so published prekeys survive a re-backup.
      existing.bundle = { ...(existing.bundle as Record<string, unknown>), _encryptedKeyBundle: bundle } as StoredBundle
      existing.lastBackupTimestamp = at
      await repo.save(existing)
      return { created: false }
    })
  }
}
