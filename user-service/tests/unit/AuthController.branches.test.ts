process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_which_is_long_enough_32_chars'

import AuthController from '../../src/controllers/AuthController'
import { AppDataSource } from '../../src/database'

describe('AuthController branch-targeted tests', () => {
  afterEach(() => {
    jest.restoreAllMocks()
    jest.resetModules()
  })

  it('registration detects username already taken (different email)', async () => {
    const req: any = { body: { username: 'takenuser', email: 'other@b.com', password: 'pw' } }
    const res: any = { json: jest.fn() }
    const next = jest.fn()

    const existing = { id: 'e1', username: 'takenuser', email: 'diff@b.com' }
    const repo = { findOne: jest.fn().mockResolvedValue(existing) }
    jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any)

    await AuthController.registration(req, res, next)

    expect(next).toHaveBeenCalled()
  })

  it('getCurrentUser returns user when found', async () => {
    const repo = { findOne: jest.fn().mockResolvedValue({ id: 'u1', username: 'u', email: 'a@b' }) }
    jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any)
    const res: any = { json: jest.fn() }
    const req: any = { user: { id: 'u1' } }
    const next = jest.fn()
    await AuthController.getCurrentUser(req, res, next)
    expect(res.json).toHaveBeenCalled()
  })

  it('getUserById success path returns user', async () => {
    const repo = { findOne: jest.fn().mockResolvedValue({ id: 'u2', username: 'u2', email: 'b@c' }) }
    jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any)
    const res: any = { json: jest.fn() }
    await AuthController.getUserById({ params: { userId: 'u2' } } as any, res, jest.fn())
    expect(res.json).toHaveBeenCalled()
  })

  it('search returns empty for blank query and maps users for non-empty', async () => {
    const res: any = { json: jest.fn() }
    await AuthController.search({ query: {} } as any, res, jest.fn())
    expect(res.json).toHaveBeenCalled()

    const repo = {
      createQueryBuilder: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([{ id: 'u3', username: 'three', email: '3@x' }])
      })
    }
    jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any)
    const res2: any = { json: jest.fn() }
    await AuthController.search({ query: { q: 'thr' }, user: { id: 'u1' } } as any, res2, jest.fn())
    expect(res2.json).toHaveBeenCalled()
  })
})
