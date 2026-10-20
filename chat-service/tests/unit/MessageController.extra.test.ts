// Prevent ESM-only dependencies from breaking Jest by providing simple mocks
jest.mock('uuid', () => ({ v4: () => 'mock-uuid' }))
jest.mock('amqplib', () => ({ connect: jest.fn() }))

import MessageController from '../../src/controllers/MessageController'
import { AppDataSource } from '../../src/database/connection'
import { Message } from '../../src/database'
import * as utils from '../../src/utils'
import { MessageSubmissionService } from '../../src/services/MessageSubmissionService'

describe('MessageController (extra)', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    jest.resetAllMocks()
  })
  afterEach(() => jest.restoreAllMocks())

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
    const res: any = { json: jest.fn(), status: jest.fn().mockReturnThis() }
    const next = jest.fn()

  await MessageController.sendMessage(req, res, next)

  expect(next).toHaveBeenCalled()
  // Expect our friendly API error message about encryption
  expect(next.mock.calls[0][0].message).toMatch(/end-to-end encrypted/i)
  })

  test('sendMessage returns the durable submission result without direct storage or notification', async () => {
    const saved = { id: 1, senderId: 's1', receiverId: 'r1', message: '{"__encrypted":true,"body":"c"}' }
    const repo: any = { save: jest.fn().mockResolvedValue(saved) }
    jest.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any)

    const handleSpy = jest.spyOn(utils, 'handleMessageReceived').mockResolvedValue(undefined as any)
    const submit = jest.spyOn(MessageSubmissionService.prototype, 'submit').mockResolvedValue({ message: saved as any, replayed: false })

    // create a valid envelope
    const envelope = JSON.stringify({ __encrypted: true, body: 'c' })
    const req: any = { body: { receiverId: 'r1', message: envelope }, user: { _id: 's1', email: 'a@b.com', username: 'u' } }
    const res: any = { json: jest.fn().mockImplementation((v) => v), status: jest.fn().mockReturnThis() }

  const outRaw = await MessageController.sendMessage(req, res, jest.fn())
  const out: any = outRaw as any

  expect(submit).toHaveBeenCalledWith({ senderId: 's1', receiverId: 'r1', encryptedEnvelope: envelope, clientMessageId: undefined, senderName: 'u', senderEmail: 'a@b.com' })
  expect(repo.save).not.toHaveBeenCalled()
  expect(handleSpy).not.toHaveBeenCalled()
  expect(out.status).toBe(200)
  expect(out.data).toEqual(saved)
  })
})
