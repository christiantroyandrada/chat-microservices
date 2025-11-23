import NotificationController from '../../src/controllers/NotificationController'
import { AppDataSource } from '../../src/database'

describe('NotificationController additional tests', () => {
  afterEach(() => {
    jest.restoreAllMocks()
    jest.resetModules()
  })

  it('getNotifications returns list', async () => {
    const repo = { find: jest.fn().mockResolvedValue([{ id: 'n1' }]) }
    jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any)
    const res: any = { json: jest.fn() }
    await NotificationController.getNotifications({ user: { _id: 'u1' }, query: {} } as any, res)
    expect(res.json).toHaveBeenCalled()
  })

  it('getUnreadCount returns count', async () => {
    const repo = { count: jest.fn().mockResolvedValue(5) }
    jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any)
    const res: any = { json: jest.fn() }
    await NotificationController.getUnreadCount({ user: { _id: 'u1' } } as any, res)
    expect(res.json).toHaveBeenCalled()
  })

  it('markAsRead returns 404 when not found and 200 when found', async () => {
    const repo = { findOne: jest.fn().mockResolvedValue(null) }
    jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any)
    const resNotFound: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    await NotificationController.markAsRead({ user: { _id: 'u1' }, params: { notificationId: 'no' } } as any, resNotFound)
    expect(resNotFound.status).toHaveBeenCalled()

    const notification = { id: 'n1', userId: 'u1', read: false }
    const repo2 = { findOne: jest.fn().mockResolvedValue(notification), save: jest.fn().mockResolvedValue({ ...notification, read: true }) }
    jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo2 as any)
    const resOk: any = { json: jest.fn(), status: jest.fn().mockReturnThis() }
    await NotificationController.markAsRead({ user: { _id: 'u1' }, params: { notificationId: 'n1' } } as any, resOk)
    expect(resOk.json).toHaveBeenCalled()
  })

  it('markAllAsRead returns modifiedCount', async () => {
    const qb = { update: jest.fn().mockReturnThis(), set: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(), execute: jest.fn().mockResolvedValue({ affected: 2 }) }
    const repo = { createQueryBuilder: jest.fn().mockReturnValue(qb) }
    jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any)
    const res: any = { json: jest.fn() }
    await NotificationController.markAllAsRead({ user: { _id: 'u1' } } as any, res)
    expect(res.json).toHaveBeenCalled()
  })

  it('deleteNotification handles not found and success', async () => {
    const repo = { findOne: jest.fn().mockResolvedValue(null) }
    jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any)
    const resNotFound: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    await NotificationController.deleteNotification({ user: { _id: 'u1' }, params: { notificationId: 'no' } } as any, resNotFound)
    expect(resNotFound.status).toHaveBeenCalled()

    const note = { id: 'n1', userId: 'u1' }
    const repo2 = { findOne: jest.fn().mockResolvedValue(note), remove: jest.fn().mockResolvedValue(undefined) }
    jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo2 as any)
    const resOk: any = { json: jest.fn(), status: jest.fn().mockReturnThis() }
    await NotificationController.deleteNotification({ user: { _id: 'u1' }, params: { notificationId: 'n1' } } as any, resOk)
    expect(resOk.json).toHaveBeenCalled()
  })

  it('createNotification validates input and accepts valid types', async () => {
    const resBad: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    await NotificationController.createNotification({ user: { _id: 'u1' }, body: { } } as any, resBad)
    expect(resBad.status).toHaveBeenCalled()

    const resInvalidType: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    await NotificationController.createNotification({ user: { _id: 'u1' }, body: { userId: 'u1', type: 'bad', title: 't', message: 'm' } } as any, resInvalidType)
    expect(resInvalidType.status).toHaveBeenCalled()

    const saved = { id: 'n1', userId: 'u1', type: 'message', title: 't', message: 'm', read: false }
    const repo = { save: jest.fn().mockResolvedValue(saved) }
    jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any)
    const resOk: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    await NotificationController.createNotification({ user: { _id: 'u1' }, body: { userId: 'u1', type: 'message', title: 't', message: 'm' } } as any, resOk)
    expect(resOk.status).toHaveBeenCalled()
  })
})
