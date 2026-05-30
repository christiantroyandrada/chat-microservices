import type { PrekeyBundle, StoredBundle } from '../types'

/**
 * Result of attempting to consume one one-time prekey from a stored bundle.
 *
 * `clientBundle` is what we return to the requesting initiator: the identity
 * material plus AT MOST one one-time prekey. `storedBundle` is the bundle to
 * persist back with the consumed prekey removed (null when nothing was consumed).
 */
export interface PreKeyConsumptionResult {
  consumed: boolean
  clientBundle: PrekeyBundle
  storedBundle: PrekeyBundle | null
}

function isPrekeyBundle(b: StoredBundle): b is PrekeyBundle {
  return Array.isArray((b as PrekeyBundle)?.preKeys)
}

/**
 * X3DH one-time prekey consumption.
 *
 * Removes exactly one one-time prekey from the stored bundle and returns it to
 * the caller. This is the core of forward secrecy: each initiator must receive a
 * UNIQUE one-time prekey, and that prekey must then be deleted from the server so
 * it is never handed out again.
 *
 * Pure function — no I/O. The caller is responsible for persisting `storedBundle`
 * inside the same transaction that locked the row.
 */
export function consumeOneTimePreKey(bundle: StoredBundle): PreKeyConsumptionResult {
  if (!isPrekeyBundle(bundle) || bundle.preKeys.length === 0) {
    // No one-time prekeys available. X3DH can still proceed (less ideal) using
    // only the signed prekey, so return identity material with an empty pool.
    const clientBundle: PrekeyBundle = isPrekeyBundle(bundle)
      ? {
          identityKey: bundle.identityKey,
          registrationId: bundle.registrationId,
          signedPreKey: bundle.signedPreKey,
          preKeys: [],
        }
      : // Encrypted-only backup blob — nothing consumable; surface as-is.
        (bundle as unknown as PrekeyBundle)
    return { consumed: false, clientBundle, storedBundle: null }
  }

  const remaining = [...bundle.preKeys]
  const [consumed] = remaining.splice(0, 1)

  const clientBundle: PrekeyBundle = {
    identityKey: bundle.identityKey,
    registrationId: bundle.registrationId,
    signedPreKey: bundle.signedPreKey,
    preKeys: [consumed],
  }

  // Reassign a fresh object so TypeORM detects the JSON column as changed.
  const storedBundle: PrekeyBundle = { ...bundle, preKeys: remaining }

  return { consumed: true, clientBundle, storedBundle }
}
