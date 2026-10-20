import { LocalPresenceStore } from '../../src/services/PresenceStore'
import { MessageSubmissionService } from '../../src/services/MessageSubmissionService'
import { registerSocketHandlers } from '../../src/websocket/socketHandler'
import { logError, logWarn } from '../../src/utils/logger'
jest.mock('../../src/utils/logger', () => ({ logError: jest.fn(), logWarn: jest.fn(), logInfo: jest.fn(), logDebug: jest.fn() }))

const senderId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const receiverId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
function fixture() {
  const events = new Map<string, (...args: any[]) => any>()
  const emit = jest.fn()
  const io: any = { emit, to: jest.fn(() => ({ emit })) }
  const socket: any = { id: 'fixture', data: { user: { id: senderId, username: 'Sender', email: 'sender@example.test' } }, join: jest.fn(), emit, on: (name: string, handler: (...args: any[]) => any) => events.set(name, handler) }
  const presence = new LocalPresenceStore()
  registerSocketHandlers(io, socket, presence)
  return { events, io, emit, presence }
}
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve() }
afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks() })

it('ignores malformed typing payloads and still routes valid typing to the canonical receiver', async () => {
  const { events, io, emit } = fixture()
  await flush()
  emit.mockClear()
  for (const value of [undefined, null, 7, {}, { receiverId: null, isTyping: true }, { receiverId, isTyping: 'true' }]) {
    expect(() => events.get('typing')!(value)).not.toThrow()
  }
  expect(emit).not.toHaveBeenCalled()
  events.get('typing')!({ receiverId: receiverId.toUpperCase(), isTyping: false })
  expect(io.to).toHaveBeenCalledWith(receiverId)
  expect(emit).toHaveBeenCalledWith('typing', { userId: senderId, isTyping: false })
})

it('observes a failed acknowledgement once without retrying it or exposing its error', async () => {
  const { events } = fixture()
  jest.spyOn(MessageSubmissionService.prototype, 'submit').mockResolvedValue({ replayed: true, message: { id: receiverId, senderId, receiverId, message: 'stored ciphertext', status: 'Seen', isEncrypted: true } as any })
  const ack = jest.fn(() => { throw new Error('sensitive acknowledgement detail') })
  events.get('sendMessage')!({ senderId, receiverId, message: 'request ciphertext' }, ack)
  await flush()
  expect(ack).toHaveBeenCalledTimes(1)
  expect(logError).toHaveBeenCalledTimes(1)
  expect(logError).toHaveBeenCalledWith('[chat-service] Socket acknowledgement failed')
  expect(logWarn).not.toHaveBeenCalled()
})

it('observes a rejected request once without logging ciphertext or credentials', async () => {
  const { events } = fixture()
  jest.spyOn(MessageSubmissionService.prototype, 'submit').mockRejectedValue(new Error('ciphertext or credentials'))
  const ack = jest.fn()
  events.get('sendMessage')!({ senderId, receiverId, message: 'request ciphertext' }, ack)
  await flush()
  expect(ack).toHaveBeenCalledTimes(1)
  expect(ack).toHaveBeenCalledWith({ ok: false, error: 'Failed to send message' })
  expect(logWarn).toHaveBeenCalledTimes(1)
  expect(logWarn).toHaveBeenCalledWith('[chat-service] Socket send request rejected')
  expect(logError).not.toHaveBeenCalled()
})

it('catches a disconnect rejection', async () => {
  const { events, presence } = fixture()
  jest.spyOn(presence, 'disconnect').mockRejectedValue(new Error('fixture disconnect'))
  events.get('disconnect')!()
  await flush()
  expect(logError).toHaveBeenCalledTimes(1)
  expect(logError).toHaveBeenCalledWith('[chat-service] Socket disconnect failed')
})
