import NotificationController from '../../src/controllers/NotificationController'
import { AppDataSource } from '../../src/database'

describe('NotificationController.getNotifications', () => {
  it('returns notifications for user', async () => {
    const req: any = { user: { _id: 'user1' }, query: {} }
    const res: any = { json: jest.fn() }

    const repo = { find: jest.fn().mockResolvedValue([{ id: 'n1' }]) }
    jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any)

    await NotificationController.getNotifications(req, res)

    expect(res.json).toHaveBeenCalled()
  })

  it('handles DB errors gracefully', async () => {
    const req: any = { user: { _id: 'user1' }, query: {} }
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    const repo = { find: jest.fn().mockRejectedValue(new Error('DB down')) }
    jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any)

    await NotificationController.getNotifications(req, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalled()
  })
})

describe('NotificationController.markAsRead', () => {
  it('marks notification as read when found', async () => {
    const req: any = { user: { _id: 'user1' }, params: { notificationId: 'n1' } }
    const res: any = { json: jest.fn() }

    const notif = { id: 'n1', userId: 'user1', read: false }
    const repo = { findOne: jest.fn().mockResolvedValue(notif), save: jest.fn().mockResolvedValue({ ...notif, read: true }) }
    jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any)

    await NotificationController.markAsRead(req, res)

    expect(res.json).toHaveBeenCalled()
  })
})
