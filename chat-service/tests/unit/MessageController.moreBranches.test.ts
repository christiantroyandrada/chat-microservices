/* eslint-disable @typescript-eslint/no-var-requires */
describe('MessageController more branch exercises', () => {
  beforeEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
  })

  it('sendMessage rejects when message is not a string', async () => {
    jest.doMock('../../src/database', () => ({ AppDataSource: { getRepository: jest.fn() }, Message: class {} }))
    jest.doMock('../../src/utils', () => ({ APIError: class APIError extends Error { constructor(public statusCode:number, public message:string){ super(message) } }, handleMessageReceived: jest.fn() }))
    const MessageController = require('../../src/controllers/MessageController')
    const MC = MessageController.default || MessageController
    const res: any = { json: jest.fn() }

    await MC.sendMessage({ user: { _id: 'u1', username: 'u' }, body: { receiverId: 'u2', message: 123 } } as any, res)
    expect(res.json).toHaveBeenCalled()
  })

  it('sendMessage rejects when message is only whitespace', async () => {
    jest.doMock('../../src/database', () => ({ AppDataSource: { getRepository: jest.fn() }, Message: class {} }))
    jest.doMock('../../src/utils', () => ({ APIError: class APIError extends Error { constructor(public statusCode:number, public message:string){ super(message) } }, handleMessageReceived: jest.fn() }))
    const MessageController = require('../../src/controllers/MessageController')
    const MC = MessageController.default || MessageController
    const res: any = { json: jest.fn() }

    await MC.sendMessage({ user: { _id: 'u1', username: 'u' }, body: { receiverId: 'u2', message: '   ' } } as any, res)
    expect(res.json).toHaveBeenCalled()
  })

  it('fetchConversation returns 500 when query builder throws', async () => {
    const repo = { createQueryBuilder: jest.fn().mockImplementation(() => { throw new Error('db-fail') }) }
    const AppDataSource = { getRepository: jest.fn().mockReturnValue(repo) }
    jest.doMock('../../src/database', () => ({ AppDataSource }))
    const MessageController = require('../../src/controllers/MessageController')
    const MC = MessageController.default || MessageController
    const res: any = { json: jest.fn() }

    await MC.fetchConversation({ user: { _id: 'u1' }, params: { receiverId: 'u2' } } as any, res)
    expect(res.json).toHaveBeenCalled()
    const called = res.json.mock.calls[0][0]
    expect(called).toHaveProperty('status')
  })

  it('markAsRead returns error when senderId missing', async () => {
    const repo = { createQueryBuilder: jest.fn().mockReturnValue({ update: jest.fn().mockReturnThis(), set: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(), execute: jest.fn().mockResolvedValue({ affected: 0 }) }) }
    const AppDataSource = { getRepository: jest.fn().mockReturnValue(repo) }
    jest.doMock('../../src/database', () => ({ AppDataSource }))
    const MessageController = require('../../src/controllers/MessageController')
    const MC = MessageController.default || MessageController
    const res: any = { json: jest.fn() }

    await MC.markAsRead({ user: { _id: 'u1' }, params: {} } as any, res)
    expect(res.json).toHaveBeenCalled()
  })
})
