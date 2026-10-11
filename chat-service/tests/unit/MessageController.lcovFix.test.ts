import type { UserDetailsCallback } from '../../src/types'
jest.mock('../../src/services/RabbitMQService', () => ({ rabbitMQService: { getUserDetails: jest.fn() } }))
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
import { rabbitMQService } from '../../src/services/RabbitMQService'

describe('MessageController targeted branch fixes', () => {
  afterEach(() => {
    jest.clearAllMocks()
    clearUserDetailCache()
  })

  it('getConversations: maps Unknown User when broker returns no user', async () => {
    const mockReq: any = { user: { _id: 'user1' } }
    const mockRes: any = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    const repo: any = { query: jest.fn().mockResolvedValue([{ userId: 'u2', lastMessage: 'hi', lastMessageTime: new Date().toISOString(), lastMessageSenderId: 'u2', unreadCount: 0 }]) }
    ;(AppDataSource.getRepository as jest.Mock).mockReturnValue(repo)

    jest.mocked(rabbitMQService.getUserDetails).mockImplementation(async (_id, callback) => callback(null))

    await MessageController.getConversations(mockReq, mockRes, jest.fn())

    const callArg = mockRes.json.mock.calls[0][0]
    expect(callArg.status).toBe(200)
    expect(callArg.data[0].username).toBe('Unknown User')
  })

  it('getConversations: maps returned broker username', async () => {
    const mockReq: any = { user: { _id: 'user1' } }
    const mockRes: any = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    const repo: any = { query: jest.fn().mockResolvedValue([{ userId: 'u2', lastMessage: 'hi', lastMessageTime: new Date().toISOString(), lastMessageSenderId: 'u2', unreadCount: 0 }]) }
    ;(AppDataSource.getRepository as jest.Mock).mockReturnValue(repo)

    jest.mocked(rabbitMQService.getUserDetails).mockImplementation(async (id, callback) => callback({ id, username: 'bob', email: 'bob@example.com' }))

    await MessageController.getConversations(mockReq, mockRes, jest.fn())

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

    await MessageController.markAsRead(mockReq, mockRes, jest.fn())

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

    await MessageController.markAsRead(mockReq, mockRes, jest.fn())

    const callArg = mockRes.json.mock.calls[0][0]
    expect(callArg.status).toBe(200)
    expect(callArg.data.modifiedCount).toBe(5)
  })

  it('sendMessage: JSON.parse failure branch returns error response', async () => {
    const mockReq: any = { body: { receiverId: 'r2', message: 'not-a-json' }, user: { _id: 's1', email: 'a@b', username: 'sender' } }
    const mockRes: any = { json: jest.fn(), status: jest.fn().mockReturnThis() }
    const mockNext = jest.fn()

    const repo: any = { save: jest.fn() }
    ;(AppDataSource.getRepository as jest.Mock).mockReturnValue(repo)

    await MessageController.sendMessage(mockReq, mockRes, mockNext)

    expect(mockNext).toHaveBeenCalled()
    const error = mockNext.mock.calls[0][0]
    expect(error.statusCode).toBe(400)
    expect(typeof error.message).toBe('string')
  })

  it('getConversations: treats malformed broker payload as Unknown User', async () => {
    const mockReq: any = { user: { _id: 'user1' } }
    const mockRes: any = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    const repo: any = { query: jest.fn().mockResolvedValue([{ userId: 'u2', lastMessage: 'hi', lastMessageTime: new Date().toISOString(), lastMessageSenderId: 'u2', unreadCount: 0 }]) }
    ;(AppDataSource.getRepository as jest.Mock).mockReturnValue(repo)

    jest.mocked(rabbitMQService.getUserDetails).mockImplementation(async (_id, callback) => callback({ error: 'not found' } as unknown as Parameters<UserDetailsCallback>[0]))

    await MessageController.getConversations(mockReq, mockRes, jest.fn())

    const callArg = mockRes.json.mock.calls[0][0]
    expect(callArg.status).toBe(200)
    expect(callArg.data[0].username).toBe('Unknown User')

  })

  it('getConversations: caches a resolved broker username without email', async () => {
    const mockReq: any = { user: { _id: 'user1' } }
    const mockRes: any = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    const repo: any = { query: jest.fn().mockResolvedValue([{ userId: 'u3', lastMessage: 'yo', lastMessageTime: new Date().toISOString(), lastMessageSenderId: 'u3', unreadCount: 0 }]) }
    ;(AppDataSource.getRepository as jest.Mock).mockReturnValue(repo)

    jest.mocked(rabbitMQService.getUserDetails).mockImplementation(async (id, callback) => callback({ id, username: 'prod-user', email: 'private@example.com' }))

    await MessageController.getConversations(mockReq, mockRes, jest.fn())

    const callArg = mockRes.json.mock.calls[0][0]
    expect(callArg.status).toBe(200)
    expect(callArg.data[0].username).toBe('prod-user')

    await MessageController.getConversations(mockReq, mockRes, jest.fn())
    expect(rabbitMQService.getUserDetails).toHaveBeenCalledTimes(1)
    expect(callArg.data[0]).not.toHaveProperty('email')
  })
})
