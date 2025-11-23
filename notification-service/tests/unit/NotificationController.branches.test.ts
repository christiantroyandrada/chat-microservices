/* eslint-disable @typescript-eslint/no-var-requires */
describe('NotificationController branch coverage', () => {
  beforeEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
  })

  it('markAsRead returns 404 when notification not found', async () => {
    const notifRepo = { findOne: jest.fn().mockResolvedValue(null) }
    const AppDataSource = { getRepository: jest.fn().mockReturnValue(notifRepo) }
    jest.doMock('../../src/database', () => ({ AppDataSource }))

    const NotificationController = require('../../src/controllers/NotificationController')
    const NC = NotificationController.default || NotificationController
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await NC.markAsRead({ user: { _id: 'u1' }, params: { notificationId: 'n1' } } as any, res)
    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalled()
  })

  it('deleteNotification returns 404 when not found and 200 when removed', async () => {
    const notif = { id: 'n1', userId: 'u1' }
    const notifRepo = { findOne: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(notif), remove: jest.fn().mockResolvedValue(undefined) }
    const AppDataSource = { getRepository: jest.fn().mockReturnValue(notifRepo) }
    jest.doMock('../../src/database', () => ({ AppDataSource }))

  const NotificationController = require('../../src/controllers/NotificationController')
  const NC = NotificationController.default || NotificationController
  const res1: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }
  await NC.deleteNotification({ user: { _id: 'u1' }, params: { notificationId: 'not-found' } } as any, res1)
    expect(res1.status).toHaveBeenCalledWith(404)

  const res2: any = { json: jest.fn() }
  await NC.deleteNotification({ user: { _id: 'u1' }, params: { notificationId: 'n1' } } as any, res2)
    expect(res2.json).toHaveBeenCalled()
  })

  it('createNotification validates missing fields and invalid type, and returns 201 on success', async () => {
    const notifRepo = { save: jest.fn().mockResolvedValue({ id: 'n1', userId: 'u2', type: 'message', title: 't', message: 'm' }) }
    const AppDataSource = { getRepository: jest.fn().mockReturnValue(notifRepo) }
    jest.doMock('../../src/database', () => ({ AppDataSource }))

  const NotificationController = require('../../src/controllers/NotificationController')
  const NC = NotificationController.default || NotificationController
  const resBad: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    // missing fields
  await NC.createNotification({ body: { userId: 'u2', title: 't' } } as any, resBad)
    expect(resBad.status).toHaveBeenCalled()

    // invalid type
    const resInvalid: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }
  await NC.createNotification({ body: { userId: 'u2', type: 'unknown', title: 't', message: 'm' } } as any, resInvalid)
  expect(resInvalid.status).toHaveBeenCalledWith(400)

    // success
    const resOk: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    await NC.createNotification({ body: { userId: 'u2', type: 'message', title: 't', message: 'm' } } as any, resOk)
    expect(resOk.status).toHaveBeenCalledWith(201)
    expect(resOk.json).toHaveBeenCalled()
  })

  it('markAllAsRead returns modifiedCount from update result', async () => {
    const qb = { update: jest.fn().mockReturnThis(), set: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(), execute: jest.fn().mockResolvedValue({ affected: 5 }) }
    const notifRepo = { createQueryBuilder: jest.fn().mockReturnValue(qb) }
    const AppDataSource = { getRepository: jest.fn().mockReturnValue(notifRepo) }
    jest.doMock('../../src/database', () => ({ AppDataSource }))

    const NotificationController = require('../../src/controllers/NotificationController')
    const NC = NotificationController.default || NotificationController
    const res: any = { json: jest.fn() }
    await NC.markAllAsRead({ user: { _id: 'u1' } } as any, res)
    expect(res.json).toHaveBeenCalled()
    const called = res.json.mock.calls[0][0]
    expect(called.data).toHaveProperty('modifiedCount', 5)
  })
})
