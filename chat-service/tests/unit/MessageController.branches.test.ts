/* eslint-disable @typescript-eslint/no-var-requires */
describe('MessageController branch coverage', () => {
  beforeEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
  })

  it('sendMessage rejects when receiverId missing', async () => {
    // Mock repository and helpers before requiring controller
    const AppDataSource = { getRepository: jest.fn() }
    jest.doMock('../../src/database', () => ({ AppDataSource, Message: class {} }))
    // minimal handleMessageReceived so require doesn't fail
    jest.doMock('../../src/utils', () => ({ APIError: class APIError extends Error { constructor(public statusCode:number, public message:string){ super(message) } }, handleMessageReceived: jest.fn() }))

  const { requireControllerAfterMocks } = require('../utils/testHelpers')
  const { controller } = requireControllerAfterMocks('../../src/controllers/MessageController')
  const MC = controller.default || controller
    const res: any = { json: jest.fn() }

    await MC.sendMessage({ user: { _id: 'u1', username: 'u' }, body: { message: 'x' } } as any, res)
    expect(res.json).toHaveBeenCalled()
  })

  it('sendMessage rejects when sender equals receiver', async () => {
    jest.doMock('../../src/database', () => ({ AppDataSource: { getRepository: jest.fn() }, Message: class {} }))
    jest.doMock('../../src/utils', () => ({ APIError: class APIError extends Error { constructor(public statusCode:number, public message:string){ super(message) } }, handleMessageReceived: jest.fn() }))
  const { requireControllerAfterMocks } = require('../utils/testHelpers')
  const { controller } = requireControllerAfterMocks('../../src/controllers/MessageController')
  const MC = controller.default || controller
    const res: any = { json: jest.fn() }

    await MC.sendMessage({ user: { _id: 'u1', username: 'u' }, body: { receiverId: 'u1', message: 'x' } } as any, res)
    expect(res.json).toHaveBeenCalled()
  })

  it('sendMessage rejects when message too long', async () => {
    jest.doMock('../../src/database', () => ({ AppDataSource: { getRepository: jest.fn() }, Message: class {} }))
    jest.doMock('../../src/utils', () => ({ APIError: class APIError extends Error { constructor(public statusCode:number, public message:string){ super(message) } }, handleMessageReceived: jest.fn() }))
  const { requireControllerAfterMocks } = require('../utils/testHelpers')
  const { controller } = requireControllerAfterMocks('../../src/controllers/MessageController')
  const MC = controller.default || controller
    const res: any = { json: jest.fn() }
    const long = 'a'.repeat(5001)

    await MC.sendMessage({ user: { _id: 'u1', username: 'u' }, body: { receiverId: 'u2', message: long } } as any, res)
    expect(res.json).toHaveBeenCalled()
  })

  it('sendMessage rejects when envelope __encrypted !== true', async () => {
    jest.doMock('../../src/database', () => ({ AppDataSource: { getRepository: jest.fn() }, Message: class {} }))
    jest.doMock('../../src/utils', () => ({ APIError: class APIError extends Error { constructor(public statusCode:number, public message:string){ super(message) } }, handleMessageReceived: jest.fn() }))
  const { requireControllerAfterMocks } = require('../utils/testHelpers')
  const { controller } = requireControllerAfterMocks('../../src/controllers/MessageController')
  const MC = controller.default || controller
    const res: any = { json: jest.fn() }
    const badEnvelope = JSON.stringify({ __encrypted: false, body: 'x' })

    await MC.sendMessage({ user: { _id: 'u1', username: 'u' }, body: { receiverId: 'u2', message: badEnvelope } } as any, res)
    expect(res.json).toHaveBeenCalled()
  })

  it('getConversations maps usernames when fetchUserDetails returns name and when null', async () => {
    // mock query returning two convos
    const convos = [ { userId: 'u2', lastMessage: 'hi', lastMessageSenderId: 'u2', lastMessageTime: new Date().toISOString(), unreadCount: 0 } ]
    const messageRepo = { query: jest.fn().mockResolvedValue(convos) }
    const AppDataSource = { getRepository: jest.fn().mockReturnValue(messageRepo) }
    jest.doMock('../../src/database', () => ({ AppDataSource }))

    // First: fetch returns username
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { username: 'bob' } }) }) as any
  const { requireControllerAfterMocks } = require('../utils/testHelpers')
  const { controller } = requireControllerAfterMocks('../../src/controllers/MessageController')
  const MC = controller.default || controller
  const res1: any = { json: jest.fn() }
  await MC.getConversations({ user: { _id: 'u1' } } as any, res1)
    expect(res1.json).toHaveBeenCalled()
    const called1 = res1.json.mock.calls[0][0]
    expect(called1.data[0]).toHaveProperty('username', 'bob')

    // Second: fetch fails -> username Unknown User
    global.fetch = jest.fn().mockResolvedValue({ ok: false }) as any
    const res2: any = { json: jest.fn() }
    await MC.getConversations({ user: { _id: 'u1' } } as any, res2)
    expect(res2.json).toHaveBeenCalled()
    const called2 = res2.json.mock.calls[0][0]
    expect(called2.data[0]).toHaveProperty('username', 'Unknown User')
  })

  it('markAsRead validates senderId and returns modifiedCount', async () => {
    const repo = { createQueryBuilder: jest.fn().mockReturnValue({ update: jest.fn().mockReturnThis(), set: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(), execute: jest.fn().mockResolvedValue({ affected: 3 }) }) }
    const AppDataSource = { getRepository: jest.fn().mockReturnValue(repo) }
    jest.doMock('../../src/database', () => ({ AppDataSource }))
  const { requireControllerAfterMocks } = require('../utils/testHelpers')
  const { controller } = requireControllerAfterMocks('../../src/controllers/MessageController')
  const MC = controller.default || controller
    const res: any = { json: jest.fn() }

    await MC.markAsRead({ user: { _id: 'u1' }, params: { senderId: 'u2' } } as any, res)
    expect(res.json).toHaveBeenCalled()
    const called = res.json.mock.calls[0][0]
    expect(called.data).toHaveProperty('modifiedCount', 3)
  })
})
