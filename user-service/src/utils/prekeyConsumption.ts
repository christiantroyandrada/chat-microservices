import type { PrekeyBundle, StoredBundle } from '../types'

/**
 * Result of consuming one one-time prekey from a published bundle.
 *
 * `clientBundle` is what we return to the requesting initiator: identity
 * material plus AT MOST one one-time prekey. `storedBundle` is the bundle to
 * persist back with the consumed prekey removed (null when nothing was consumed).
 */
export interface PreKeyConsumptionResult {
  consumed: boolean
  clientBundle: PrekeyBundle
  storedBundle: PrekeyBundle | null
}

/**
 * Type guard: a stored bundle is a publishable PrekeyBundle (vs an encrypted
 * backup blob). Uses the `in` operator so no cast is needed — the only
 * StoredBundle member with `preKeys` is PrekeyBundle.
 */
export function isPrekeyBundle(b: StoredBundle): b is PrekeyBundle {
  return 'preKeys' in b
}

/**
 * X3DH one-time prekey consumption.
 *
 * Removes exactly one one-time prekey and returns it to the caller. This is the
 * core of forward secrecy: each initiator must receive a UNIQUE one-time prekey,
 * which is then deleted server-side so it is never handed out again.
 *
 * Pure function — no I/O. The caller persists `storedBundle` inside the same
 * transaction that locked the row. Callers must pass a real PrekeyBundle;
 * encrypted-only backup blobs are filtered out upstream (see PrekeyController).
 */
export function consumeOneTimePreKey(bundle: PrekeyBundle): PreKeyConsumptionResult {
  const identity = {
    identityKey: bundle.identityKey,
    registrationId: bundle.registrationId,
    signedPreKey: bundle.signedPreKey,
  }

  if (bundle.preKeys.length === 0) {
    // No one-time prekeys left. X3DH can still proceed (less ideal) using the
    // signed prekey only, so return identity material with an empty pool.
    return { consumed: false, clientBundle: { ...identity, preKeys: [] }, storedBundle: null }
  }

  const remaining = [...bundle.preKeys]
  const [consumed] = remaining.splice(0, 1)

  return {
    consumed: true,
    clientBundle: { ...identity, preKeys: [consumed] },
    // Reassign a fresh object so TypeORM detects the JSON column as changed.
    storedBundle: { ...bundle, preKeys: remaining },
  }
}
