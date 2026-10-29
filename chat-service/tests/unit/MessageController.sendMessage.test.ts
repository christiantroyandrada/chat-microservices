// Tests for MessageController.sendMessage
jest.mock('../../src/services/RabbitMQService', () => ({ rabbitMQService: { getUserDetails: jest.fn() } }))
// We mock database and utils before importing the controller so the
// controller uses the mocked implementations.

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
import { handleMessageReceived } from '../../src/utils'
import { MessageSubmissionService } from '../../src/services/MessageSubmissionService'

describe('MessageController.sendMessage', () => {
  afterEach(() => { jest.clearAllMocks(); jest.restoreAllMocks() })

  const senderId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const otherId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const body = { receiverId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', message: '{"__encrypted":true,"body":"ciphertext"}' }

  it.each([null, [], [senderId], '', 7, 'invalid', ` ${senderId} `])('rejects invalid expectedSenderId %p without submission when middleware is bypassed', async expectedSenderId => {
    const submit = jest.spyOn(MessageSubmissionService.prototype, 'submit').mockResolvedValue({ message: {} as any, replayed: false })
    const next = jest.fn()
    await MessageController.sendMessage({ user: { _id: senderId }, body: { ...body, expectedSenderId } } as any, { json: jest.fn() } as any, next)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }))
    expect(submit).not.toHaveBeenCalled()
  })

  it('rejects a changed authenticated sender before submission', async () => {
    const submit = jest.spyOn(MessageSubmissionService.prototype, 'submit').mockResolvedValue({ message: {} as any, replayed: false })
    const next = jest.fn()
    await MessageController.sendMessage({ user: { _id: otherId }, body: { ...body, expectedSenderId: senderId } } as any, { json: jest.fn() } as any, next)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }))
    expect(submit).not.toHaveBeenCalled()
  })

  it('compares UUID case canonically and takes stored sender credentials only from authentication', async () => {
    const submit = jest.spyOn(MessageSubmissionService.prototype, 'submit').mockResolvedValue({ message: {} as any, replayed: false })
    const next = jest.fn()
    await MessageController.sendMessage({ user: { _id: senderId, username: 'alice', email: 'a@example.com' }, body: { ...body, expectedSenderId: senderId.toUpperCase(), senderId: otherId } } as any, { json: jest.fn() } as any, next)
    expect(next).not.toHaveBeenCalled()
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ senderId, senderName: 'alice', senderEmail: 'a@example.com' }))
  })

  it('succeeds when an encrypted envelope is provided', async () => {
    const mockReq: any = {
      user: { _id: 'sender1', username: 'alice', email: 'a@example.com' },
      body: {
        receiverId: 'receiver1',
        message: JSON.stringify({ __encrypted: true, type: 1, body: 'c3R1ZmY=' })
      }
    }

    const savedMessage = { id: 'm1', senderId: 'sender1', receiverId: 'receiver1' }
    const submit = jest.spyOn(MessageSubmissionService.prototype, 'submit').mockResolvedValue({ message: savedMessage as any, replayed: false })
    const repo: any = { save: jest.fn().mockResolvedValue(savedMessage) }
    ;(AppDataSource.getRepository as jest.Mock).mockReturnValue(repo)

    const mockRes: any = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await MessageController.sendMessage(mockReq, mockRes, jest.fn())

    expect(submit).toHaveBeenCalledWith({
      senderId: 'sender1',
      senderName: 'alice',
      senderEmail: 'a@example.com',
      receiverId: 'receiver1',
      encryptedEnvelope: mockReq.body.message,
      clientMessageId: undefined,
    })
    expect(repo.save).not.toHaveBeenCalled()
    expect(handleMessageReceived).not.toHaveBeenCalled()
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({ status: 200 }))
  })

  it('returns 400 when message is not a valid encrypted envelope', async () => {
    const mockReq: any = {
      user: { _id: 'sender1', username: 'alice', email: 'a@example.com' },
      body: {
        receiverId: 'receiver1',
        message: 'plain text'
      }
    }

    const repo: any = { save: jest.fn() }
    ;(AppDataSource.getRepository as jest.Mock).mockReturnValue(repo)

    const mockRes: any = { json: jest.fn(), status: jest.fn().mockReturnThis() }
    const mockNext = jest.fn()

    await MessageController.sendMessage(mockReq, mockRes, mockNext)

    // The controller now delegates errors to centralized error middleware via next().
    // Invalid envelope throws APIError which is passed to next().
    expect(repo.save).not.toHaveBeenCalled()
    expect(mockNext).toHaveBeenCalled()
  })
})
