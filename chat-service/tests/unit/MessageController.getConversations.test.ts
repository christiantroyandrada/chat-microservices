// Prevent ESM-only modules from breaking Jest when modules are imported
jest.mock('uuid', () => ({ v4: () => 'mock-uuid' }))
jest.mock('amqplib', () => ({ connect: jest.fn() }))
jest.mock('../../src/services/RabbitMQService', () => ({ rabbitMQService: { getUserDetails: jest.fn() } }))

import MessageController, { clearUserDetailCache } from '../../src/controllers/MessageController'
import { AppDataSource } from '../../src/database/connection'
import { rabbitMQService } from '../../src/services/RabbitMQService'
import type { UserDetailsCallback } from '../../src/types'

describe('MessageController.getConversations', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    jest.resetAllMocks()
    clearUserDetailCache()
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => null })
  })

  afterAll(() => {
    global.fetch = originalFetch
  })

  test('fetches conversations and enriches with username', async () => {
    const userId = 'user-1'
    const conversationsRaw = [
      { userId: 'u2', lastMessageSenderId: 'u2', lastMessage: 'hey', lastMessageTime: '2020-01-01', unreadCount: 1 }
    ]

    const repo: any = { query: jest.fn().mockResolvedValue(conversationsRaw) }
    jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any)

    const http = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { id: 'u2', username: 'bob' } }) })
    global.fetch = http
    jest.mocked(rabbitMQService.getUserDetails).mockImplementation(async (id, callback) => {
      callback({ id, username: 'bob', email: 'bob@example.com' })
    })

    const req: any = { user: { _id: userId }, params: {}, cookies: { jwt: 'private-session-token' } }
    const res: any = { json: jest.fn().mockImplementation((v) => v) }

    const outRaw = await MessageController.getConversations(req, res, jest.fn())
    const out: any = outRaw as any

    expect(repo.query).toHaveBeenCalled()
    expect(res.json).toHaveBeenCalled()
    expect(out.status).toBe(200)
    expect(Array.isArray(out.data)).toBe(true)
    expect(out.data[0].username).toBe('bob')
    expect(rabbitMQService.getUserDetails).toHaveBeenCalledWith('u2', expect.any(Function))
    expect(http).not.toHaveBeenCalled()
    await MessageController.getConversations(req, res, jest.fn())
    expect(rabbitMQService.getUserDetails).toHaveBeenCalledTimes(1)
  })

  test.each([null, { username: 42 }, { error: 'not found' }])('degrades malformed or missing broker reply %p without corrupting the public contract', async reply => {
    const repo = { query: jest.fn().mockResolvedValue([{ userId: 'u2', unreadCount: 0 }]) }
    jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any)
    jest.mocked(rabbitMQService.getUserDetails).mockImplementation(async (_id, callback) => {
      callback(reply as unknown as Parameters<UserDetailsCallback>[0])
    })
    const res: any = { json: jest.fn() }
    await MessageController.getConversations({ user: { _id: 'u1' } } as any, res, jest.fn())
    expect(res.json.mock.calls[0][0].data[0]).toMatchObject({ username: 'Unknown User', name: 'Unknown User' })
  })

  test('broker rejection resolves promptly without HTTP fallback and is retried on the next request', async () => {
    const repo = { query: jest.fn().mockResolvedValue([{ userId: 'u2', unreadCount: 0 }]) }
    jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any)
    jest.mocked(rabbitMQService.getUserDetails).mockRejectedValue(new Error('broker unavailable'))
    global.fetch = jest.fn()
    const res: any = { json: jest.fn() }
    for (let i = 0; i < 2; i++) await MessageController.getConversations({ user: { _id: 'u1' } } as any, res, jest.fn())
    expect(res.json).toHaveBeenCalledTimes(2)
    expect(res.json.mock.calls[0][0].data[0].name).toBe('Unknown User')
    expect(rabbitMQService.getUserDetails).toHaveBeenCalledTimes(2)
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
