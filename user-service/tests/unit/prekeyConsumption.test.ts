import { consumeOneTimePreKey } from '../../src/utils/prekeyConsumption'
import type { PrekeyBundle } from '../../src/types'

const baseBundle = (): PrekeyBundle => ({
  identityKey: 'idk',
  registrationId: 42,
  signedPreKey: { id: 7, publicKey: 'spk', signature: 'sig' },
  preKeys: [
    { id: 1, publicKey: 'pk1' },
    { id: 2, publicKey: 'pk2' },
    { id: 3, publicKey: 'pk3' },
  ],
})

describe('consumeOneTimePreKey', () => {
  it('consumes exactly one one-time prekey and returns a single-prekey client bundle', () => {
    const result = consumeOneTimePreKey(baseBundle())

    expect(result.consumed).toBe(true)
    expect(result.clientBundle.preKeys).toHaveLength(1)
    // identity material preserved
    expect(result.clientBundle.identityKey).toBe('idk')
    expect(result.clientBundle.registrationId).toBe(42)
    expect(result.clientBundle.signedPreKey).toEqual({ id: 7, publicKey: 'spk', signature: 'sig' })
    // stored bundle has the consumed prekey removed (3 -> 2)
    expect(result.storedBundle).not.toBeNull()
    expect(result.storedBundle!.preKeys).toHaveLength(2)
    // the consumed prekey is no longer in the stored remainder
    const consumedId = result.clientBundle.preKeys[0].id
    expect(result.storedBundle!.preKeys.some((p) => p.id === consumedId)).toBe(false)
  })

  it('hands out a DIFFERENT prekey on each sequential consume (no reuse)', () => {
    const first = consumeOneTimePreKey(baseBundle())
    // feed the decremented stored bundle back in, as the controller will persist it
    const second = consumeOneTimePreKey(first.storedBundle!)

    expect(first.clientBundle.preKeys[0].id).not.toBe(second.clientBundle.preKeys[0].id)
    expect(second.storedBundle!.preKeys).toHaveLength(1)
  })

  it('does not leak the full prekey pool to the client', () => {
    const result = consumeOneTimePreKey(baseBundle())
    // client must never receive more than the single consumed one-time prekey
    expect(result.clientBundle.preKeys.length).toBeLessThanOrEqual(1)
  })

  it('reports exhaustion when no one-time prekeys remain', () => {
    const empty: PrekeyBundle = { ...baseBundle(), preKeys: [] }
    const result = consumeOneTimePreKey(empty)

    expect(result.consumed).toBe(false)
    expect(result.storedBundle).toBeNull()
    expect(result.clientBundle.preKeys).toHaveLength(0)
    // identity material still returned so X3DH can proceed without a one-time prekey
    expect(result.clientBundle.identityKey).toBe('idk')
  })

  it('treats an encrypted-only backup blob as having no consumable prekeys', () => {
    const encryptedOnly = { _encryptedKeyBundle: { ciphertext: 'x', iv: 'y', salt: 'z' } } as any
    const result = consumeOneTimePreKey(encryptedOnly)
    expect(result.consumed).toBe(false)
    expect(result.storedBundle).toBeNull()
  })
})
