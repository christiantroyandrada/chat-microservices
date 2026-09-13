// Importing the service pulls in database config which expects a JWT secret.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_which_is_long_enough_32_chars'

import { AppDataSource } from '../../src/database'
import { PrekeyMutationService } from '../../src/services/PrekeyMutationService'

const userId = 'u1'
const deviceId = 'd1'
const lockId = `prekey:${userId}:${deviceId}`
const lockSQL = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))'

const published = {
  identityKey: 'idk',
  registrationId: 42,
  signedPreKey: { id: 7, publicKey: 'spk', signature: 'sig' },
  preKeys: [{ id: 1, publicKey: 'pk1' }],
}
const encrypted = { encrypted: 'ct', iv: 'iv', salt: 'salt', version: 1, deviceId }
const keyOf = (u: string, d: string) => `${u}:${d}`

type Hooks = {
  failConnect?: unknown
  failStartTransaction?: unknown
  failQuery?: unknown
  failFind?: unknown
  failSave?: unknown
  failCommit?: unknown
  failRollback?: unknown
  failRelease?: unknown
}

// Fake QueryRunner + repository over an in-memory row map. Each QueryRunner
// stages writes locally (visible to its own subsequent reads) and publishes to
// the shared map only on successful commit; rollback discards the staged rows.
// This models real transaction isolation: failed saves/commits leave shared
// bytes unchanged. The advisory-lock mutex behavior is unchanged.
function setup(store = new Map<string, any>(), hooks: Hooks = {}) {
  const order: string[] = []
  const staged = new Map<string, any>()
  const repo: any = {
    findOne: jest.fn(async (opts: any) => {
      order.push('findOne')
      if (hooks.failFind) throw hooks.failFind
      const k = keyOf(opts.where.userId, opts.where.deviceId)
      if (staged.has(k)) return staged.get(k)
      const row = store.get(k)
      return row === undefined ? row : structuredClone(row)
    }),
    create: jest.fn((v: any) => ({ ...v })),
    save: jest.fn(async (entity: any) => {
      order.push('save')
      if (hooks.failSave) throw hooks.failSave
      staged.set(keyOf(entity.userId, entity.deviceId), entity)
      return entity
    }),
  }
  const qr: any = {
    connect: jest.fn(async () => {
      order.push('connect')
      if (hooks.failConnect) throw hooks.failConnect
    }),
    startTransaction: jest.fn(async () => {
      order.push('startTransaction')
      if (hooks.failStartTransaction) throw hooks.failStartTransaction
    }),
    query: jest.fn(async (sql: string, params: any[]) => {
      order.push(`lock:${params?.[0]}`)
      if (hooks.failQuery) throw hooks.failQuery
      return []
    }),
    commitTransaction: jest.fn(async () => {
      order.push('commit')
      if (hooks.failCommit) throw hooks.failCommit
      for (const [k, v] of staged) store.set(k, v)
      staged.clear()
    }),
    rollbackTransaction: jest.fn(async () => {
      try {
        if (hooks.failRollback) throw hooks.failRollback
      } finally {
        staged.clear()
      }
    }),
    release: jest.fn(async () => {
      order.push('release')
      if (hooks.failRelease) throw hooks.failRelease
    }),
    manager: { getRepository: jest.fn(() => repo) },
  }
  const runnerSpy = jest.spyOn(AppDataSource, 'createQueryRunner').mockReturnValue(qr)
  return { store, order, repo, qr, runnerSpy }
}

describe('PrekeyMutationService', () => {
  afterEach(() => jest.restoreAllMocks())

  it('catches a non-transactional publish: creates the row in exact lock order', async () => {
    const { store, order, repo, qr, runnerSpy } = setup()
    const result = await new PrekeyMutationService().publish(userId, deviceId, published as any)

    expect(result).toEqual({ created: true })
    expect(runnerSpy).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['connect', 'startTransaction', `lock:${lockId}`, 'findOne', 'save', 'commit', 'release'])
    expect(qr.query).toHaveBeenCalledWith(lockSQL, [lockId])
    expect(repo.findOne).toHaveBeenCalledWith({
      where: { userId, deviceId },
      lock: { mode: 'pessimistic_write' },
    })
    expect(store.get(keyOf(userId, deviceId)).bundle).toEqual(published)
  })

  it('catches a backup-wiping publish: merges published fields while preserving _encryptedKeyBundle', async () => {
    const seed = { userId, deviceId, bundle: { identityKey: 'old', _encryptedKeyBundle: encrypted } }
    const { store, repo } = setup(new Map([[keyOf(userId, deviceId), seed]]))

    const result = await new PrekeyMutationService().publish(userId, deviceId, published as any)

    expect(result).toEqual({ created: false })
    expect(repo.save).toHaveBeenCalledTimes(1)
    expect(store.get(keyOf(userId, deviceId)).bundle).toEqual({ ...published, _encryptedKeyBundle: encrypted })
  })

  it('catches a backup-overwriting publish: conflicting caller _encryptedKeyBundle preserves the stored backup', async () => {
    const seed = { userId, deviceId, bundle: { identityKey: 'old', registrationId: 1, signedPreKey: { id: 1, publicKey: 'o', signature: 'o' }, preKeys: [{ id: 1, publicKey: 'o' }], _encryptedKeyBundle: encrypted } }
    const { store } = setup(new Map([[keyOf(userId, deviceId), seed]]))
    const hostile = { ...published, _encryptedKeyBundle: { encrypted: 'evil', iv: 'evil', salt: 'evil', version: 9, deviceId } }

    const result = await new PrekeyMutationService().publish(userId, deviceId, hostile as any)

    expect(result).toEqual({ created: false })
    expect(store.get(keyOf(userId, deviceId)).bundle).toEqual({ ...published, _encryptedKeyBundle: encrypted })
  })

  it('catches a backup-injecting publish: create never persists caller-supplied _encryptedKeyBundle', async () => {
    const { store } = setup()
    const hostile = { ...published, _encryptedKeyBundle: { encrypted: 'evil', iv: 'evil', salt: 'evil', version: 9, deviceId } }

    const result = await new PrekeyMutationService().publish(userId, deviceId, hostile as any)

    expect(result).toEqual({ created: true })
    expect(store.get(keyOf(userId, deviceId)).bundle).toEqual(published)
  })

  it('catches a lost backup write: creates the row with bundle and backup timestamp', async () => {
    const now = new Date('2026-09-01T00:00:00.000Z')
    const { store } = setup()
    const result = await new PrekeyMutationService().storeBackup(userId, deviceId, encrypted as any, now)

    expect(result).toEqual({ created: true })
    const row = store.get(keyOf(userId, deviceId))
    expect(row.bundle).toEqual({ _encryptedKeyBundle: encrypted })
    expect(row.lastBackupTimestamp).toEqual(now)
  })

  it('catches a publish-wiping backup: merges _encryptedKeyBundle while preserving published fields', async () => {
    const now = new Date('2026-09-01T00:00:00.000Z')
    const seed = { userId, deviceId, bundle: { ...published }, lastBackupTimestamp: new Date('2026-08-01T00:00:00.000Z') }
    const { store } = setup(new Map([[keyOf(userId, deviceId), seed]]))

    const result = await new PrekeyMutationService().storeBackup(userId, deviceId, encrypted as any, now)

    expect(result).toEqual({ created: false })
    const row = store.get(keyOf(userId, deviceId))
    expect(row.bundle).toEqual({ ...published, _encryptedKeyBundle: encrypted })
    expect(row.lastBackupTimestamp).toEqual(now)
  })

  it('catches a replayed backup: same timestamp twice throttles with 24 whole hours and no second write', async () => {
    const now = new Date('2026-09-01T00:00:00.000Z')
    const { store, repo } = setup()
    const svc = new PrekeyMutationService()

    expect(await svc.storeBackup(userId, deviceId, encrypted as any, now)).toEqual({ created: true })
    expect(await svc.storeBackup(userId, deviceId, encrypted as any, now)).toEqual({ created: false, hoursRemaining: 24 })

    expect(repo.save).toHaveBeenCalledTimes(1)
    expect(store.get(keyOf(userId, deviceId)).bundle).toEqual({ _encryptedKeyBundle: encrypted })
  })

  it.each([
    ['exactly 24h satisfies the throttle', '2026-08-31T00:00:00.000Z', false, undefined],
    ['23h59m stays throttled with 1 hour remaining', '2026-08-31T00:01:00.000Z', true, 1],
    ['12h ago reports 12 hours remaining', '2026-08-31T12:00:00.000Z', true, 12],
  ])('catches throttle miscalculation: %s', async (_label, lastBackup, throttled, hoursRemaining) => {
    const now = new Date('2026-09-01T00:00:00.000Z')
    const seed = { userId, deviceId, bundle: { _encryptedKeyBundle: encrypted }, lastBackupTimestamp: new Date(lastBackup) }
    const { repo } = setup(new Map([[keyOf(userId, deviceId), seed]]))

    const savesBefore = repo.save.mock.calls.length
    const result = await new PrekeyMutationService().storeBackup(userId, deviceId, encrypted as any, now)

    if (throttled) {
      expect(result).toEqual({ created: false, hoursRemaining })
      expect(repo.save.mock.calls.length).toBe(savesBefore)
    } else {
      expect(result).toEqual({ created: false })
      expect(repo.save.mock.calls.length).toBe(savesBefore + 1)
    }
  })

  it('catches a stale-clock backup: omitted now uses the current time for a 25h-old backup', async () => {
    const before = new Date()
    const seed = {
      userId, deviceId,
      bundle: { _encryptedKeyBundle: encrypted },
      lastBackupTimestamp: new Date(before.getTime() - 25 * 60 * 60 * 1000),
    }
    const { store } = setup(new Map([[keyOf(userId, deviceId), seed]]))

    const result = await new PrekeyMutationService().storeBackup(userId, deviceId, encrypted as any)

    expect(result).toEqual({ created: false })
    const stamped = store.get(keyOf(userId, deviceId)).lastBackupTimestamp as Date
    expect(stamped.getTime()).toBeGreaterThanOrEqual(before.getTime())
    expect(stamped.getTime()).toBeLessThanOrEqual(Date.now())
  })

  it.each([
    ['lock acquisition', { failQuery: new Error('fail:lock') }],
    ['locked row read', { failFind: new Error('fail:read') }],
    ['merge/save', { failSave: new Error('fail:save') }],
    ['commit', { failCommit: new Error('fail:commit') }],
  ])('catches a leaked transaction: %s failure rolls back, releases, and rethrows the primary error', async (_label, hooks) => {
    const seed = { userId, deviceId, bundle: { identityKey: 'old', registrationId: 1, signedPreKey: { id: 1, publicKey: 'o', signature: 'o' }, preKeys: [{ id: 9, publicKey: 'old' }] } }
    const { store, order, qr } = setup(new Map([[keyOf(userId, deviceId), seed]]), hooks as Hooks)
    const primary = Object.values(hooks)[0] as Error
    const before = JSON.stringify(store.get(keyOf(userId, deviceId)))

    await expect(new PrekeyMutationService().publish(userId, deviceId, published as any)).rejects.toThrow(primary.message)

    expect(qr.rollbackTransaction).toHaveBeenCalledTimes(1)
    expect(qr.release).toHaveBeenCalledTimes(1)
    expect(order[order.length - 1]).toBe('release')
    expect(JSON.stringify(store.get(keyOf(userId, deviceId)))).toBe(before)
  })

  it('catches swallowed cleanup: rollback failure still releases and preserves the primary error', async () => {
    const primary = new Error('fail:save')
    const { qr } = setup(new Map(), { failSave: primary, failRollback: new Error('fail:rollback') })

    await expect(new PrekeyMutationService().publish(userId, deviceId, published as any)).rejects.toThrow('fail:save')

    expect(qr.rollbackTransaction).toHaveBeenCalledTimes(1)
    expect(qr.release).toHaveBeenCalledTimes(1)
  })

  it('catches a lost primary error: release failure after a failed save still surfaces the save error', async () => {
    const { qr } = setup(new Map(), { failSave: new Error('fail:save'), failRelease: new Error('fail:release') })

    await expect(new PrekeyMutationService().publish(userId, deviceId, published as any)).rejects.toThrow('fail:save')

    expect(qr.rollbackTransaction).toHaveBeenCalledTimes(1)
    expect(qr.release).toHaveBeenCalledTimes(1)
  })

  it('catches a phantom write: commit failure leaves the shared row unchanged', async () => {
    const seed = { userId, deviceId, bundle: { identityKey: 'old', registrationId: 1, signedPreKey: { id: 1, publicKey: 'o', signature: 'o' }, preKeys: [{ id: 9, publicKey: 'old' }] } }
    const before = JSON.stringify(seed)
    const { store, qr } = setup(new Map([[keyOf(userId, deviceId), seed]]), { failCommit: new Error('fail:commit') })

    await expect(new PrekeyMutationService().publish(userId, deviceId, published as any)).rejects.toThrow('fail:commit')

    expect(qr.rollbackTransaction).toHaveBeenCalledTimes(1)
    expect(qr.release).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(store.get(keyOf(userId, deviceId)))).toBe(before)
  })

  it.each([
    ['connect', { failConnect: new Error('fail:connect') }],
    ['startTransaction', { failStartTransaction: new Error('fail:start') }],
  ])('catches a skipped cleanup: %s failure still rolls back, releases once, and rethrows without touching the repository', async (_label, hooks) => {
    const { store, order, repo, qr } = setup(new Map(), hooks as Hooks)
    const primary = Object.values(hooks)[0] as Error
    const bytesBefore = JSON.stringify([...store.entries()])

    // Identity, not message: cleanup must rethrow the original error instance.
    await expect(new PrekeyMutationService().publish(userId, deviceId, published as any)).rejects.toBe(primary)

    expect(qr.rollbackTransaction).toHaveBeenCalledTimes(1)
    expect(qr.release).toHaveBeenCalledTimes(1)
    expect(order[order.length - 1]).toBe('release')
    expect(repo.findOne).not.toHaveBeenCalled()
    expect(repo.save).not.toHaveBeenCalled()
    expect(qr.commitTransaction).not.toHaveBeenCalled()
    expect(JSON.stringify([...store.entries()])).toBe(bytesBefore)
  })

  it('catches a masked setup error: cleanup failures never hide the connect error', async () => {
    const primary = new Error('fail:connect')
    const { repo, qr } = setup(new Map(), {
      failConnect: primary,
      failRollback: new Error('fail:rollback'),
      failRelease: new Error('fail:release'),
    })

    await expect(new PrekeyMutationService().publish(userId, deviceId, published as any)).rejects.toBe(primary)

    expect(qr.rollbackTransaction).toHaveBeenCalledTimes(1)
    expect(qr.release).toHaveBeenCalledTimes(1)
    expect(repo.findOne).not.toHaveBeenCalled()
    expect(repo.save).not.toHaveBeenCalled()
    expect(qr.commitTransaction).not.toHaveBeenCalled()
  })

  it('catches a publish/backup race: interleaved writers serialize into one row with both bundle halves', async () => {
    const store = new Map<string, any>()
    const events: string[] = []
    const preCommit: number[] = []
    let locked = false
    const waiters: Array<() => void> = []
    const now = new Date('2026-09-01T00:00:00.000Z')

    const runnerFor = (tag: string) => {
      // Each runner stages its own writes: shared rows are cloned on read so
      // mutations cannot leak through aliasing, and saves stay invisible
      // until this runner successfully commits.
      const staged = new Map<string, any>()
      const repo: any = {
        findOne: jest.fn(async (opts: any) => {
          const k = keyOf(opts.where.userId, opts.where.deviceId)
          if (staged.has(k)) return staged.get(k)
          const row = store.get(k)
          return row === undefined ? row : structuredClone(row)
        }),
        create: jest.fn((v: any) => ({ ...v })),
        save: jest.fn(async (entity: any) => {
          events.push(`save:${tag}`)
          await new Promise((r) => setImmediate(r))
          staged.set(keyOf(entity.userId, entity.deviceId), entity)
          return entity
        }),
      }
      const qr: any = {
        connect: jest.fn().mockResolvedValue(undefined),
        startTransaction: jest.fn().mockResolvedValue(undefined),
        // Emulate pg_advisory_xact_lock: only one holder per lock id; the
        // mutex is held until that holder commits or rolls back.
        query: jest.fn(async (sql: string, params: any[]) => {
          expect(sql).toBe(lockSQL)
          expect(params).toEqual([lockId])
          if (locked) await new Promise<void>((r) => waiters.push(r))
          locked = true
          events.push(`lock:${tag}`)
        }),
        commitTransaction: jest.fn(async () => {
          // Observe shared state before publishing: the first committer must
          // not have leaked its saved row into the shared map yet.
          preCommit.push(store.size)
          for (const [k, v] of staged) store.set(k, v)
          staged.clear()
          events.push(`commit:${tag}`)
          locked = false
          waiters.shift()?.()
        }),
        rollbackTransaction: jest.fn(async () => {
          staged.clear()
          locked = false
          waiters.shift()?.()
        }),
        release: jest.fn().mockResolvedValue(undefined),
        manager: { getRepository: jest.fn(() => repo) },
      }
      return qr
    }

    const svc = new PrekeyMutationService()
    const publishSpy = jest.spyOn(AppDataSource, 'createQueryRunner')
    publishSpy.mockReturnValueOnce(runnerFor('publish')).mockReturnValueOnce(runnerFor('backup'))

    const [pubResult, backupResult] = await Promise.all([
      svc.publish(userId, deviceId, published as any),
      svc.storeBackup(userId, deviceId, encrypted as any, now),
    ])

    // Exactly one writer saw the absent row; the other merged into it.
    expect([pubResult.created, backupResult.created].sort()).toEqual([false, true])
    // Transaction isolation: the first writer's save stayed invisible until
    // its commit; the second committer then saw exactly one shared row.
    expect(preCommit).toEqual([0, 1])
    expect(store.size).toBe(1)
    const row = store.get(keyOf(userId, deviceId))
    expect(row.bundle).toEqual({ ...published, _encryptedKeyBundle: encrypted })
    expect(row.lastBackupTimestamp).toEqual(now)
    // The second lock is granted only after the first holder commits: locks and
    // commits strictly alternate, never overlap.
    const marks = events.filter((e) => e.startsWith('lock:') || e.startsWith('commit:'))
    expect(marks).toHaveLength(4)
    expect(marks[0].startsWith('lock:')).toBe(true)
    expect(marks[1].startsWith('commit:')).toBe(true)
    expect(marks[2].startsWith('lock:')).toBe(true)
    expect(marks[3].startsWith('commit:')).toBe(true)
    expect(marks[0].slice('lock:'.length)).toBe(marks[1].slice('commit:'.length))
    expect(marks[2].slice('lock:'.length)).toBe(marks[3].slice('commit:'.length))
  })

  it('catches a double backup: concurrent same-user/same-device backups serialize into one write and one 24h throttle', async () => {
    const store = new Map<string, any>()
    const now = new Date('2026-09-01T00:00:00.000Z')
    let locked = false
    const waiters: Array<() => void> = []
    const runners: any[] = []
    const runnerFor = (tag: string) => {
      const staged = new Map<string, any>()
      const repo: any = {
        findOne: jest.fn(async (opts: any) => {
          const k = keyOf(opts.where.userId, opts.where.deviceId)
          return staged.has(k) ? staged.get(k) : store.get(k)
        }),
        create: jest.fn((v: any) => ({ ...v })),
        save: jest.fn(async (entity: any) => {
          staged.set(keyOf(entity.userId, entity.deviceId), entity)
          return entity
        }),
      }
      const qr: any = {
        connect: jest.fn().mockResolvedValue(undefined),
        startTransaction: jest.fn().mockResolvedValue(undefined),
        query: jest.fn(async (sql: string, params: any[]) => {
          expect(sql).toBe(lockSQL)
          expect(params).toEqual([lockId])
          if (locked) await new Promise<void>((r) => waiters.push(r))
          locked = true
        }),
        commitTransaction: jest.fn(async () => {
          for (const [k, v] of staged) store.set(k, v)
          staged.clear()
          locked = false
          waiters.shift()?.()
        }),
        rollbackTransaction: jest.fn(async () => {
          staged.clear()
          locked = false
          waiters.shift()?.()
        }),
        release: jest.fn(async () => { /* release frees the connection; lock already freed by commit/rollback */ }),
        manager: { getRepository: jest.fn(() => repo) },
      }
      ;(qr as any).__tag = tag
      ;(qr as any).__repo = repo
      runners.push(qr)
      return qr
    }

    const svc = new PrekeyMutationService()
    const spy = jest.spyOn(AppDataSource, 'createQueryRunner')
    spy.mockReturnValueOnce(runnerFor('a')).mockReturnValueOnce(runnerFor('b'))

    const [first, second] = await Promise.all([
      svc.storeBackup(userId, deviceId, encrypted as any, now),
      svc.storeBackup(userId, deviceId, encrypted as any, now),
    ])

    const sorted = [first, second].sort((x, y) => Number(x.created) - Number(y.created))
    expect(sorted[0]).toEqual({ created: false, hoursRemaining: 24 })
    expect(sorted[1]).toEqual({ created: true })
    const saves = runners.map((qr) => (qr.__repo.save as jest.Mock).mock.calls.length)
    expect(saves.sort()).toEqual([0, 1])
    expect(store.size).toBe(1)
    const row = store.get(keyOf(userId, deviceId))
    expect(row.bundle).toEqual({ _encryptedKeyBundle: encrypted })
    expect(row.lastBackupTimestamp).toEqual(now)
    for (const qr of runners) expect(qr.release).toHaveBeenCalledTimes(1)
  })
})
