// Prevent ESM-only modules from breaking Jest when modules are imported
jest.mock('uuid', () => ({ v4: () => 'mock-uuid' }))
jest.mock('amqplib', () => ({ connect: jest.fn() }))

import MessageController from '../../src/controllers/MessageController'
import { AppDataSource } from '../../src/database/connection'

describe('MessageController.getConversations', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    jest.resetAllMocks()
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

    // Mock fetch to return a user payload
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { id: 'u2', username: 'bob' } }) }) as any

    const req: any = { user: { _id: userId } , params: { } }
    const res: any = { json: jest.fn().mockImplementation((v) => v) }

    const outRaw = await MessageController.getConversations(req, res)
    const out: any = outRaw as any

    expect(repo.query).toHaveBeenCalled()
    expect(res.json).toHaveBeenCalled()
    expect(out.status).toBe(200)
    expect(Array.isArray(out.data)).toBe(true)
    expect(out.data[0].username).toBe('bob')
  })
})
