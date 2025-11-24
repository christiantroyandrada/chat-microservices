// ESM-workarounds
jest.mock('uuid', () => ({ v4: () => 'mock-uuid' }))
jest.mock('amqplib', () => ({}))

const { requireControllerWithMock } = require('../utils/testHelpers')

describe('MessageController sendMessage branches', () => {
  beforeEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
  })

  it('returns error when receiverId is missing', async () => {
  // Minimal DB mock + controller require after mocks
  jest.doMock('../../src/utils', () => ({ APIError: class APIError extends Error { constructor(public statusCode:number, public message:string){ super(message) } }, handleMessageReceived: jest.fn() }))
  const { controller, repo } = requireControllerWithMock('../../src/controllers/MessageController', { saveResult: undefined })
  const mod = controller
  const MC = mod.default || mod

    const req: any = { user: { _id: 'u1', username: 'u1', email: 'u1@example.com' }, body: { message: JSON.stringify({ __encrypted: true, body: 'cipher' }) } }
    const res: any = { json: jest.fn() }

    await MC.sendMessage(req, res)

    const called = res.json.mock.calls[0][0]
    expect(called).toHaveProperty('message')
    expect(called.message).toMatch(/Receiver ID is required|Invalid message content/)
  })

  it('returns error when sender and receiver are the same', async () => {
  jest.doMock('../../src/utils', () => ({ APIError: class APIError extends Error { constructor(public statusCode:number, public message:string){ super(message) } }, handleMessageReceived: jest.fn() }))
  const { controller, repo } = requireControllerWithMock('../../src/controllers/MessageController', { saveResult: undefined })
  const mod = controller
  const MC = mod.default || mod

    const req: any = { user: { _id: 'u1', username: 'u1', email: 'u1@example.com' }, body: { receiverId: 'u1', message: JSON.stringify({ __encrypted: true, body: 'cipher' }) } }
    const res: any = { json: jest.fn() }

    await MC.sendMessage(req, res)

    const called = res.json.mock.calls[0][0]
    expect(called.message).toContain('Sender and receiver cannot be the same')
  })

  it('rejects invalid envelope (parse error)', async () => {
  jest.doMock('../../src/utils', () => ({ APIError: class APIError extends Error { constructor(public statusCode:number, public message:string){ super(message) } }, handleMessageReceived: jest.fn() }))
  const { controller, repo } = requireControllerWithMock('../../src/controllers/MessageController', { saveResult: undefined })
  const mod = controller
  const MC = mod.default || mod

    const req: any = { user: { _id: 'u1', username: 'u1', email: 'u1@example.com' }, body: { receiverId: 'u2', message: 'plain text' } }
    const res: any = { json: jest.fn() }

    await MC.sendMessage(req, res)

    const called = res.json.mock.calls[0][0]
    expect(called.message).toContain('Messages must be end-to-end encrypted')
  })

  it('rejects messages exceeding maximum length', async () => {
  jest.doMock('../../src/utils', () => ({ APIError: class APIError extends Error { constructor(public statusCode:number, public message:string){ super(message) } }, handleMessageReceived: jest.fn() }))
  const { controller, repo } = requireControllerWithMock('../../src/controllers/MessageController', { saveResult: undefined })

    const mod = controller
    const MC = mod.default || mod

    const long = 'a'.repeat(5001)
    const req: any = { user: { _id: 'u1', username: 'u1', email: 'u1@example.com' }, body: { receiverId: 'u2', message: long } }
    const res: any = { json: jest.fn() }

    await MC.sendMessage(req, res)

    const called = res.json.mock.calls[0][0]
    expect(called.message).toContain('Message exceeds maximum length')
  })

  it('succeeds for a valid envelope and calls save and notify', async () => {
  const saved = { id: 'm1', senderId: 'u1', receiverId: 'u2' }
  const handleMessageReceived = jest.fn().mockResolvedValue(undefined)
  jest.doMock('../../src/utils', () => ({ APIError: class APIError extends Error { constructor(public statusCode:number, public message:string){ super(message) } }, handleMessageReceived }))
  const { controller, repo } = requireControllerWithMock('../../src/controllers/MessageController', { saveResult: saved })
  const mod = controller
  const MC = mod.default || mod

    const envelope = JSON.stringify({ __encrypted: true, body: 'cipher' })
    const req: any = { user: { _id: 'u1', username: 'u1', email: 'u1@example.com' }, body: { receiverId: 'u2', message: envelope } }
    const res: any = { json: jest.fn() }

    await MC.sendMessage(req, res)

    expect(repo.save).toHaveBeenCalled()
    expect(handleMessageReceived).toHaveBeenCalled()
    const called = res.json.mock.calls[0][0]
    expect(called.status).toBe(200)
    expect(called.data).toEqual(saved)
  })
})
