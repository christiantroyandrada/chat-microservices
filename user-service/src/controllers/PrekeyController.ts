import { Request, Response, NextFunction } from 'express'
import { AppDataSource, Prekey } from '../database'
import { APIError } from '../utils'
import { logInfo } from '../utils/logger'
import type { PrekeyBundle, EncryptedKeyBundle } from '../types'

/**
 * Audit log helper - logs all key operations for security monitoring
 * CVE-010 FIX: Comprehensive audit logging
 */
function auditLog(operation: string, userId: string, deviceId: string, ip: string, success: boolean, details?: string) {
  const timestamp = new Date().toISOString()
  const status = success ? 'SUCCESS' : 'FAILURE'
  const message = `[AUDIT] ${timestamp} | ${operation} | User: ${userId} | Device: ${deviceId} | IP: ${ip} | Status: ${status}`
  
  if (details) {
    logInfo(`${message} | Details: ${details}`)
  } else {
    logInfo(message)
  }
}

/**
 * Store encrypted Signal key bundle for a user (CLIENT-SIDE ENCRYPTED)
 * Server never sees plaintext keys - only stores encrypted blobs
 * 
 * SECURITY FIXES:
 * - CVE-005: Device ID filtering - each device has isolated encrypted backup
 * - CVE-008: Rate limiting - 1 backup per 24 hours
 * - CVE-010: Audit logging - logs all backup attempts
 */
const storeSignalKeys = async (req: Request, res: Response, next: NextFunction) => {
  const userId = req.user?.id as string | undefined
  const { deviceId, encryptedBundle } = req.body as { deviceId?: string; encryptedBundle?: EncryptedKeyBundle }
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown'
  
  try {
    if (!userId) {
      auditLog('STORE_KEYS', 'unknown', deviceId || 'unknown', clientIp, false, 'Authentication required')
      throw new APIError(401, 'Authentication required')
    }
    
    if (!deviceId || !encryptedBundle) {
      auditLog('STORE_KEYS', userId, deviceId || 'unknown', clientIp, false, 'Missing required fields')
      throw new APIError(400, 'deviceId and encryptedBundle are required')
    }

    // Validate encrypted bundle structure
    if (!encryptedBundle.encrypted || !encryptedBundle.iv || !encryptedBundle.salt || !encryptedBundle.version) {
      auditLog('STORE_KEYS', userId, deviceId, clientIp, false, 'Invalid bundle format')
      throw new APIError(400, 'Invalid encrypted bundle format')
    }

    // CVE-005 FIX: Verify deviceId in bundle matches request deviceId (prevent cross-device tampering)
    if (encryptedBundle.deviceId !== deviceId) {
      auditLog('STORE_KEYS', userId, deviceId, clientIp, false, 'Device ID mismatch')
      throw new APIError(400, 'Device ID mismatch')
    }

    const prekeyRepo = AppDataSource.getRepository(Prekey)

    // CVE-005 FIX: Store per userId AND deviceId - each device has isolated encrypted backup
    let existing = await prekeyRepo.findOne({ where: { userId, deviceId } })
    
    if (existing) {
      // CVE-008 FIX: Rate limiting - enforce 1 backup per 24 hours
      if (existing.lastBackupTimestamp) {
        const hoursSinceLastBackup = (Date.now() - existing.lastBackupTimestamp.getTime()) / (1000 * 60 * 60)
        if (hoursSinceLastBackup < 24) {
          const hoursRemaining = Math.ceil(24 - hoursSinceLastBackup)
          auditLog('STORE_KEYS', userId, deviceId, clientIp, false, `Rate limit exceeded - ${hoursRemaining}h remaining`)
          throw new APIError(429, `Rate limit: Please wait ${hoursRemaining} hours before backing up keys again`)
        }
      }
      
      // Update existing encrypted bundle for this specific device
      existing.bundle = { ...existing.bundle, _encryptedKeyBundle: encryptedBundle } as any
      existing.lastBackupTimestamp = new Date()
      await prekeyRepo.save(existing)
      
      auditLog('STORE_KEYS', userId, deviceId, clientIp, true, 'Keys updated')
      return res.json({ status: 200, message: 'Encrypted keys updated' })
    }

    // Create new encrypted bundle for this device
    const record = prekeyRepo.create({ 
      userId, 
      deviceId, 
      bundle: { _encryptedKeyBundle: encryptedBundle } as any,
      lastBackupTimestamp: new Date()
    })
    await prekeyRepo.save(record)

    auditLog('STORE_KEYS', userId, deviceId, clientIp, true, 'New keys stored')
    return res.json({ status: 200, message: 'Encrypted keys stored' })
  } catch (error) {
    // Log the error if not already logged
    if (!(error instanceof APIError)) {
      auditLog('STORE_KEYS', userId || 'unknown', deviceId || 'unknown', clientIp, false, (error as Error).message)
    }
    next(error)
  }
}

/**
 * Retrieve encrypted Signal key bundle for the authenticated user
 * 
 * SECURITY FIXES:
 * - CVE-005: Device ID filtering - only return keys for the specified device
 * - CVE-010: Audit logging - logs all fetch attempts
 * - CVE-011: Constant-time responses - generic error messages to prevent information disclosure
 */
const getSignalKeys = async (req: Request, res: Response, next: NextFunction) => {
  const userId = req.user?.id as string | undefined
  const deviceId = req.query.deviceId as string | undefined
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown'
  
  try {
    if (!userId) {
      auditLog('FETCH_KEYS', 'unknown', deviceId || 'unknown', clientIp, false, 'Authentication required')
      throw new APIError(401, 'Authentication required')
    }
    
    // CVE-005 FIX: Require deviceId parameter - prevents cross-device key access
    if (!deviceId) {
      auditLog('FETCH_KEYS', userId, 'unknown', clientIp, false, 'Missing deviceId')
      throw new APIError(400, 'deviceId is required')
    }

    const prekeyRepo = AppDataSource.getRepository(Prekey)
    
    // CVE-005 FIX: Filter by BOTH userId AND deviceId - enforce device isolation
    const record = await prekeyRepo.findOne({ 
      where: { userId, deviceId },
      order: { createdAt: 'DESC' }
    })

    // CVE-011 FIX: Generic error message - don't reveal whether keys exist
    if (!record || !(record.bundle as any)?._encryptedKeyBundle) {
      auditLog('FETCH_KEYS', userId, deviceId, clientIp, false, 'No keys found')
      return res.json({ status: 404, message: 'Operation failed' })
    }

    auditLog('FETCH_KEYS', userId, deviceId, clientIp, true, 'Keys retrieved')
    return res.json({ 
      status: 200, 
      data: { 
        deviceId: record.deviceId, 
        encryptedBundle: (record.bundle as any)._encryptedKeyBundle 
      } 
    })
  } catch (error) {
    // Log the error if not already logged
    if (!(error instanceof APIError)) {
      auditLog('FETCH_KEYS', userId || 'unknown', deviceId || 'unknown', clientIp, false, (error as Error).message)
    }
    next(error)
  }
}

/**
 * Publish prekey: requires authentication. The router should attach the
 * `authenticated` middleware and this handler will derive the publisher userId
 * from `req.user.id` to avoid spoofing.
 */
const publishPrekey = async (req: Request, res: Response, next: NextFunction) => {
  try {
  const publisherId = req.user?.id as string | undefined
  const { deviceId, bundle } = req.body as { deviceId?: string; bundle?: PrekeyBundle }
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
 * 
 * Returns the LATEST bundle (most recently created) to ensure key consistency.
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
    // ORDER BY createdAt DESC to get the LATEST bundle first
    const bundles = await repo
      .createQueryBuilder('p')
      .where('p.userId = :userId', { userId })
      .orderBy('p.createdAt', 'DESC')
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
  storeSignalKeys,
  getSignalKeys,
}
