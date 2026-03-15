/* eslint-disable @typescript-eslint/no-var-requires */
describe('NotificationController branch coverage', () => {
  beforeEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
  })

  it('markAsRead calls next with APIError(404) when notification not found', async () => {
    const { requireControllerWithMock } = require('../utils/testHelpers')
    const { controller, repo } = requireControllerWithMock('../../src/controllers/NotificationController', {})
    ;(repo.findOne as jest.Mock).mockResolvedValue(null)
    const NC = controller.default || controller
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    const next = jest.fn()

    await NC.markAsRead({ user: { _id: 'u1' }, params: { notificationId: 'n1' } } as any, res, next)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }))
  })

  it('deleteNotification calls next(404) when not found and returns 200 when removed', async () => {
    const notif = { id: 'n1', userId: 'u1' }
    const { requireControllerWithMock } = require('../utils/testHelpers')
    const { controller, repo } = requireControllerWithMock('../../src/controllers/NotificationController', {})
    ;(repo.findOne as jest.Mock).mockResolvedValueOnce(null).mockResolvedValueOnce(notif)
    const NC = controller.default || controller

    // Not found → next(APIError 404)
    const res1: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    const next1 = jest.fn()
    await NC.deleteNotification({ user: { _id: 'u1' }, params: { notificationId: 'not-found' } } as any, res1, next1)
    expect(next1).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }))

    // Success → res.json()
    const res2: any = { json: jest.fn() }
    const next2 = jest.fn()
    await NC.deleteNotification({ user: { _id: 'u1' }, params: { notificationId: 'n1' } } as any, res2, next2)
    expect(res2.json).toHaveBeenCalled()
    expect(next2).not.toHaveBeenCalled()
  })

  it('createNotification validates missing fields and invalid type, and returns 201 on success', async () => {
    const { requireControllerWithMock } = require('../utils/testHelpers')
    const { controller, repo } = requireControllerWithMock('../../src/controllers/NotificationController', { saveResult: { id: 'n1', userId: 'u2', type: 'message', title: 't', message: 'm' } })
    const NC = controller.default || controller

    // missing fields → next(APIError 400)
    const next1 = jest.fn()
    await NC.createNotification({ body: { userId: 'u2', title: 't' } } as any, {} as any, next1)
    expect(next1).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }))

    // invalid type — user must match userId so IDOR check passes, then type check rejects
    const next2 = jest.fn()
    await NC.createNotification({ user: { _id: 'u2' }, body: { userId: 'u2', type: 'unknown', title: 't', message: 'm' } } as any, {} as any, next2)
    expect(next2).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }))

    // success — user._id matches userId so IDOR check passes
    const resOk: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    const next3 = jest.fn()
    await NC.createNotification({ user: { _id: 'u2' }, body: { userId: 'u2', type: 'message', title: 't', message: 'm' } } as any, resOk, next3)
    expect(resOk.status).toHaveBeenCalledWith(201)
    expect(resOk.json).toHaveBeenCalled()
    expect(next3).not.toHaveBeenCalled()
  })

  it('markAllAsRead returns modifiedCount from update result', async () => {
    const { requireControllerWithMock } = require('../utils/testHelpers')
    const { controller, repo, qb } = requireControllerWithMock('../../src/controllers/NotificationController', { executeResult: { affected: 5 } })
    const NC = controller.default || controller
    const res: any = { json: jest.fn() }
    const next = jest.fn()
    await NC.markAllAsRead({ user: { _id: 'u1' } } as any, res, next)
    expect(res.json).toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
    const called = res.json.mock.calls[0][0]
    expect(called.data).toHaveProperty('modifiedCount', 5)
  })
})
