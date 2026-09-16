// Importing PrekeyController pulls in config which expects a JWT secret.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_which_is_long_enough_32_chars'

import type { Request, Response } from 'express'
import type { QueryRunner } from 'typeorm'
import PrekeyController from '../../src/controllers/PrekeyController'
import { AppDataSource } from '../../src/database'
import * as logger from '../../src/utils/logger'

interface TestPreKey {
  id: number
  publicKey: string
}

interface TestBundle {
  identityKey: string
  registrationId: number
  signedPreKey: { id: number; publicKey: string; signature: string }
  preKeys: TestPreKey[]
}

interface StoredRecord {
  userId: string
  deviceId: string
  bundle: TestBundle
}

interface MockOptions {
  bundles?: StoredRecord[] | null
  connectReject?: unknown
  startReject?: unknown
  getManyReject?: unknown
  saveReject?: unknown
  commitReject?: unknown
  rollbackReject?: unknown
  releaseReject?: unknown
  createThrow?: unknown
}

interface FakeHarness {
  qr: {
    connect: jest.Mock
    startTransaction: jest.Mock
    commitTransaction: jest.Mock
    rollbackTransaction: jest.Mock
    release: jest.Mock
    manager: { getRepository: jest.Mock }
  }
  saveSpy: jest.Mock
}

function mockQueryRunner(record: StoredRecord | null, opts: MockOptions = {}): FakeHarness {
  if (opts.createThrow !== undefined) {
    const err: unknown = opts.createThrow
    jest.spyOn(AppDataSource, 'createQueryRunner').mockImplementation(() => {
      throw err
    })
    const noop = jest.fn()
    return {
      qr: {
        connect: noop,
        startTransaction: noop,
        commitTransaction: noop,
        rollbackTransaction: noop,
        release: noop,
        manager: { getRepository: noop },
      },
      saveSpy: noop,
    }
  }
  const bundles: StoredRecord[] | null =
    opts.bundles !== undefined ? opts.bundles : record ? [record] : []
  const qb = {
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    getMany:
      opts.getManyReject !== undefined
        ? jest.fn().mockRejectedValue(opts.getManyReject)
        : jest.fn().mockResolvedValue(bundles),
  }
  const saveSpy =
    opts.saveReject !== undefined
      ? jest.fn().mockRejectedValue(opts.saveReject)
      : jest.fn().mockResolvedValue(undefined)
  const repo = {
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    save: saveSpy,
  }
  const qr = {
    connect:
      opts.connectReject !== undefined
        ? jest.fn().mockRejectedValue(opts.connectReject)
        : jest.fn().mockResolvedValue(undefined),
    startTransaction:
      opts.startReject !== undefined
        ? jest.fn().mockRejectedValue(opts.startReject)
        : jest.fn().mockResolvedValue(undefined),
    commitTransaction:
      opts.commitReject !== undefined
        ? jest.fn().mockRejectedValue(opts.commitReject)
        : jest.fn().mockResolvedValue(undefined),
    rollbackTransaction:
      opts.rollbackReject !== undefined
        ? jest.fn().mockRejectedValue(opts.rollbackReject)
        : jest.fn().mockResolvedValue(undefined),
    release:
      opts.releaseReject !== undefined
        ? jest.fn().mockRejectedValue(opts.releaseReject)
        : jest.fn().mockResolvedValue(undefined),
    manager: { getRepository: jest.fn().mockReturnValue(repo) },
  }
  jest.spyOn(AppDataSource, 'createQueryRunner').mockReturnValue(qr as unknown as QueryRunner)
  return { qr, saveSpy }
}

function mockReqRes(userId: string): { req: Request; res: Response; jsonSpy: jest.Mock } {
  const resHolder: { headersSent: boolean } = { headersSent: false }
  const jsonSpy = jest.fn((_body: unknown) => {
    resHolder.headersSent = true
    return undefined
  })
  const req = { params: { userId } } as unknown as Request
  const res = {
    json: jsonSpy,
    get headersSent(): boolean {
      return resHolder.headersSent
    },
  } as unknown as Response
  return { req, res, jsonSpy }
}

const recordWithPrekeys = (): StoredRecord => ({
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
    const { saveSpy, qr } = mockQueryRunner(recordWithPrekeys())
    const { req, res, jsonSpy } = mockReqRes('u1')
    const next = jest.fn()

    await PrekeyController.getPrekeyBundle(req, res, next)

    expect(next).not.toHaveBeenCalled()
    const payload = jsonSpy.mock.calls[0][0] as { data: { bundle: { preKeys: TestPreKey[] } } }
    expect(payload.data.bundle.preKeys).toHaveLength(1)

    expect(saveSpy).toHaveBeenCalledTimes(1)
    const persisted = saveSpy.mock.calls[0][0] as StoredRecord
    expect(persisted.bundle.preKeys).toHaveLength(1)
    const handedOutId = payload.data.bundle.preKeys[0].id
    expect(persisted.bundle.preKeys.some((p: TestPreKey) => p.id === handedOutId)).toBe(false)
    // persists before commit, commits before responding, releases once
    expect(saveSpy.mock.invocationCallOrder[0]).toBeLessThan(
      (qr.commitTransaction as jest.Mock).mock.invocationCallOrder[0],
    )
    expect((qr.commitTransaction as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      jsonSpy.mock.invocationCallOrder[0],
    )
    expect(jsonSpy.mock.invocationCallOrder[0]).toBeLessThan(
      (qr.release as jest.Mock).mock.invocationCallOrder[0],
    )
    expect(qr.release).toHaveBeenCalledTimes(1)
  })

  it('does not persist when the pool is already empty', async () => {
    const base = recordWithPrekeys()
    const emptyRecord: StoredRecord = { ...base, bundle: { ...base.bundle, preKeys: [] } }
    const { saveSpy, qr } = mockQueryRunner(emptyRecord)
    const { req, res, jsonSpy } = mockReqRes('u1')
    const next = jest.fn()

    await PrekeyController.getPrekeyBundle(req, res, next)

    expect(saveSpy).not.toHaveBeenCalled()
    const payload = jsonSpy.mock.calls[0][0] as { data: { bundle: { preKeys: TestPreKey[] } } }
    expect(payload.data.bundle.preKeys).toHaveLength(0)
    expect(qr.release).toHaveBeenCalledTimes(1)
  })

  it('createQueryRunner throw routes to next once without rollback or release', async () => {
    const createError = new Error('create boom')
    mockQueryRunner(null, { createThrow: createError })
    const { req, res } = mockReqRes('u1')
    const next = jest.fn()

    await PrekeyController.getPrekeyBundle(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(next.mock.calls[0][0]).toBe(createError)
  })

  it('connect rejection: original error identity, next once, no rollback, release once', async () => {
    const connectError = new Error('connect boom')
    const { qr } = mockQueryRunner(recordWithPrekeys(), { connectReject: connectError })
    const { req, res } = mockReqRes('u1')
    const next = jest.fn()

    await PrekeyController.getPrekeyBundle(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(next.mock.calls[0][0]).toBe(connectError)
    expect(qr.rollbackTransaction).not.toHaveBeenCalled()
    expect(qr.release).toHaveBeenCalledTimes(1)
    expect((qr.release as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (next as jest.Mock).mock.invocationCallOrder[0],
    )
  })

  it('startTransaction rejection: original error identity, next once, no rollback, release once', async () => {
    const startError = new Error('start boom')
    const { qr } = mockQueryRunner(recordWithPrekeys(), { startReject: startError })
    const { req, res } = mockReqRes('u1')
    const next = jest.fn()

    await PrekeyController.getPrekeyBundle(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(next.mock.calls[0][0]).toBe(startError)
    expect(qr.rollbackTransaction).not.toHaveBeenCalled()
    expect(qr.release).toHaveBeenCalledTimes(1)
  })

  it('query rejection after start: rollback once, release once, original error identity', async () => {
    const queryError = new Error('query boom')
    const { qr } = mockQueryRunner(recordWithPrekeys(), { getManyReject: queryError })
    const { req, res } = mockReqRes('u1')
    const next = jest.fn()

    await PrekeyController.getPrekeyBundle(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(next.mock.calls[0][0]).toBe(queryError)
    expect(qr.rollbackTransaction).toHaveBeenCalledTimes(1)
    expect(qr.release).toHaveBeenCalledTimes(1)
    expect((qr.rollbackTransaction as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (qr.release as jest.Mock).mock.invocationCallOrder[0],
    )
    expect((qr.release as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (next as jest.Mock).mock.invocationCallOrder[0],
    )
  })

  it('save rejection after start: rollback once, release once, original error identity', async () => {
    const saveError = new Error('save boom')
    const { qr, saveSpy } = mockQueryRunner(recordWithPrekeys(), { saveReject: saveError })
    const { req, res } = mockReqRes('u1')
    const next = jest.fn()

    await PrekeyController.getPrekeyBundle(req, res, next)

    expect(saveSpy).toHaveBeenCalledTimes(1)
    expect(next).toHaveBeenCalledTimes(1)
    expect(next.mock.calls[0][0]).toBe(saveError)
    expect(qr.rollbackTransaction).toHaveBeenCalledTimes(1)
    expect(qr.release).toHaveBeenCalledTimes(1)
    expect((qr.rollbackTransaction as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (qr.release as jest.Mock).mock.invocationCallOrder[0],
    )
    expect((qr.release as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (next as jest.Mock).mock.invocationCallOrder[0],
    )
  })

  it('commit rejection after start: rollback once, release once, original error identity', async () => {
    const commitError = new Error('commit boom')
    const { qr } = mockQueryRunner(recordWithPrekeys(), { commitReject: commitError })
    const { req, res, jsonSpy } = mockReqRes('u1')
    const next = jest.fn()

    await PrekeyController.getPrekeyBundle(req, res, next)

    expect(jsonSpy).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(1)
    expect(next.mock.calls[0][0]).toBe(commitError)
    expect(qr.rollbackTransaction).toHaveBeenCalledTimes(1)
    expect(qr.release).toHaveBeenCalledTimes(1)
    expect((qr.rollbackTransaction as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (qr.release as jest.Mock).mock.invocationCallOrder[0],
    )
    expect((qr.release as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (next as jest.Mock).mock.invocationCallOrder[0],
    )
  })

  it('rollback and release both rejecting: primary error identity, cleanup bounded once each', async () => {
    const primary = new Error('primary boom')
    const { qr } = mockQueryRunner(recordWithPrekeys(), {
      getManyReject: primary,
      rollbackReject: new Error('rollback boom'),
      releaseReject: new Error('release boom'),
    })
    const logSpy = jest.spyOn(logger, 'logError').mockImplementation(() => undefined)
    const { req, res } = mockReqRes('u1')
    const next = jest.fn()

    await PrekeyController.getPrekeyBundle(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(next.mock.calls[0][0]).toBe(primary)
    expect(qr.rollbackTransaction).toHaveBeenCalledTimes(1)
    expect(qr.release).toHaveBeenCalledTimes(1)
    expect(logSpy).toHaveBeenCalled()
  })

  it('release rejection on 404 path without earlier failure: next once with release error', async () => {
    const releaseError = new Error('release boom')
    const { qr } = mockQueryRunner(null, { bundles: [], releaseReject: releaseError })
    const { req, res, jsonSpy } = mockReqRes('u1')
    const next = jest.fn()

    await expect(PrekeyController.getPrekeyBundle(req, res, next)).resolves.toBeUndefined()

    expect(qr.release).toHaveBeenCalledTimes(1)
    expect(next).toHaveBeenCalledTimes(1)
    expect(next.mock.calls[0][0]).toBe(releaseError)
    expect(jsonSpy).not.toHaveBeenCalled()
  })

  it('release rejection after response sent: log sanitized failure, preserve response, no next', async () => {
    const { qr } = mockQueryRunner(recordWithPrekeys(), {
      releaseReject: new Error('release after send boom'),
    })
    const logSpy = jest.spyOn(logger, 'logError').mockImplementation(() => undefined)
    const { req, res, jsonSpy } = mockReqRes('u1')
    const next = jest.fn()

    await expect(PrekeyController.getPrekeyBundle(req, res, next)).resolves.toBeUndefined()

    expect(jsonSpy).toHaveBeenCalledTimes(1)
    expect(res.headersSent).toBe(true)
    expect(qr.release).toHaveBeenCalledTimes(1)
    expect(logSpy).toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })
})
