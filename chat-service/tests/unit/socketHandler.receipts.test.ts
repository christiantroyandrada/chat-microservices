const getRepository = jest.fn()
const relayReceipt = jest.fn()
jest.mock('../../src/services/websocketRelay', () => ({ relayReceipt }))

const alice = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const bob = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
jest.mock('../../src/database', () => ({
  AppDataSource: { getRepository },
  Message: class {},
}))
jest.mock('../../src/utils', () => ({ handleMessageReceived: jest.fn() }))
jest.mock('../../src/utils/metrics', () => ({
  chatMessagesSentTotal: { inc: jest.fn() },
  chatPresenceChangesTotal: { inc: jest.fn() },
}))

import { MessageStatus } from '../../src/database/models/MessageModel'

let handleMessageDelivered: typeof import('../../src/websocket/socketHandler').handleMessageDelivered
let handleMarkRead: typeof import('../../src/websocket/socketHandler').handleMarkRead

beforeAll(() => {
  const mod = require('../../src/websocket/socketHandler')
  handleMessageDelivered = mod.handleMessageDelivered
  handleMarkRead = mod.handleMarkRead
})

beforeEach(() => relayReceipt.mockClear())

function makeIo() {
  const emit = jest.fn()
  const io: any = { to: jest.fn().mockReturnValue({ emit }) }
  return { io, emit }
}

describe('handleMessageDelivered', () => {
  beforeEach(() => getRepository.mockReset())

  it('marks NotDelivered → Delivered and notifies the sender', async () => {
    const msg = { id: '11111111-1111-4111-8111-111111111111', senderId: alice, receiverId: bob, status: MessageStatus.NotDelivered }
    const update = jest.fn().mockResolvedValueOnce({ affected: 1 }).mockResolvedValueOnce({ affected: 0 })
    getRepository.mockReturnValue({ findOne: jest.fn().mockResolvedValue(msg), update })
    const { io, emit } = makeIo()

    await handleMessageDelivered(io, bob, { messageId: msg.id })

    expect(update).toHaveBeenCalledWith({ id: msg.id, receiverId: bob, status: MessageStatus.NotDelivered }, { status: MessageStatus.Delivered })
    expect(io.to).toHaveBeenCalledWith(alice)
    expect(emit).toHaveBeenCalledWith('messageDelivered', { messageId: msg.id, by: bob })
    expect(relayReceipt).toHaveBeenCalledWith({ type: 'delivered', userId: alice, by: bob, messageId: msg.id })
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(relayReceipt.mock.invocationCallOrder[0])

    await handleMessageDelivered(io, bob, { messageId: msg.id })
    expect(relayReceipt).toHaveBeenCalledTimes(1)
  })

  it('ignores a delivery mark from someone who is not the receiver', async () => {
    const msg = { id: '11111111-1111-4111-8111-111111111111', senderId: alice, receiverId: bob, status: MessageStatus.NotDelivered }
    const update = jest.fn()
    getRepository.mockReturnValue({ findOne: jest.fn().mockResolvedValue(msg), update })
    const { io } = makeIo()

    await handleMessageDelivered(io, 'mallory', { messageId: msg.id })

    expect(update).not.toHaveBeenCalled()
    expect(relayReceipt).not.toHaveBeenCalled()
    expect(io.to).not.toHaveBeenCalled()
  })
})

describe('handleMarkRead', () => {
  beforeEach(() => getRepository.mockReset())

  it('marks the conversation Seen and notifies the sender', async () => {
    const execute = jest.fn().mockResolvedValueOnce({ affected: 3 }).mockResolvedValueOnce({ affected: 0 })
    const qb: any = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute,
    }
    getRepository.mockReturnValue({ createQueryBuilder: jest.fn().mockReturnValue(qb) })
    const { io, emit } = makeIo()

    await handleMarkRead(io, bob, { senderId: alice })

    expect(qb.set).toHaveBeenCalledWith({ status: MessageStatus.Seen })
    expect(execute).toHaveBeenCalled()
    expect(io.to).toHaveBeenCalledWith(alice)
    expect(emit).toHaveBeenCalledWith('messageRead', { by: bob })
    expect(relayReceipt).toHaveBeenCalledWith({ type: 'read', userId: alice, by: bob })
    expect(execute.mock.invocationCallOrder[0]).toBeLessThan(relayReceipt.mock.invocationCallOrder[0])

    await handleMarkRead(io, bob, { senderId: alice })
    expect(relayReceipt).toHaveBeenCalledTimes(1)
  })

  it('does nothing without a senderId', async () => {
    getRepository.mockReturnValue({ createQueryBuilder: jest.fn() })
    const { io } = makeIo()
    await handleMarkRead(io, bob, { senderId: '' })
    expect(io.to).not.toHaveBeenCalled()
  })
})
