// ESM-workarounds used across the test suite
jest.mock('uuid', () => ({ v4: () => 'mock-uuid' }))
jest.mock('amqplib', () => ({}))

describe('MessageController - query builder and repository branches', () => {
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

    const req: any = { params: { receiverId: 'u2' }, user: { _id: 'u1' } }
    const res: any = { json: jest.fn() }

      await MC.fetchConversation(req, res)

    expect(repo.createQueryBuilder).toHaveBeenCalledWith('message')
    expect(qb.where).toHaveBeenCalled()
    expect(qb.orderBy).toHaveBeenCalledWith('message.createdAt', 'ASC')
    expect(qb.getMany).toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 200, data: messages }))
  })

  it('getConversations returns Unknown User when fetch user returns non-ok', async () => {
    const convs = [ { userId: 'u2', lastMessage: 'hey', lastMessageSenderId: 'u1', lastMessageTime: new Date().toISOString(), unreadCount: 0 } ]

    const { requireControllerWithMock } = require('../utils/testHelpers')
    const { controller, repo } = requireControllerWithMock('../../src/controllers/MessageController', { queryResult: convs })
    // Mock fetch to return a non-ok response
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 }) as any
    const MC = controller.default || controller

    const req: any = { user: { _id: 'u1' } }
    const res: any = { json: jest.fn() }

      await MC.getConversations(req, res)

    expect(repo.query).toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 200 }))
    const called = res.json.mock.calls[0][0]
    expect(called.data[0].username).toBe('Unknown User')
  })

  it('getConversations attaches real username when fetch returns data', async () => {
    const convs = [ { userId: 'u2', lastMessage: 'hey', lastMessageSenderId: 'u1', lastMessageTime: new Date().toISOString(), unreadCount: 0 } ]

    const { requireControllerWithMock } = require('../utils/testHelpers')
    const { controller, repo } = requireControllerWithMock('../../src/controllers/MessageController', { queryResult: convs })
    // Mock fetch to return ok response with nested data
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { username: 'bob' } }) }) as any
    const MC = controller.default || controller

    const req: any = { user: { _id: 'u1' } }
    const res: any = { json: jest.fn() }

      await MC.getConversations(req, res)

    expect(repo.query).toHaveBeenCalled()
    const called = res.json.mock.calls[0][0]
    expect(called.data[0].username).toBe('bob')
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
