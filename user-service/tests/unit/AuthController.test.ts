import AuthController from '../../src/controllers/AuthController'
import { AppDataSource } from '../../src/database'

describe('AuthController.registration', () => {
  it('should return 400 if user exists', async () => {
    const req: any = { body: { name: 'test', email: 'a@b.com', password: 'pw' } }
    const res: any = { json: jest.fn() }
    const next = jest.fn()

    const repo = {
      findOne: jest.fn().mockResolvedValue({ id: 'existing', email: 'a@b.com' })
    }

    jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any)

    await AuthController.registration(req, res, next)

    expect(next).toHaveBeenCalled()
  })

  it('should register a new user and return 200', async () => {
    const req: any = { body: { name: 'new', email: 'new@b.com', password: 'pw' } }
    const res: any = { json: jest.fn(), cookie: jest.fn() }
    const next = jest.fn()

    const savedUser = { id: 'u1', name: 'new', email: 'new@b.com' }
    const repo = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockResolvedValue(savedUser)
    }

    jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any)

    await AuthController.registration(req, res, next)

    expect(res.json).toHaveBeenCalled()
    const calledWith = (res.json as jest.Mock).mock.calls[0][0]
    expect(calledWith).toHaveProperty('status', 200)
    expect(repo.save).toHaveBeenCalled()
  })
})

describe('AuthController.login', () => {
  it('should return 200 on successful login', async () => {
    const req: any = { body: { email: 'a@b.com', password: 'pw' } }
    const res: any = { json: jest.fn(), cookie: jest.fn() }
    const next = jest.fn()

    const user = { id: 'u1', name: 'user', email: 'a@b.com', password: 'hashed' }
    const repo = { findOne: jest.fn().mockResolvedValue(user) }

    jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any)
    // mock password check util
  const utils = require('../../src/utils')
    jest.spyOn(utils, 'isPasswordMatch').mockResolvedValue(true)

    await AuthController.login(req, res, next)

    expect(res.json).toHaveBeenCalled()
    const calledWith = (res.json as jest.Mock).mock.calls[0][0]
    expect(calledWith).toHaveProperty('status', 200)
  })
})

