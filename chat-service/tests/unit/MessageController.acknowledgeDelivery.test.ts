jest.mock('uuid', () => ({ v4: () => 'mock-uuid' }))
jest.mock('amqplib', () => ({ connect: jest.fn() }))

const messageId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const senderId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const receiverId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

describe('MessageController.acknowledgeDelivery', () => {
  let markMessageDelivered: jest.Mock
  let controller: any

  beforeEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
    markMessageDelivered = jest.fn()
    jest.doMock('../../src/database', () => ({ AppDataSource: {}, Message: class {} }))
    jest.doMock('../../src/services/messageReceipts', () => ({ markMessageDelivered }))
    controller = require('../../src/controllers/MessageController').default
  })

  const request = (overrides: any = {}) => ({
    params: { messageId },
    query: { expectedUserId: receiverId },
    user: { _id: receiverId },
    app: { locals: { onMessageDelivered: jest.fn() } },
    ...overrides,
  })

  test('acknowledges a new delivery and notifies the sender', async () => {
    markMessageDelivered.mockResolvedValue({ senderId, changed: true })
    const req = request()
    const res = { json: jest.fn() }

    await controller.acknowledgeDelivery(req, res, jest.fn())

    expect(markMessageDelivered).toHaveBeenCalledWith(messageId, receiverId)
    expect(req.app.locals.onMessageDelivered).toHaveBeenCalledWith(senderId, messageId, receiverId)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: { modifiedCount: 1 } }))
  })

  test('returns replay success without notifying again', async () => {
    markMessageDelivered.mockResolvedValue({ senderId, changed: false })
    const req = request()

    const json = jest.fn()
    await controller.acknowledgeDelivery(req, { json }, jest.fn())

    expect(req.app.locals.onMessageDelivered).not.toHaveBeenCalled()
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ data: { modifiedCount: 0 } }))
  })

  test('acknowledges stored delivery when the optional live callback is absent', async () => {
    markMessageDelivered.mockResolvedValue({ senderId, changed: true })
    const json = jest.fn()
    await controller.acknowledgeDelivery(request({ app: { locals: {} } }), { json }, jest.fn())
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ data: { modifiedCount: 1 } }))
  })

  test.each([
    ['missing expected user ID', { query: {} }, 'Expected user ID is required'],
    ['mismatched expected user ID', { query: { expectedUserId: senderId } }, 'Expected user does not match authenticated user'],
    ['invalid message UUID', { params: { messageId: 'not-a-uuid' } }, 'Message ID must be a valid UUID'],
  ])('%s', async (_name, overrides, message) => {
    const next = jest.fn()
    await controller.acknowledgeDelivery(request(overrides), { json: jest.fn() }, next)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message }))
    expect(markMessageDelivered).not.toHaveBeenCalled()
  })

  test('rejects a missing or unauthorized recipient message', async () => {
    markMessageDelivered.mockResolvedValue(null)
    const next = jest.fn()

    await controller.acknowledgeDelivery(request(), { json: jest.fn() }, next)

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404, message: 'Message not found' }))
  })

  test('passes receipt storage failures to next', async () => {
    const failure = new Error('storage unavailable')
    markMessageDelivered.mockRejectedValue(failure)
    const next = jest.fn()

    await controller.acknowledgeDelivery(request(), { json: jest.fn() }, next)

    expect(next).toHaveBeenCalledWith(failure)
  })
})
