// Additional MessageController tests: empty, too-long, sender==receiver, unknown username mapping

describe('MessageController additional sendMessage validations', () => {
  afterEach(() => jest.clearAllMocks())

  it('rejects empty (whitespace) message', async () => {
    const { mockRepoWith } = require('../utils/dbMock')
    mockRepoWith({ saveResult: undefined })
    jest.doMock('../../src/utils', () => ({
      APIError: class APIError extends Error {
        constructor(public statusCode: number, message: string) {
          super(message)
        }
      },
      handleMessageReceived: jest.fn().mockResolvedValue(undefined)
    }))

  const { requireControllerAfterMocks } = require('../utils/testHelpers')
  const { controller } = requireControllerAfterMocks('../../src/controllers/MessageController')
  const MessageController = controller.default || controller

    const req: any = {
      user: { _id: 'u1', username: 'u', email: 'u@example.com' },
      body: { receiverId: 'u2', message: '   ' }
    }
    const res: any = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await MessageController.sendMessage(req, res)

    expect(res.json).toHaveBeenCalled()
    const resp = res.json.mock.calls[0][0]
    expect(resp).toHaveProperty('status', 400)
    expect(resp.message).toMatch(/Message cannot be empty/)
  })

  it('rejects messages exceeding length limit', async () => {
    const { mockRepoWith } = require('../utils/dbMock')
    mockRepoWith({ saveResult: undefined })
    jest.doMock('../../src/utils', () => ({
      APIError: class APIError extends Error {
        constructor(public statusCode: number, message: string) {
          super(message)
        }
      },
      handleMessageReceived: jest.fn().mockResolvedValue(undefined)
    }))

  const { requireControllerAfterMocks } = require('../utils/testHelpers')
  const { controller } = requireControllerAfterMocks('../../src/controllers/MessageController')
  const MessageController = controller.default || controller

    const long = JSON.stringify({ __encrypted: true, type: 1, body: 'a'.repeat(5001) })
    const req: any = {
      user: { _id: 'u1', username: 'u', email: 'u@example.com' },
      body: { receiverId: 'u2', message: long }
    }
    const res: any = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await MessageController.sendMessage(req, res)

    expect(res.json).toHaveBeenCalled()
    const resp = res.json.mock.calls[0][0]
    expect(resp.message).toMatch(/exceeds maximum length/)
  })

  it('rejects when sender and receiver are the same', async () => {
    const { mockRepoWith } = require('../utils/dbMock')
    mockRepoWith({ saveResult: undefined })
    jest.doMock('../../src/utils', () => ({
      APIError: class APIError extends Error {
        constructor(public statusCode: number, message: string) {
          super(message)
        }
      },
      handleMessageReceived: jest.fn().mockResolvedValue(undefined)
    }))

  const { requireControllerAfterMocks } = require('../utils/testHelpers')
  const { controller } = requireControllerAfterMocks('../../src/controllers/MessageController')
  const MessageController = controller.default || controller

    const env = JSON.stringify({ __encrypted: true, type: 1, body: 'a' })
    const req: any = { user: { _id: 'same', username: 's', email: 's@example.com' }, body: { receiverId: 'same', message: env } }
    const res: any = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await MessageController.sendMessage(req, res)

    expect(res.json).toHaveBeenCalled()
    const resp = res.json.mock.calls[0][0]
    expect(resp.message).toMatch(/Sender and receiver cannot be the same user/)
  })

  it('maps unknown usernames to "Unknown User" in getConversations', async () => {
  const { mockRepoWith } = require('../utils/dbMock')
  const conv = [{ userId: 'r1', lastMessage: 'x', lastMessageTime: new Date(), unreadCount: 0 }]
  mockRepoWith({ queryResult: conv })

  // Mock fetch to return an empty object so username is undefined
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as jest.Mock

  const { requireControllerAfterMocks } = require('../utils/testHelpers')
  const { controller } = requireControllerAfterMocks('../../src/controllers/MessageController')
  const req: any = { params: { receiverId: 'r1' }, user: { _id: 'u1' } }
  const res: any = { json: jest.fn(), status: jest.fn().mockReturnThis() }

  await controller.getConversations(req, res)

    expect(res.json).toHaveBeenCalled()
    const resp = res.json.mock.calls[0][0]
    expect(Array.isArray(resp.data)).toBe(true)
    expect(resp.data[0].username).toBe('Unknown User')
  })
})
