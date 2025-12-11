// Mock ESM-only modules before importing application code
jest.mock('uuid', () => ({ v4: () => 'mock-uuid' }))
jest.mock('amqplib', () => ({ connect: jest.fn() }))

import MessageController from '../../src/controllers/MessageController'
import { AppDataSource } from '../../src/database/connection'

describe('MessageController additional branches', () => {
  const originalFetch = global.fetch

  beforeEach(() => jest.resetAllMocks())
  afterAll(() => { global.fetch = originalFetch })

  test('sendMessage - sender and receiver same triggers validation error', async () => {
    const req: any = { body: { receiverId: 'same', message: JSON.stringify({ __encrypted: true, body: 'x' }) }, user: { _id: 'same', email: 'a@b', username: 'u' } }
    const res: any = { json: jest.fn().mockImplementation((v) => v), status: jest.fn().mockReturnThis() }

    const outRaw = await MessageController.sendMessage(req, res)
    const out: any = outRaw as any

    expect(res.json).toHaveBeenCalled()
    expect(out.message).toMatch(/Sender and receiver cannot be the same user/i)
  })

  test('sendMessage - empty message (only whitespace) returns friendly error', async () => {
    const req: any = { body: { receiverId: 'r1', message: '   ' }, user: { _id: 's1', email: 'a@b', username: 'u' } }
    const res: any = { json: jest.fn().mockImplementation((v) => v), status: jest.fn().mockReturnThis() }

    const outRaw = await MessageController.sendMessage(req, res)
    const out: any = outRaw as any

    expect(out.message).toMatch(/Message cannot be empty/i)
  })

  test('sendMessage - message exceeds max length', async () => {
    const long = 'x'.repeat(5001)
    const req: any = { body: { receiverId: 'r1', message: long }, user: { _id: 's1', email: 'a@b', username: 'u' } }
    const res: any = { json: jest.fn().mockImplementation((v) => v), status: jest.fn().mockReturnThis() }

    const outRaw = await MessageController.sendMessage(req, res)
    const out: any = outRaw as any

    expect(out.message).toMatch(/exceeds maximum length of 5000/i)
  })

  test('sendMessage - missing receiverId returns receiver required message', async () => {
    const req: any = { body: { message: JSON.stringify({ __encrypted: true, body: 'x' }) }, user: { _id: 's1', email: 'a@b', username: 'u' } }
    const res: any = { json: jest.fn().mockImplementation((v) => v), status: jest.fn().mockReturnThis() }

    const outRaw = await MessageController.sendMessage(req, res)
    const out: any = outRaw as any

    expect(out.message).toMatch(/Receiver ID is required/i)
  })

  test('fetchConversation - DB throws and returns 500', async () => {
    const repo: any = { createQueryBuilder: jest.fn().mockImplementation(() => { throw new Error('db fail') }) }
    jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any)

    const req: any = { params: { receiverId: 'r2' }, user: { _id: 's1' } }
    const res: any = { json: jest.fn().mockImplementation((v) => v), status: jest.fn().mockReturnThis() }

    const outRaw = await MessageController.fetchConversation(req, res)
    const out: any = outRaw as any

    expect(res.json).toHaveBeenCalled()
    expect(out.status).toBe(500)
  })

  test('getConversations - when user fetch fails username becomes Unknown User', async () => {
    const conversationsRaw = [ { userId: 'u2', lastMessageSenderId: 'u2', lastMessage: 'hi', lastMessageTime: 't', unreadCount: 0 } ]
    const repo: any = { query: jest.fn().mockResolvedValue(conversationsRaw) }
    jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any)

    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 }) as any

    const req: any = { user: { _id: 's1' } }
    const res: any = { json: jest.fn().mockImplementation((v) => v), status: jest.fn().mockReturnThis() }

    const outRaw = await MessageController.getConversations(req, res)
    const out: any = outRaw as any

    expect(out.status).toBe(200)
    expect(out.data[0].username).toBe('Unknown User')
  })

  test('markAsRead - missing senderId returns 400 message', async () => {
    const req: any = { params: { }, user: { _id: 'r1' } }
    const res: any = { json: jest.fn().mockImplementation((v) => v), status: jest.fn().mockReturnThis() }

    const outRaw = await MessageController.markAsRead(req, res)
    const out: any = outRaw as any

    expect(out.message).toMatch(/Sender ID is required/i)
  })
})
