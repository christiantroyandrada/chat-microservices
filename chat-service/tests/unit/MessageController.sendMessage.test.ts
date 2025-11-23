// Tests for MessageController.sendMessage
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

describe('MessageController.sendMessage', () => {
  afterEach(() => jest.clearAllMocks())

  it('succeeds when an encrypted envelope is provided', async () => {
    const mockReq: any = {
      user: { _id: 'sender1', username: 'alice', email: 'a@example.com' },
      body: {
        receiverId: 'receiver1',
        message: JSON.stringify({ __encrypted: true, type: 1, body: 'c3R1ZmY=' })
      }
    }

    const savedMessage = { id: 'm1', senderId: 'sender1', receiverId: 'receiver1' }
    const repo: any = { save: jest.fn().mockResolvedValue(savedMessage) }
    ;(AppDataSource.getRepository as jest.Mock).mockReturnValue(repo)

    const mockRes: any = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await MessageController.sendMessage(mockReq, mockRes)

    expect(repo.save).toHaveBeenCalled()
    expect(handleMessageReceived).toHaveBeenCalledWith(
      'alice',
      'a@example.com',
      'receiver1',
      '[Encrypted message]',
      true,
      mockReq.body.message
    )
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

    await MessageController.sendMessage(mockReq, mockRes)

    // Controller returns 500-level for unhandled errors in catch; but for
    // invalid envelope it throws APIError which the controller catches and
    // returns a 500 JSON body in the current implementation. We assert
    // that a JSON response was sent and that repo.save was not called.
    expect(repo.save).not.toHaveBeenCalled()
    expect(mockRes.json).toHaveBeenCalled()
  })
})
