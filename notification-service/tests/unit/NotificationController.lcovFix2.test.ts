/* eslint-disable @typescript-eslint/no-var-requires */
describe('NotificationController additional error branches', () => {
  beforeEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
  })

  it('getNotifications returns 500 when repo.find throws', async () => {
    const notifRepo = { find: jest.fn().mockRejectedValue(new Error('db down')) }
    const AppDataSource = { getRepository: jest.fn().mockReturnValue(notifRepo) }
    jest.doMock('../../src/database', () => ({ AppDataSource }))

    const NotificationController = require('../../src/controllers/NotificationController')
    const NC = NotificationController.default || NotificationController
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await NC.getNotifications({ user: { _id: 'u1' }, query: {} } as any, res)
    expect(res.status).toHaveBeenCalledWith(500)
  })

  it('getUnreadCount returns 500 when repo.count throws', async () => {
    const notifRepo = { count: jest.fn().mockRejectedValue(new Error('count fail')) }
    const AppDataSource = { getRepository: jest.fn().mockReturnValue(notifRepo) }
    jest.doMock('../../src/database', () => ({ AppDataSource }))

    const NotificationController = require('../../src/controllers/NotificationController')
    const NC = NotificationController.default || NotificationController
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await NC.getUnreadCount({ user: { _id: 'u1' } } as any, res)
    expect(res.status).toHaveBeenCalledWith(500)
  })

  it('markAllAsRead returns 500 when execute throws', async () => {
    const qb = { update: jest.fn().mockReturnThis(), set: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(), execute: jest.fn().mockRejectedValue(new Error('exec fail')) }
    const notifRepo = { createQueryBuilder: jest.fn().mockReturnValue(qb) }
    const AppDataSource = { getRepository: jest.fn().mockReturnValue(notifRepo) }
    jest.doMock('../../src/database', () => ({ AppDataSource }))

    const NotificationController = require('../../src/controllers/NotificationController')
    const NC = NotificationController.default || NotificationController
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await NC.markAllAsRead({ user: { _id: 'u1' } } as any, res)
    expect(res.status).toHaveBeenCalledWith(500)
  })
})
