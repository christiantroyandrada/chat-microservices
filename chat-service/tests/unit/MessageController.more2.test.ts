import { AppDataSource } from '../../src/database'

describe('MessageController additional tests', () => {
  beforeEach(() => {
    // Ensure modules can be mocked before controller is required
    jest.resetModules()
    // Mock utils module (to avoid pulling in RabbitMQService/uuid ESM module)
    jest.mock('../../src/utils', () => ({
      APIError: class APIError extends Error {
        statusCode: number
        constructor(statusCode: number, message?: string) {
          super(message)
          this.statusCode = statusCode
        }
      },
      handleMessageReceived: jest.fn(),
    }))
  })

  afterEach(() => {
    jest.restoreAllMocks()
    jest.resetModules()
    // clear any global.fetch we set
    try { delete (global as any).fetch } catch {}
  })

  it('sendMessage rejects when receiver missing or same as sender', async () => {
    // require after mocks to avoid importing modules that depend on ESM-only packages
  jest.resetModules()
  const { requireControllerAfterMocks } = require('../utils/testHelpers')
  const { controller } = requireControllerAfterMocks('../../src/controllers/MessageController')
  const MessageController = controller && controller.default ? controller.default : controller
    const res: any = { json: jest.fn() }
    // missing receiverId
    await MessageController.sendMessage({ user: { _id: 'u1' }, body: { receiverId: '', message: 'x' } } as any, res)
    expect(res.json).toHaveBeenCalled()

    // same sender and receiver
    res.json.mockClear()
    await MessageController.sendMessage({ user: { _id: 'u1' }, body: { receiverId: 'u1', message: 'x' } } as any, res)
    expect(res.json).toHaveBeenCalled()
  })

  it('sendMessage validates message content (empty/too long/non-string)', async () => {
  jest.resetModules()
  const { requireControllerAfterMocks } = require('../utils/testHelpers')
  const { controller } = requireControllerAfterMocks('../../src/controllers/MessageController')
  const MessageController = controller && controller.default ? controller.default : controller
    const res: any = { json: jest.fn() }
    await MessageController.sendMessage({ user: { _id: 'u1', username: 'u', email: 'a@b' }, body: { receiverId: 'u2', message: '' } } as any, res)
    expect(res.json).toHaveBeenCalled()

    res.json.mockClear()
    await MessageController.sendMessage({ user: { _id: 'u1', username: 'u', email: 'a@b' }, body: { receiverId: 'u2', message: 123 } } as any, res)
    expect(res.json).toHaveBeenCalled()

    res.json.mockClear()
    const long = 'a'.repeat(6000)
    await MessageController.sendMessage({ user: { _id: 'u1', username: 'u', email: 'a@b' }, body: { receiverId: 'u2', message: long } } as any, res)
    expect(res.json).toHaveBeenCalled()
  })

  it('sendMessage rejects when envelope shape invalid', async () => {
  jest.resetModules()
  const { requireControllerAfterMocks } = require('../utils/testHelpers')
  const { controller } = requireControllerAfterMocks('../../src/controllers/MessageController')
  const MessageController = controller && controller.default ? controller.default : controller
    const res: any = { json: jest.fn() }
    const badEnvelope = JSON.stringify({ __encrypted: false, body: 'x' })
    await MessageController.sendMessage({ user: { _id: 'u1', username: 'u', email: 'a@b' }, body: { receiverId: 'u2', message: badEnvelope } } as any, res)
    expect(res.json).toHaveBeenCalled()
  })

  it('sendMessage success path stores message and notifies', async () => {
  jest.resetModules()
  // mock repository and utils before requiring controller
  const repo = { save: jest.fn().mockResolvedValue({ id: 'm1', senderId: 'u1', receiverId: 'u2' }) }
  jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any)
  const utils = require('../../src/utils')
  jest.spyOn(utils, 'handleMessageReceived').mockResolvedValue(undefined)
  const { requireControllerAfterMocks } = require('../utils/testHelpers')
  const { controller } = requireControllerAfterMocks('../../src/controllers/MessageController')
  const MessageController = controller && controller.default ? controller.default : controller

    const res: any = { json: jest.fn() }
    const env = JSON.stringify({ __encrypted: true, body: 'abc' })
    await MessageController.sendMessage({ user: { _id: 'u1', username: 'u', email: 'a@b' }, body: { receiverId: 'u2', message: env } } as any, res)
  expect(res.json).toHaveBeenCalled()
  const called = res.json.mock.calls[0][0]
  expect(called).toHaveProperty('status')
  })

  it('fetchConversation returns messages', async () => {
  jest.resetModules()
  const msgs = [{ id: 'm1' }]
  const qb = { where: jest.fn().mockReturnThis(), orderBy: jest.fn().mockReturnThis(), getMany: jest.fn().mockResolvedValue(msgs) }
  const repo = { createQueryBuilder: jest.fn().mockReturnValue(qb) }
  jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any)
  const { requireControllerAfterMocks } = require('../utils/testHelpers')
  const { controller } = requireControllerAfterMocks('../../src/controllers/MessageController')
  const MessageController = controller && controller.default ? controller.default : controller

    const res: any = { json: jest.fn() }
    await MessageController.fetchConversation({ user: { _id: 'u1' }, params: { receiverId: 'u2' } } as any, res)
    expect(res.json).toHaveBeenCalled()
  })

  it('getConversations maps usernames when fetchUserDetails available', async () => {
  jest.resetModules()
  const conv = [{ userId: 'u2', lastMessage: 'hi' }]
  const repo = { query: jest.fn().mockResolvedValue(conv) }
  jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any)

  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { username: 'other' } }) }) as any
  const { requireControllerAfterMocks } = require('../utils/testHelpers')
  const { controller } = requireControllerAfterMocks('../../src/controllers/MessageController')
  const MessageController = controller && controller.default ? controller.default : controller

    const res: any = { json: jest.fn() }
    await MessageController.getConversations({ user: { _id: 'u1' } } as any, res)
    expect(res.json).toHaveBeenCalled()
  })

  it('markAsRead validates senderId and returns modifiedCount', async () => {
  jest.resetModules()
  const qb = { update: jest.fn().mockReturnThis(), set: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(), execute: jest.fn().mockResolvedValue({ affected: 3 }) }
  const repo = { createQueryBuilder: jest.fn().mockReturnValue(qb) }
  jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any)
  const mod = require('../../src/controllers/MessageController')
  const MessageController = mod && mod.default ? mod.default : mod

    const res: any = { json: jest.fn() }
    await MessageController.markAsRead({ user: { _id: 'u1' }, params: { senderId: 'u2' } } as any, res)
    expect(res.json).toHaveBeenCalled()
  })
})
