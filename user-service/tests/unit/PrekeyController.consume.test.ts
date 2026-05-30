// Importing PrekeyController pulls in config which expects a JWT secret.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_which_is_long_enough_32_chars'

import PrekeyController from '../../src/controllers/PrekeyController'
import { AppDataSource } from '../../src/database'

function mockQueryRunner(record: any) {
  const saveSpy = jest.fn().mockResolvedValue(undefined)
  const qb: any = {
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([record]),
  }
  const repo: any = {
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    save: saveSpy,
  }
  const qr: any = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    manager: { getRepository: jest.fn().mockReturnValue(repo) },
  }
  jest.spyOn(AppDataSource, 'createQueryRunner').mockReturnValue(qr as any)
  return { saveSpy }
}

const recordWithPrekeys = () => ({
  userId: 'u1',
  deviceId: 'd1',
  bundle: {
    identityKey: 'idk',
    registrationId: 42,
    signedPreKey: { id: 7, publicKey: 'spk', signature: 'sig' },
    preKeys: [
      { id: 1, publicKey: 'pk1' },
      { id: 2, publicKey: 'pk2' },
    ],
  },
})

describe('PrekeyController.getPrekeyBundle — one-time prekey consumption', () => {
  afterEach(() => jest.restoreAllMocks())

  it('returns exactly one one-time prekey and persists the pool with it removed', async () => {
    const { saveSpy } = mockQueryRunner(recordWithPrekeys())
    const req: any = { params: { userId: 'u1' } }
    const res: any = { json: jest.fn() }
    const next = jest.fn()

    await PrekeyController.getPrekeyBundle(req, res, next)

    expect(next).not.toHaveBeenCalled()
    // Response contains a single one-time prekey, not the whole pool.
    const payload = res.json.mock.calls[0][0]
    expect(payload.data.bundle.preKeys).toHaveLength(1)

    // The stored pool was persisted with the consumed prekey removed (2 -> 1).
    expect(saveSpy).toHaveBeenCalledTimes(1)
    const persisted = saveSpy.mock.calls[0][0]
    expect(persisted.bundle.preKeys).toHaveLength(1)
    // The persisted remainder must not contain the prekey handed to the client.
    const handedOutId = payload.data.bundle.preKeys[0].id
    expect(persisted.bundle.preKeys.some((p: any) => p.id === handedOutId)).toBe(false)
  })

  it('does not persist when the pool is already empty', async () => {
    const emptyRecord = { ...recordWithPrekeys(), bundle: { ...recordWithPrekeys().bundle, preKeys: [] } }
    const { saveSpy } = mockQueryRunner(emptyRecord)
    const req: any = { params: { userId: 'u1' } }
    const res: any = { json: jest.fn() }
    const next = jest.fn()

    await PrekeyController.getPrekeyBundle(req, res, next)

    expect(saveSpy).not.toHaveBeenCalled()
    const payload = res.json.mock.calls[0][0]
    expect(payload.data.bundle.preKeys).toHaveLength(0)
  })
})
