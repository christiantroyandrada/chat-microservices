/* eslint-disable @typescript-eslint/no-var-requires */
describe('AuthController additional branch exercises (user-service)', () => {
  beforeEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
  })

  it('login calls next when user not found', async () => {
    const userRepo = { findOne: jest.fn().mockResolvedValue(null) }
    const AppDataSource = { getRepository: jest.fn().mockReturnValue(userRepo) }
    jest.doMock('../../src/database', () => ({ AppDataSource }))
    // mock isPasswordMatch to avoid import issues
    jest.doMock('../../src/utils', () => ({ isPasswordMatch: jest.fn(), encryptPassword: jest.fn(), APIError: class APIError extends Error { constructor(public statusCode:number, public message:string){ super(message) } } }))

    const AuthController = require('../../src/controllers/AuthController')
    const AC = AuthController.default || AuthController
    const next = jest.fn()
    await AC.login({ body: { email: 'a@b', password: 'p' } } as any, {} as any, next)
    expect(next).toHaveBeenCalled()
  })

  it('login calls next when password mismatch', async () => {
    const user = { id: 'u1', username: 'u', email: 'a@b', password: 'hashed' }
    const userRepo = { findOne: jest.fn().mockResolvedValue(user) }
    const AppDataSource = { getRepository: jest.fn().mockReturnValue(userRepo) }
    jest.doMock('../../src/database', () => ({ AppDataSource }))
    jest.doMock('../../src/utils', () => ({ isPasswordMatch: jest.fn().mockResolvedValue(false), encryptPassword: jest.fn(), APIError: class APIError extends Error { constructor(public statusCode:number, public message:string){ super(message) } } }))

    const AuthController = require('../../src/controllers/AuthController')
    const AC = AuthController.default || AuthController
    const next = jest.fn()
    await AC.login({ body: { email: 'a@b', password: 'p' } } as any, {} as any, next)
    expect(next).toHaveBeenCalled()
  })

  it('getCurrentUser calls next when unauthenticated or user not found', async () => {
    const next = jest.fn()
    const AuthController = require('../../src/controllers/AuthController')
    const AC = AuthController.default || AuthController
    await AC.getCurrentUser({} as any, {} as any, next)
    expect(next).toHaveBeenCalled()
  })

  it('getUserById calls next when userId missing', async () => {
    const next = jest.fn()
    const AuthController = require('../../src/controllers/AuthController')
    const AC = AuthController.default || AuthController
    await AC.getUserById({ params: {} } as any, {} as any, next)
    expect(next).toHaveBeenCalled()
  })
})
