/* eslint-disable @typescript-eslint/no-var-requires */
describe('NotificationController additional error branches', () => {
  beforeEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
  })

  it('getNotifications calls next() when repo.find throws', async () => {
    const notifRepo = { find: jest.fn().mockRejectedValue(new Error('db down')) }
    const AppDataSource = { getRepository: jest.fn().mockReturnValue(notifRepo) }
    jest.doMock('../../src/database', () => ({ AppDataSource }))

    const { requireControllerAfterMocks } = require('../utils/testHelpers')
    const { controller } = requireControllerAfterMocks('../../src/controllers/NotificationController')
    const NC = controller.default || controller
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    const next = jest.fn()

    await NC.getNotifications({ user: { _id: 'u1' }, query: {} } as any, res, next)
    expect(next).toHaveBeenCalledWith(expect.any(Error))
  })

  it('getUnreadCount calls next() when repo.count throws', async () => {
    const notifRepo = { count: jest.fn().mockRejectedValue(new Error('count fail')) }
    const AppDataSource = { getRepository: jest.fn().mockReturnValue(notifRepo) }
    jest.doMock('../../src/database', () => ({ AppDataSource }))

    const { requireControllerAfterMocks } = require('../utils/testHelpers')
    const { controller } = requireControllerAfterMocks('../../src/controllers/NotificationController')
    const NC = controller.default || controller
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    const next = jest.fn()

    await NC.getUnreadCount({ user: { _id: 'u1' } } as any, res, next)
    expect(next).toHaveBeenCalledWith(expect.any(Error))
  })

  it('markAllAsRead calls next() when execute throws', async () => {
    const qb = { update: jest.fn().mockReturnThis(), set: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(), execute: jest.fn().mockRejectedValue(new Error('exec fail')) }
    const notifRepo = { createQueryBuilder: jest.fn().mockReturnValue(qb) }
    const AppDataSource = { getRepository: jest.fn().mockReturnValue(notifRepo) }
    jest.doMock('../../src/database', () => ({ AppDataSource }))

    const { requireControllerAfterMocks } = require('../utils/testHelpers')
    const { controller } = requireControllerAfterMocks('../../src/controllers/NotificationController')
    const NC = controller.default || controller
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    const next = jest.fn()

    await NC.markAllAsRead({ user: { _id: 'u1' } } as any, res, next)
    expect(next).toHaveBeenCalledWith(expect.any(Error))
  })
})
