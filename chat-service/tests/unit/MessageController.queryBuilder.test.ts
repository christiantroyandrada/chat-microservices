// ESM-workarounds used across the test suite
jest.mock('uuid', () => ({ v4: () => 'mock-uuid' }))
jest.mock('amqplib', () => ({}))
jest.mock('../../src/services/RabbitMQService', () => ({ rabbitMQService: { getUserDetails: jest.fn() } }))

describe('MessageController - query builder and repository branches', () => {
  const cursor = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  beforeEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
  })

  it('fetchConversation uses createQueryBuilder and returns messages', async () => {
    const messages = [ { id: 'm1', message: 'hi' } ]

  const { requireControllerWithMock } = require('../utils/testHelpers')
  // use shared helper: set up repo + query-builder mocks and require controller after mocks
  const { controller, repo, qb } = requireControllerWithMock('../../src/controllers/MessageController', { getManyResult: messages })
  const MC = controller.default || controller

    const req: any = { params: { receiverId: 'u2' }, user: { _id: 'u1' }, query: {} }
    const res: any = { json: jest.fn(), status: jest.fn().mockReturnThis() }

      await MC.fetchConversation(req, res)

    expect(repo.createQueryBuilder).toHaveBeenCalledWith('message')
    expect(qb.where).toHaveBeenCalled()
    expect(qb.orderBy).toHaveBeenCalledWith({ 'message.createdAt': 'DESC', 'message.id': 'DESC' })
    expect(qb.getManyAndCount).toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 200, data: messages }))
  })

  it('getConversations returns Unknown User when broker user is missing', async () => {
    const convs = [ { userId: 'u2', lastMessage: 'hey', lastMessageSenderId: 'u1', lastMessageTime: new Date().toISOString(), unreadCount: 0 } ]

    const { requireControllerWithMock } = require('../utils/testHelpers')
    const { controller, repo } = requireControllerWithMock('../../src/controllers/MessageController', { queryResult: convs })
    const { rabbitMQService } = require('../../src/services/RabbitMQService')
    rabbitMQService.getUserDetails.mockImplementation(async (_id: string, callback: (user: null) => void) => callback(null))
    const MC = controller.default || controller

    const req: any = { user: { _id: 'u1' } }
    const res: any = { json: jest.fn() }

      await MC.getConversations(req, res)

    expect(repo.query).toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 200 }))
    const called = res.json.mock.calls[0][0]
    expect(called.data[0].username).toBe('Unknown User')
  })

  it.each([
    ['afterMessageId', '>', 'ASC'],
    ['beforeMessageId', '<', 'DESC'],
  ])('uses a conversation-scoped tuple for %s', async (option, comparison, direction) => {
    const timestamp = '2026-01-01 00:00:00.123456'
    const { requireControllerWithMock } = require('../utils/testHelpers')
    const { controller, repo, qb } = requireControllerWithMock('../../src/controllers/MessageController', {
      queryResult: [{ timestamp }],
      getManyResult: [{ id: cursor }],
    })
    const res = { json: jest.fn() }
    const next = jest.fn()
    await controller.fetchConversation({ params: { receiverId: 'u2' }, user: { _id: 'u1' }, query: { [option]: cursor } }, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(repo.query).toHaveBeenCalledWith(expect.stringContaining('"createdAt"::text'), [cursor, 'u1', 'u2'])
    expect(qb.andWhere).toHaveBeenCalledWith(`(message.createdAt, message.id) ${comparison} (:timestamp, :cursor)`, { timestamp, cursor })
    expect(qb.orderBy).toHaveBeenCalledWith({ 'message.createdAt': direction, 'message.id': direction })
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: [{ id: cursor }] }))
  })

  it.each([['start', undefined], [cursor, 404]])('handles a start or missing cursor %s', async (afterMessageId, statusCode) => {
    const { requireControllerWithMock } = require('../utils/testHelpers')
    const { controller, repo, qb } = requireControllerWithMock('../../src/controllers/MessageController')
    const res = { json: jest.fn() }
    const next = jest.fn()
    await controller.fetchConversation({ params: { receiverId: 'u2' }, user: { _id: 'u1' }, query: { afterMessageId } }, res, next)

    if (statusCode) {
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode }))
      expect(qb.getManyAndCount).not.toHaveBeenCalled()
    } else {
      expect(next).not.toHaveBeenCalled()
      expect(repo.query).not.toHaveBeenCalled()
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: [] }))
    }
  })

  it('applies the visible ID filter and rejects an absent selection before updating rows', async () => {
    const { requireControllerWithMock } = require('../utils/testHelpers')
    const { controller, qb } = requireControllerWithMock('../../src/controllers/MessageController', { executeResult: { affected: 1 } })
    const req = { params: { senderId: 'u1' }, user: { _id: 'u2' } }
    const res = { json: jest.fn() }
    const next = jest.fn()
    await controller.default.markVisibleAsRead(req, res, next)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }))
    expect(qb.execute).not.toHaveBeenCalled()
    expect(res.json).not.toHaveBeenCalled()

    await controller.default.markVisibleAsRead({ ...req, body: { messageIds: [cursor] } }, res, next)
    expect(qb.andWhere).toHaveBeenCalledWith('id IN (:...messageIds)', { messageIds: [cursor] })
    expect(qb.execute).toHaveBeenCalledTimes(1)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: { modifiedCount: 1 } }))
  })

  it('getConversations attaches real username when broker returns data', async () => {
    const convs = [ { userId: 'u2', lastMessage: 'hey', lastMessageSenderId: 'u1', lastMessageTime: new Date().toISOString(), unreadCount: 0 } ]

    const { requireControllerWithMock } = require('../utils/testHelpers')
    const { controller, repo } = requireControllerWithMock('../../src/controllers/MessageController', { queryResult: convs })
    const { rabbitMQService } = require('../../src/services/RabbitMQService')
    rabbitMQService.getUserDetails.mockImplementation(async (id: string, callback: (user: { id: string, username: string, email: string }) => void) => callback({ id, username: 'bob', email: 'bob@example.com' }))
    const MC = controller.default || controller

    const req: any = { user: { _id: 'u1' } }
    const res: any = { json: jest.fn() }

      await MC.getConversations(req, res)

    expect(repo.query).toHaveBeenCalled()
    expect(repo.query.mock.calls[0][0]).toContain('COUNT(*)::integer as "unreadCount"')
    const called = res.json.mock.calls[0][0]
    expect(called.data[0].username).toBe('bob')
    expect(called.data[0].unreadCount).toBe(0)
    expect(typeof called.data[0].unreadCount).toBe('number')
  })

  it('markAsRead uses query builder update chain and returns affected count', async () => {
    const { requireControllerWithMock } = require('../utils/testHelpers')
    const { controller, repo, qb } = requireControllerWithMock('../../src/controllers/MessageController', { executeResult: { affected: 3 } })
    const MC = controller.default || controller

    const req: any = { params: { senderId: 'u1' }, user: { _id: 'u2' } }
    const res: any = { json: jest.fn() }

      await MC.markAsRead(req, res)

  expect(repo.createQueryBuilder).toHaveBeenCalled()
  expect(qb.update).toHaveBeenCalled()
  expect(qb.set).toHaveBeenCalled()
  expect(qb.where).toHaveBeenCalled()
  expect(qb.andWhere).toHaveBeenCalled()
  expect(qb.execute).toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 200, data: { modifiedCount: 3 } }))
  })
})
