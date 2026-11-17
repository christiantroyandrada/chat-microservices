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

  test('relays a new durable message and skips replayed or rejected submissions', async () => {
    const url = 'http://127.0.0.1:8090/internal/messages'
    const token = 'fixture-bridge-token-for-local-tests'
    const saved = {
      id: '11111111-1111-4111-8111-111111111111',
      senderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      receiverId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      message: ' {"__encrypted":true,"body":"QUJD"} ',
      status: 'NotDelivered',
      createdAt: new Date('2026-11-17T08:00:00Z'),
    }
    const submit = jest.spyOn(MessageSubmissionService.prototype, 'submit')
      .mockResolvedValueOnce({ message: saved as Message, replayed: false })
      .mockResolvedValueOnce({ message: saved as Message, replayed: true })
      .mockRejectedValueOnce(new Error('transaction failed'))
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
    const env = jest.replaceProperty(process, 'env', {
      ...process.env, GO_WS_BRIDGE_URL: url, GO_WS_BRIDGE_TOKEN: token,
    })
    const req = {
      body: { receiverId: saved.receiverId, message: saved.message },
      user: { _id: saved.senderId, email: 'alice@example.test', username: 'alice' },
    } as Parameters<typeof MessageController.sendMessage>[0]
    const json = jest.fn()
    const res = { json } as unknown as Parameters<typeof MessageController.sendMessage>[1]
    const next = jest.fn()
    try {
      await MessageController.sendMessage(req, res, next)
      expect(json).toHaveBeenCalledWith(expect.objectContaining({ status: 200, data: saved }))
      expect(fetch).toHaveBeenCalledWith(url, expect.objectContaining({
        method: 'POST', headers: expect.objectContaining({ authorization: `Bearer ${token}` }),
        body: JSON.stringify(saved), redirect: 'error',
      }))
      expect(submit.mock.invocationCallOrder[0]).toBeLessThan(fetch.mock.invocationCallOrder[0])
      await MessageController.sendMessage(req, res, next)
      await MessageController.sendMessage(req, res, next)
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(next).toHaveBeenCalledTimes(1)
    } finally {
      env.restore()
    }
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
