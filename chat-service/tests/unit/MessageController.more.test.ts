// Additional MessageController tests: empty, too-long, sender==receiver, unknown username mapping

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
import { AppDataSource } from '../../src/database'

describe('MessageController additional sendMessage validations', () => {
  afterEach(() => jest.clearAllMocks())

  it('rejects empty (whitespace) message', async () => {
    const req: any = {
      user: { _id: 'u1', username: 'u', email: 'u@example.com' },
      body: { receiverId: 'u2', message: '   ' }
    }
    const res: any = { json: jest.fn() }

    const repo: any = { save: jest.fn() }
    ;(AppDataSource.getRepository as jest.Mock).mockReturnValue(repo)

    await MessageController.sendMessage(req, res)

    expect(repo.save).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalled()
    const resp = res.json.mock.calls[0][0]
    expect(resp).toHaveProperty('status', 500)
    expect(resp.message).toMatch(/Message cannot be empty/)
  })

  it('rejects messages exceeding length limit', async () => {
    const long = JSON.stringify({ __encrypted: true, type: 1, body: 'a'.repeat(5001) })
    const req: any = {
      user: { _id: 'u1', username: 'u', email: 'u@example.com' },
      body: { receiverId: 'u2', message: long }
    }
    const res: any = { json: jest.fn() }

    const repo: any = { save: jest.fn() }
    ;(AppDataSource.getRepository as jest.Mock).mockReturnValue(repo)

    await MessageController.sendMessage(req, res)

    expect(repo.save).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalled()
    const resp = res.json.mock.calls[0][0]
    expect(resp.message).toMatch(/exceeds maximum length/)
  })

  it('rejects when sender and receiver are the same', async () => {
    const env = JSON.stringify({ __encrypted: true, type: 1, body: 'a' })
    const req: any = { user: { _id: 'same', username: 's', email: 's@example.com' }, body: { receiverId: 'same', message: env } }
    const res: any = { json: jest.fn() }

    const repo: any = { save: jest.fn() }
    ;(AppDataSource.getRepository as jest.Mock).mockReturnValue(repo)

    await MessageController.sendMessage(req, res)

    expect(repo.save).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalled()
    const resp = res.json.mock.calls[0][0]
    expect(resp.message).toMatch(/Sender and receiver cannot be the same user/)
  })

  it('maps unknown usernames to "Unknown User" in getConversations', async () => {
    const req: any = { params: { receiverId: 'r1' }, user: { _id: 'u1' } }
    const res: any = { json: jest.fn() }

    const conv = [{ userId: 'r1', lastMessage: 'x', lastMessageTime: new Date(), unreadCount: 0 }]
    const repo: any = { query: jest.fn().mockResolvedValue(conv) }
    ;(AppDataSource.getRepository as jest.Mock).mockReturnValue(repo)

    // Mock fetch to return an empty object so username is undefined
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as jest.Mock

    await MessageController.getConversations(req, res)

    expect(res.json).toHaveBeenCalled()
    const resp = res.json.mock.calls[0][0]
    expect(Array.isArray(resp.data)).toBe(true)
    expect(resp.data[0].username).toBe('Unknown User')
  })
})
