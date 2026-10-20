import MessageController from '../../src/controllers/MessageController'
jest.mock('../../src/services/RabbitMQService', () => ({ rabbitMQService: { getUserDetails: jest.fn() } }))
import { AppDataSource } from '../../src/database'
import { Message } from '../../src/database/models/MessageModel'
import { validationResult } from 'express-validator'
import { fetchConversationValidation } from '../../src/middleware/validation/messageValidation'

afterEach(() => jest.restoreAllMocks())

describe('MessageController.fetchConversation', () => {
  it('returns messages for conversation', async () => {
    const req: any = { params: { receiverId: 'user2' }, user: { _id: 'user1' }, query: {} }
    const res: any = { json: jest.fn(), status: jest.fn().mockReturnThis() }
    const queryBuilder = {
      where: jest.fn().mockReturnThis(), orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(), take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[{ id: 'm1' }], 1]),
    }
    jest.spyOn(AppDataSource, 'getRepository').mockReturnValue({ createQueryBuilder: () => queryBuilder } as any)
    await MessageController.fetchConversation(req, res, jest.fn())
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: [{ id: 'm1' }], pagination: { total: 1, limit: 50, offset: 0, hasMore: false } }))
  })

  it.each([
    ['limit', '0'], ['limit', '201'], ['limit', '1.5'], ['limit', '-1'],
    ['offset', '-1'], ['offset', '1.5'], ['offset', '9007199254740992'],
    ['offset', '999999999999999999999999999999999999999999999999999999999999'],
  ])('rejects invalid %s query value %s before pagination reaches the controller', async (key, value) => {
    const req: any = { params: { receiverId: '00000000-0000-4000-8000-000000000002' }, query: { [key]: value } }
    await Promise.all(fetchConversationValidation.map(chain => chain.run(req)))
    expect(validationResult(req).array()).not.toHaveLength(0)
  })

  it('rejects an unsafe offset in the controller even when middleware is bypassed', async () => {
    const req: any = { params: { receiverId: 'user2' }, user: { _id: 'user1' }, query: { limit: '1', offset: '999999999999999999999999999999999999999999999999999999999999' } }
    const next = jest.fn()
    const messageRepo = { createQueryBuilder: jest.fn() }
    jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(messageRepo as any)
    await MessageController.fetchConversation(req, { json: jest.fn() } as any, next)
    expect(messageRepo.createQueryBuilder).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }))
  })
})

describe('MessageController.sendMessage durable command', () => {
  const envelope = ' \n{"__encrypted":true,"body":"ciphertext"}\t '
  let messages: any[]
  let events: any[]
  beforeEach(() => {
    messages = []
    events = []
    const repository = {
      create: (value: any) => ({ id: '10000000-0000-4000-8000-000000000001', ...value }),
      save: async (value: any) => { messages.push(value); return value },
    }
    const manager = { getRepository: (entity: unknown) => entity === Message ? repository : { insert: async (value: any) => { events.push(value) } } }
    jest.spyOn(AppDataSource, 'transaction').mockImplementation(async (...args: any[]) => args[args.length - 1](manager))
  })

  it('invokes the handler and stores the response message and its durable encrypted event', async () => {
    const res: any = { json: jest.fn() }
    const next = jest.fn()
    await MessageController.sendMessage({ user: { _id: 'sender', username: 'Sender', email: 'sender@example.test' }, body: { receiverId: 'receiver', message: envelope } } as any, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ senderId: 'sender', receiverId: 'receiver', message: envelope, status: 'NotDelivered', isEncrypted: true })
    expect(events).toHaveLength(1)
    expect(events[0].payload).toMatchObject({ eventId: events[0].id, userId: 'receiver', envelope, message: '[Encrypted message]' })
    expect(res.json).toHaveBeenCalledWith({ status: 200, message: 'Message sent successfully', data: messages[0] })
  })

  it.each(['plaintext', '   ', 'x'.repeat(5001)])('rejects invalid content without persistence', async message => {
    const next = jest.fn()
    await MessageController.sendMessage({ user: { _id: 'sender', username: 'Sender', email: 'sender@example.test' }, body: { receiverId: 'receiver', message } } as any, { json: jest.fn() } as any, next)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }))
    expect(messages).toEqual([])
    expect(events).toEqual([])
  })
})
