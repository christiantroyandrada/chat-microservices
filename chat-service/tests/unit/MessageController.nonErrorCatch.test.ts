// Tests that ensure non-Error thrown values hit the 'Internal Server Error' branch
jest.mock('../../src/database', () => ({
  Message: {},
  AppDataSource: { getRepository: jest.fn() }
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
import { AppDataSource } from '../../src/database'

describe('MessageController non-Error catch branches', () => {
  afterEach(() => jest.clearAllMocks())

  it('sendMessage handles non-Error rejection from repo.save', async () => {
    const mockReq: any = {
      user: { _id: 'sender1', username: 'alice', email: 'a@example.com' },
      body: { receiverId: 'receiver1', message: JSON.stringify({ __encrypted: true, body: 'x' }) }
    }
    const repo: any = { save: jest.fn().mockRejectedValue('string-error') }
    ;(AppDataSource.getRepository as jest.Mock).mockReturnValue(repo)
    const mockRes: any = { json: jest.fn() }

    await MessageController.sendMessage(mockReq, mockRes)

    const called = mockRes.json.mock.calls[0][0]
    expect(called.status).toBe(500)
    expect(called.message).toBe('Internal Server Error')
  })

  it('fetchConversation handles non-Error rejection from getMany', async () => {
    const mockReq: any = { params: { receiverId: 'r1' }, user: { _id: 's1' } }
    const repo: any = { createQueryBuilder: jest.fn(() => ({ where: jest.fn().mockReturnThis(), orderBy: jest.fn().mockReturnThis(), getMany: jest.fn().mockRejectedValue('bad') })) }
    ;(AppDataSource.getRepository as jest.Mock).mockReturnValue(repo)
    const mockRes: any = { json: jest.fn() }

    await MessageController.fetchConversation(mockReq, mockRes)
    const called = mockRes.json.mock.calls[0][0]
    expect(called.status).toBe(500)
    expect(called.message).toBe('Internal Server Error')
  })

  it('getConversations handles non-Error rejection from query', async () => {
    const mockReq: any = { user: { _id: 'u1' } }
    const repo: any = { query: jest.fn().mockRejectedValue(null) }
    ;(AppDataSource.getRepository as jest.Mock).mockReturnValue(repo)
    const mockRes: any = { json: jest.fn() }

    await MessageController.getConversations(mockReq, mockRes)
    const called = mockRes.json.mock.calls[0][0]
    expect(called.status).toBe(500)
    expect(called.message).toBe('Internal Server Error')
  })

  it('markAsRead handles non-Error rejection from execute', async () => {
    const mockReq: any = { params: { senderId: 's2' }, user: { _id: 'r2' } }
    const qb: any = { update: jest.fn().mockReturnThis(), set: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(), execute: jest.fn().mockRejectedValue(undefined) }
    const repo: any = { createQueryBuilder: jest.fn(() => qb) }
    ;(AppDataSource.getRepository as jest.Mock).mockReturnValue(repo)
    const mockRes: any = { json: jest.fn() }

    await MessageController.markAsRead(mockReq, mockRes)
    const called = mockRes.json.mock.calls[0][0]
    expect(called.status).toBe(500)
    expect(called.message).toBe('Internal Server Error')
  })
})
