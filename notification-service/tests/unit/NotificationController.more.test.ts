describe('NotificationController additional tests', () => {
  afterEach(() => {
    jest.restoreAllMocks()
    jest.resetModules()
  })

  it('getNotifications returns list', async () => {
    const { requireControllerWithMock } = require('../utils/testHelpers')
    const { controller, repo } = requireControllerWithMock('../../src/controllers/NotificationController', { queryResult: undefined })
    const NotificationController = controller
    const res: any = { json: jest.fn() }
    const next = jest.fn()
    await NotificationController.getNotifications({ user: { _id: 'u1' }, query: {} } as any, res, next)
    expect(res.json).toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it('getUnreadCount returns count', async () => {
    const { requireControllerWithMock } = require('../utils/testHelpers')
    const { controller, repo } = requireControllerWithMock('../../src/controllers/NotificationController', {})
    ;(repo.count as jest.Mock).mockResolvedValue(5)
    const NotificationController = controller
    const res: any = { json: jest.fn() }
    const next = jest.fn()
    await NotificationController.getUnreadCount({ user: { _id: 'u1' } } as any, res, next)
    expect(res.json).toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it('markAsRead calls next(404) when not found and returns 200 when found', async () => {
    const { requireControllerWithMock } = require('../utils/testHelpers')
    const { controller, repo } = requireControllerWithMock('../../src/controllers/NotificationController', {})
    ;(repo.findOne as jest.Mock).mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'n1', userId: 'u1', read: false })
    const NotificationController = controller

    // Not found → next(APIError)
    const resNotFound: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    const next1 = jest.fn()
    await NotificationController.markAsRead({ user: { _id: 'u1' }, params: { notificationId: 'no' } } as any, resNotFound, next1)
    expect(next1).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }))

    // Found → res.json()
    const resOk: any = { json: jest.fn(), status: jest.fn().mockReturnThis() }
    const next2 = jest.fn()
    await NotificationController.markAsRead({ user: { _id: 'u1' }, params: { notificationId: 'n1' } } as any, resOk, next2)
    expect(resOk.json).toHaveBeenCalled()
    expect(next2).not.toHaveBeenCalled()
  })

  it('markAllAsRead returns modifiedCount', async () => {
    const { requireControllerWithMock } = require('../utils/testHelpers')
    const { controller, repo, qb } = requireControllerWithMock('../../src/controllers/NotificationController', { executeResult: { affected: 2 } })
    const NotificationController = controller
    const res: any = { json: jest.fn() }
    const next = jest.fn()
    await NotificationController.markAllAsRead({ user: { _id: 'u1' } } as any, res, next)
    expect(res.json).toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it('deleteNotification handles not found and success', async () => {
    const { requireControllerWithMock } = require('../utils/testHelpers')
    const { controller, repo } = requireControllerWithMock('../../src/controllers/NotificationController', {})
    ;(repo.findOne as jest.Mock).mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'n1', userId: 'u1' })
    const NotificationController = controller

    // Not found → next(APIError 404)
    const resNotFound: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    const next1 = jest.fn()
    await NotificationController.deleteNotification({ user: { _id: 'u1' }, params: { notificationId: 'no' } } as any, resNotFound, next1)
    expect(next1).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }))

    // Success → res.json()
    const resOk: any = { json: jest.fn(), status: jest.fn().mockReturnThis() }
    const next2 = jest.fn()
    await NotificationController.deleteNotification({ user: { _id: 'u1' }, params: { notificationId: 'n1' } } as any, resOk, next2)
    expect(resOk.json).toHaveBeenCalled()
    expect(next2).not.toHaveBeenCalled()
  })

  it('createNotification validates input and accepts valid types', async () => {
    const { requireControllerWithMock } = require('../utils/testHelpers')
    const { controller: NotificationController, repo } = requireControllerWithMock('../../src/controllers/NotificationController', { saveResult: { id: 'n1', userId: 'u1', type: 'message', title: 't', message: 'm', read: false } })

    // Missing fields → next(APIError 400)
    const next1 = jest.fn()
    await NotificationController.createNotification({ user: { _id: 'u1' }, body: { } } as any, {} as any, next1)
    expect(next1).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }))

    // Invalid type → next(APIError 400)
    const next2 = jest.fn()
    await NotificationController.createNotification({ user: { _id: 'u1' }, body: { userId: 'u1', type: 'bad', title: 't', message: 'm' } } as any, {} as any, next2)
    expect(next2).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }))

    // Success → res.status(201).json()
    const resOk: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    const next3 = jest.fn()
    await NotificationController.createNotification({ user: { _id: 'u1' }, body: { userId: 'u1', type: 'message', title: 't', message: 'm' } } as any, resOk, next3)
    expect(resOk.status).toHaveBeenCalledWith(201)
    expect(next3).not.toHaveBeenCalled()
  })
})
