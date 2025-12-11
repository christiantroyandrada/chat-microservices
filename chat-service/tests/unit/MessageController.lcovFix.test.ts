// Follow existing test style: mock database and utils before importing controller
jest.mock('../../src/database', () => ({
  Message: {},
  AppDataSource: {
    getRepository: jest.fn()
  }
}))

jest.mock('../../src/utils', () => ({
  APIError: class APIError extends Error {
    constructor(public statusCode: number, message: string) {
      super(message)
    }
  },
  handleMessageReceived: jest.fn().mockResolvedValue(undefined)
}))

import MessageController from '../../src/controllers/MessageController'
import { clearUserDetailCache } from '../../src/controllers/MessageController'
import { AppDataSource } from '../../src/database'

describe('MessageController targeted branch fixes', () => {
  afterEach(() => {
    jest.clearAllMocks()
    clearUserDetailCache()
  })

  it('getConversations: maps Unknown User when fetch returns non-ok', async () => {
    const mockReq: any = { user: { _id: 'user1' } }
    const mockRes: any = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    const repo: any = { query: jest.fn().mockResolvedValue([{ userId: 'u2', lastMessage: 'hi', lastMessageTime: new Date().toISOString(), lastMessageSenderId: 'u2', unreadCount: 0 }]) }
    ;(AppDataSource.getRepository as jest.Mock).mockReturnValue(repo)

    ;(global as any).fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 })

    await MessageController.getConversations(mockReq, mockRes)

    const callArg = mockRes.json.mock.calls[0][0]
    expect(callArg.status).toBe(200)
    expect(callArg.data[0].username).toBe('Unknown User')
  })

  it('getConversations: maps returned username when fetch ok and nested data', async () => {
    const mockReq: any = { user: { _id: 'user1' } }
    const mockRes: any = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    const repo: any = { query: jest.fn().mockResolvedValue([{ userId: 'u2', lastMessage: 'hi', lastMessageTime: new Date().toISOString(), lastMessageSenderId: 'u2', unreadCount: 0 }]) }
    ;(AppDataSource.getRepository as jest.Mock).mockReturnValue(repo)

    ;(global as any).fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { id: 'u2', username: 'bob' } }) })

    await MessageController.getConversations(mockReq, mockRes)

    const callArg = mockRes.json.mock.calls[0][0]
    expect(callArg.status).toBe(200)
    expect(callArg.data[0].username).toBe('bob')
  })

  it('markAsRead: returns modifiedCount 0 when result.affected undefined', async () => {
    const mockReq: any = { params: { senderId: 's1' }, user: { _id: 'r1' } }
    const mockRes: any = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    const exec = jest.fn().mockResolvedValue({ affected: undefined })
    const qb: any = { update: jest.fn().mockReturnThis(), set: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(), execute: exec }
    const repo: any = { createQueryBuilder: jest.fn(() => qb) }
    ;(AppDataSource.getRepository as jest.Mock).mockReturnValue(repo)

    await MessageController.markAsRead(mockReq, mockRes)

    const callArg = mockRes.json.mock.calls[0][0]
    expect(callArg.status).toBe(200)
    expect(callArg.data.modifiedCount).toBe(0)
  })

  it('markAsRead: returns modifiedCount when affected > 0', async () => {
    const mockReq: any = { params: { senderId: 's1' }, user: { _id: 'r1' } }
    const mockRes: any = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    const exec = jest.fn().mockResolvedValue({ affected: 5 })
    const qb: any = { update: jest.fn().mockReturnThis(), set: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(), execute: exec }
    const repo: any = { createQueryBuilder: jest.fn(() => qb) }
    ;(AppDataSource.getRepository as jest.Mock).mockReturnValue(repo)

    await MessageController.markAsRead(mockReq, mockRes)

    const callArg = mockRes.json.mock.calls[0][0]
    expect(callArg.status).toBe(200)
    expect(callArg.data.modifiedCount).toBe(5)
  })

  it('sendMessage: JSON.parse failure branch returns error response', async () => {
    const mockReq: any = { body: { receiverId: 'r2', message: 'not-a-json' }, user: { _id: 's1', email: 'a@b', username: 'sender' } }
    const mockRes: any = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    const repo: any = { save: jest.fn() }
    ;(AppDataSource.getRepository as jest.Mock).mockReturnValue(repo)

    await MessageController.sendMessage(mockReq, mockRes)

    const callArg = mockRes.json.mock.calls[0][0]
    expect(callArg.status).toBe(400)
    expect(typeof callArg.message).toBe('string')
  })

  it('getConversations: respects USER_SERVICE_URL env and treats null json as Unknown User', async () => {
    const prev = process.env.USER_SERVICE_URL
    process.env.USER_SERVICE_URL = 'http://custom-user-service'

    const mockReq: any = { user: { _id: 'user1' } }
    const mockRes: any = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    const repo: any = { query: jest.fn().mockResolvedValue([{ userId: 'u2', lastMessage: 'hi', lastMessageTime: new Date().toISOString(), lastMessageSenderId: 'u2', unreadCount: 0 }]) }
    ;(AppDataSource.getRepository as jest.Mock).mockReturnValue(repo)

    ;(global as any).fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => null })

    await MessageController.getConversations(mockReq, mockRes)

    const callArg = mockRes.json.mock.calls[0][0]
    expect(callArg.status).toBe(200)
    expect(callArg.data[0].username).toBe('Unknown User')

    if (prev === undefined) delete process.env.USER_SERVICE_URL
    else process.env.USER_SERVICE_URL = prev
  })

  it('getConversations: uses HTTPS user service in production and maps nested username', async () => {
    const prevNode = process.env.NODE_ENV
    delete process.env.USER_SERVICE_URL
    process.env.NODE_ENV = 'production'

    const mockReq: any = { user: { _id: 'user1' } }
    const mockRes: any = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    const repo: any = { query: jest.fn().mockResolvedValue([{ userId: 'u3', lastMessage: 'yo', lastMessageTime: new Date().toISOString(), lastMessageSenderId: 'u3', unreadCount: 0 }]) }
    ;(AppDataSource.getRepository as jest.Mock).mockReturnValue(repo)

    ;(global as any).fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { id: 'u3', username: 'prod-user' } }) })

    await MessageController.getConversations(mockReq, mockRes)

    const callArg = mockRes.json.mock.calls[0][0]
    expect(callArg.status).toBe(200)
    expect(callArg.data[0].username).toBe('prod-user')

    if (prevNode === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = prevNode
  })
})
