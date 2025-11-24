// Prevent ESM-only dependencies from breaking Jest by providing simple mocks
jest.mock('uuid', () => ({ v4: () => 'mock-uuid' }))
jest.mock('amqplib', () => ({ connect: jest.fn() }))

import MessageController from '../../src/controllers/MessageController'
import { AppDataSource } from '../../src/database/connection'
import { Message } from '../../src/database'
import * as utils from '../../src/utils'

describe('MessageController (extra)', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    jest.resetAllMocks()
  })

  afterAll(() => {
    global.fetch = originalFetch
  })

  test('sendMessage - invalid envelope (non-JSON) returns error message', async () => {
    // Mock repository
    const repo: any = { save: jest.fn() }
    jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any)

    // Mock handleMessageReceived so it doesn't throw
    jest.spyOn(utils, 'handleMessageReceived').mockResolvedValue(undefined as any)

    // No remote fetch required for this test
    global.fetch = jest.fn()

    const req: any = { body: { receiverId: 'r1', message: 'not-a-json' }, user: { _id: 's1', email: 'a@b.com', username: 'u' } }
    const res: any = { json: jest.fn().mockImplementation((v) => v) }

  const outRaw = await MessageController.sendMessage(req, res)
  const out: any = outRaw as any

  expect(res.json).toHaveBeenCalled()
  // Expect our friendly API error message about encryption
  expect(out.message).toMatch(/end-to-end encrypted/i)
  })

  test('sendMessage - success path stores message and notifies', async () => {
    const saved = { id: 1, senderId: 's1', receiverId: 'r1', message: '{"__encrypted":true,"body":"c"}' }
    const repo: any = { save: jest.fn().mockResolvedValue(saved) }
    jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any)

    const handleSpy = jest.spyOn(utils, 'handleMessageReceived').mockResolvedValue(undefined as any)

    // create a valid envelope
    const envelope = JSON.stringify({ __encrypted: true, body: 'c' })
    const req: any = { body: { receiverId: 'r1', message: envelope }, user: { _id: 's1', email: 'a@b.com', username: 'u' } }
    const res: any = { json: jest.fn().mockImplementation((v) => v) }

  const outRaw = await MessageController.sendMessage(req, res)
  const out: any = outRaw as any

  expect(repo.save).toHaveBeenCalled()
  expect(handleSpy).toHaveBeenCalled()
  expect(out.status).toBe(200)
  expect(out.data).toEqual(saved)
  })
})
