import { Request, Response, NextFunction } from 'express'
import { AppDataSource, Prekey } from '../database'
import { APIError } from '../utils'

/**
 * Publish prekey: requires authentication. The router should attach the
 * `authenticated` middleware and this handler will derive the publisher userId
 * from `req.user.id` to avoid spoofing.
 */
const publishPrekey = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const publisherId = req.user?.id as string | undefined
    const { deviceId, bundle } = req.body as { deviceId?: string; bundle?: any }
    if (!publisherId) throw new APIError(401, 'Authentication required')
    if (!deviceId || !bundle) throw new APIError(400, 'deviceId and bundle are required')

    const prekeyRepo = AppDataSource.getRepository(Prekey)

    // Upsert by userId + deviceId
    let existing = await prekeyRepo.findOne({ where: { userId: publisherId, deviceId } })
    if (existing) {
      existing.bundle = bundle
      await prekeyRepo.save(existing)
      return res.json({ status: 200, message: 'Prekey bundle updated' })
    }

    const record = prekeyRepo.create({ userId: publisherId, deviceId, bundle })
    await prekeyRepo.save(record)

    return res.json({ status: 200, message: 'Prekey bundle published' })
  } catch (error) {
    next(error)
  }
}

/**
 * Get prekey bundle: this should be public so initiators can bootstrap sessions.
 * We implement atomic one-time-prekey consumption using a QueryRunner transaction
 * and SELECT FOR UPDATE semantics to avoid racing consumers returning the same
 * one-time prekey.
 */
const getPrekeyBundle = async (req: Request, res: Response, next: NextFunction) => {
  const userId = req.params.userId
  if (!userId) return next(new APIError(400, 'userId is required'))

  const qr = AppDataSource.createQueryRunner()
  await qr.connect()
  await qr.startTransaction()
  try {
    const repo = qr.manager.getRepository(Prekey)

    // Lock candidate rows for update to avoid concurrent consumption
    const bundles = await repo
      .createQueryBuilder('p')
      .where('p.userId = :userId', { userId })
      .orderBy('p.createdAt', 'ASC')
      .setLock('pessimistic_write')
      .getMany()

    if (!bundles || bundles.length === 0) {
      await qr.commitTransaction()
      return next(new APIError(404, 'No prekey bundle found for user'))
    }

    // Prefer a bundle that has at least one one-time prekey
    let chosen = bundles.find((b) => Array.isArray(b.bundle?.preKeys) && b.bundle.preKeys.length > 0) || bundles[0]

    if (Array.isArray(chosen.bundle?.preKeys) && chosen.bundle.preKeys.length > 0) {
      // consume the first one-time prekey
      const consumed = chosen.bundle.preKeys.shift()
      // persist updated bundle
      await repo.save(chosen)
      await qr.commitTransaction()
      return res.json({ status: 200, data: { userId: chosen.userId, deviceId: chosen.deviceId, bundle: chosen.bundle } })
    }

    // No one-time prekeys available; return the bundle without consuming
    await qr.commitTransaction()
    return res.json({ status: 200, data: { userId: chosen.userId, deviceId: chosen.deviceId, bundle: chosen.bundle } })
  } catch (error) {
    try {
      await qr.rollbackTransaction()
    } catch (e) {
      // ignore
    }
    next(error)
  } finally {
    await qr.release()
  }
}

export default {
  publishPrekey,
  getPrekeyBundle,
}
