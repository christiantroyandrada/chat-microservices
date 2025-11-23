process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_which_is_long_enough_32_chars'

import AuthController from '../../src/controllers/AuthController'
import { AppDataSource } from '../../src/database'

describe('AuthController additional cases', () => {
  afterEach(() => {
    jest.restoreAllMocks()
    jest.resetModules()
  })

  it('registration rejects invalid username', async () => {
    const req: any = { body: { username: 'x', email: 'a@b.com', password: 'pw' } }
    const res: any = { json: jest.fn() }
    const next = jest.fn()

    const repo = { findOne: jest.fn() }
    jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any)

    await AuthController.registration(req, res, next)

    expect(next).toHaveBeenCalled()
  })

  it('registration handles save throwing error', async () => {
    const req: any = { body: { username: 'validuser', email: 'a@b.com', password: 'pw' } }
    const res: any = { json: jest.fn() }
    const next = jest.fn()

    const repo = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockRejectedValue(new Error('db-fail'))
    }

    jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any)

    await AuthController.registration(req, res, next)

    expect(next).toHaveBeenCalled()
  })

  it('login returns next when user not found', async () => {
    const req: any = { body: { email: 'not@found.com', password: 'pw' } }
    const res: any = { json: jest.fn() }
    const next = jest.fn()

    const repo = { findOne: jest.fn().mockResolvedValue(null) }
    jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any)

    await AuthController.login(req, res, next)

    expect(next).toHaveBeenCalled()
  })

  it('login returns next when password mismatch', async () => {
    const req: any = { body: { email: 'a@b.com', password: 'pw' } }
    const res: any = { json: jest.fn(), cookie: jest.fn() }
    const next = jest.fn()

    const user = { id: 'u1', username: 'user', email: 'a@b.com', password: 'hashed' }
    const repo = { findOne: jest.fn().mockResolvedValue(user) }
    jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any)

    const utils = require('../../src/utils')
    jest.spyOn(utils, 'isPasswordMatch').mockResolvedValue(false)

    await AuthController.login(req, res, next)

    expect(next).toHaveBeenCalled()
  })

  it('getCurrentUser requires authentication', async () => {
    const req: any = { user: null }
    const res: any = { json: jest.fn() }
    const next = jest.fn()

    await AuthController.getCurrentUser(req, res, next)

    expect(next).toHaveBeenCalled()
  })

  it('getUserById handles missing id and not found', async () => {
    const res: any = { json: jest.fn() }
    const next = jest.fn()

    await AuthController.getUserById({ params: {} } as any, res, next)
    expect(next).toHaveBeenCalled()

    const repo = { findOne: jest.fn().mockResolvedValue(null) }
    jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any)
    await AuthController.getUserById({ params: { userId: 'nope' } } as any, res, next)
    expect(next).toHaveBeenCalled()
  })

  it('logout clears cookie', async () => {
    const res: any = { json: jest.fn(), clearCookie: jest.fn() }
    const next = jest.fn()
    await AuthController.logout({} as any, res, next)
    expect(res.clearCookie).toHaveBeenCalled()
    expect(res.json).toHaveBeenCalled()
  })
})
