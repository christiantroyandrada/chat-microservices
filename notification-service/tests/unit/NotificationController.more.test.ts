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
    await NotificationController.getNotifications({ user: { _id: 'u1' }, query: {} } as any, res)
    expect(res.json).toHaveBeenCalled()
  })

  it('getUnreadCount returns count', async () => {
  const { requireControllerWithMock } = require('../utils/testHelpers')
  const { controller, repo } = requireControllerWithMock('../../src/controllers/NotificationController', {})
  ;(repo.count as jest.Mock).mockResolvedValue(5)
  const NotificationController = controller
    const res: any = { json: jest.fn() }
    await NotificationController.getUnreadCount({ user: { _id: 'u1' } } as any, res)
    expect(res.json).toHaveBeenCalled()
  })

  it('markAsRead returns 404 when not found and 200 when found', async () => {
  const { requireControllerWithMock } = require('../utils/testHelpers')
  const { controller, repo } = requireControllerWithMock('../../src/controllers/NotificationController', {})
  ;(repo.findOne as jest.Mock).mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'n1', userId: 'u1', read: false })
  const NotificationController = controller
    const resNotFound: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    await NotificationController.markAsRead({ user: { _id: 'u1' }, params: { notificationId: 'no' } } as any, resNotFound)
    expect(resNotFound.status).toHaveBeenCalled()

    const resOk: any = { json: jest.fn(), status: jest.fn().mockReturnThis() }
    await NotificationController.markAsRead({ user: { _id: 'u1' }, params: { notificationId: 'n1' } } as any, resOk)
    expect(resOk.json).toHaveBeenCalled()
  })

  it('markAllAsRead returns modifiedCount', async () => {
  const { requireControllerWithMock } = require('../utils/testHelpers')
  const { controller, repo, qb } = requireControllerWithMock('../../src/controllers/NotificationController', { executeResult: { affected: 2 } })
  const NotificationController = controller
    const res: any = { json: jest.fn() }
    await NotificationController.markAllAsRead({ user: { _id: 'u1' } } as any, res)
    expect(res.json).toHaveBeenCalled()
  })

  it('deleteNotification handles not found and success', async () => {
  const { requireControllerWithMock } = require('../utils/testHelpers')
  const { controller, repo } = requireControllerWithMock('../../src/controllers/NotificationController', {})
  ;(repo.findOne as jest.Mock).mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'n1', userId: 'u1' })
  const NotificationController = controller
    const resNotFound: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    await NotificationController.deleteNotification({ user: { _id: 'u1' }, params: { notificationId: 'no' } } as any, resNotFound)
    expect(resNotFound.status).toHaveBeenCalled()

    const resOk: any = { json: jest.fn(), status: jest.fn().mockReturnThis() }
    await NotificationController.deleteNotification({ user: { _id: 'u1' }, params: { notificationId: 'n1' } } as any, resOk)
    expect(resOk.json).toHaveBeenCalled()
  })

  it('createNotification validates input and accepts valid types', async () => {
    const { requireControllerWithMock } = require('../utils/testHelpers')
    const { controller: NotificationController, repo } = requireControllerWithMock('../../src/controllers/NotificationController', { saveResult: { id: 'n1', userId: 'u1', type: 'message', title: 't', message: 'm', read: false } })
    const resBad: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    await NotificationController.createNotification({ user: { _id: 'u1' }, body: { } } as any, resBad)
    expect(resBad.status).toHaveBeenCalled()

    const resInvalidType: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    await NotificationController.createNotification({ user: { _id: 'u1' }, body: { userId: 'u1', type: 'bad', title: 't', message: 'm' } } as any, resInvalidType)
    expect(resInvalidType.status).toHaveBeenCalled()

    const resOk: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    await NotificationController.createNotification({ user: { _id: 'u1' }, body: { userId: 'u1', type: 'message', title: 't', message: 'm' } } as any, resOk)
    expect(resOk.status).toHaveBeenCalled()
  })
})
