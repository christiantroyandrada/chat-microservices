// Mock the heavy sibling modules so importing socketHandler has no side effects.
// The _id (idempotent-resend) path under test only uses the injected messageRepo + ack.
jest.mock('../../src/database', () => ({
  AppDataSource: { getRepository: jest.fn() },
  Message: class {},
}))
jest.mock('../../src/utils', () => ({ handleMessageReceived: jest.fn() }))
jest.mock('../../src/utils/metrics', () => ({
  chatMessagesSentTotal: { inc: jest.fn() },
  chatPresenceChangesTotal: { inc: jest.fn() },
}))

let retrieveOrSaveMessage: typeof import('../../src/websocket/socketHandler').retrieveOrSaveMessage

beforeAll(() => {
  // Fake timers so the module-level compaction setInterval doesn't leak a handle.
  jest.useFakeTimers()
  retrieveOrSaveMessage = require('../../src/websocket/socketHandler').retrieveOrSaveMessage
})

afterAll(() => jest.useRealTimers())

const CALLER = 'alice'
const RECEIVER = 'bob'

function makeRepo(existing: any) {
  return { findOne: jest.fn().mockResolvedValue(existing) } as any
}
const baseParams = (repo: any, ack: any) => ({
  _id: 'msg-123',
  trimmed: '{"__encrypted":true,"body":"x"}',
  senderId: CALLER,
  receiverId: RECEIVER,
  messageRepo: repo,
  socket: { data: { user: { email: '' } } } as any,
  ack,
})

describe('retrieveOrSaveMessage — _id reuse ownership guard (IDOR)', () => {
  it('rejects reusing a message owned by a different sender', async () => {
    const foreign = { id: 'msg-123', senderId: 'mallory', receiverId: RECEIVER, isEncrypted: true }
    const repo = makeRepo(foreign)
    const ack = jest.fn()

    const result = await retrieveOrSaveMessage(baseParams(repo, ack))

    expect(result).toBeNull()
    expect(ack).toHaveBeenCalledWith({ ok: false, error: 'Message not found' })
  })

  it('rejects reusing a message addressed to a different receiver', async () => {
    const foreign = { id: 'msg-123', senderId: CALLER, receiverId: 'carol', isEncrypted: true }
    const repo = makeRepo(foreign)
    const ack = jest.fn()

    const result = await retrieveOrSaveMessage(baseParams(repo, ack))

    expect(result).toBeNull()
    expect(ack).toHaveBeenCalledWith({ ok: false, error: 'Message not found' })
  })

  it('allows the original sender to reuse their own message (idempotent resend)', async () => {
    const own = { id: 'msg-123', senderId: CALLER, receiverId: RECEIVER, isEncrypted: true }
    const repo = makeRepo(own)
    const ack = jest.fn()

    const result = await retrieveOrSaveMessage(baseParams(repo, ack))

    expect(result).toBe(own)
    expect(ack).not.toHaveBeenCalled()
  })
})
