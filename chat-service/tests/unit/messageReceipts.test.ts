const getRepository = jest.fn()
const relayReceipt = jest.fn()
jest.mock('../../src/services/websocketRelay', () => ({ relayReceipt }))
jest.mock('../../src/database', () => ({ AppDataSource: { getRepository }, Message: class {} }))

import { MessageStatus } from '../../src/database/models/MessageModel'
import { markMessageDelivered, markConversationSeen } from '../../src/services/messageReceipts'

const senderId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const receiverId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const messageId = '11111111-1111-4111-8111-111111111111'
beforeEach(() => { getRepository.mockReset(); relayReceipt.mockReset() })

it('relays a delivery to Go only after a receiver-scoped conditional update changes storage', async () => {
  const update = jest.fn().mockResolvedValueOnce({ affected: 1 }).mockResolvedValueOnce({ affected: 0 })
  const findOne = jest.fn().mockResolvedValue({ id: messageId, senderId, receiverId, status: MessageStatus.NotDelivered })
  getRepository.mockReturnValue({ findOne, update })
  expect(await markMessageDelivered(messageId, receiverId)).toEqual({ senderId, changed: true })
  expect(findOne).toHaveBeenCalledWith({ where: { id: messageId, receiverId } })
  expect(update).toHaveBeenCalledWith({ id: messageId, receiverId, status: MessageStatus.NotDelivered }, { status: MessageStatus.Delivered })
  expect(relayReceipt).toHaveBeenCalledWith({ type: 'delivered', userId: senderId, by: receiverId, messageId })
  expect(update.mock.invocationCallOrder[0]).toBeLessThan(relayReceipt.mock.invocationCallOrder[0])
  expect(await markMessageDelivered(messageId, receiverId)).toEqual({ senderId, changed: false })
  expect(relayReceipt).toHaveBeenCalledTimes(1)
})

it.each([null, { id: messageId, senderId, receiverId: 'foreign', status: MessageStatus.NotDelivered }])('does not mutate or relay an absent or unauthorized receipt %p', async existing => {
  const update = jest.fn()
  getRepository.mockReturnValue({ findOne: jest.fn().mockResolvedValue(existing), update })
  expect(await markMessageDelivered(messageId, receiverId)).toBeNull()
  expect(update).not.toHaveBeenCalled()
  expect(relayReceipt).not.toHaveBeenCalled()
})

it.each([MessageStatus.Delivered, MessageStatus.Seen])('preserves an existing %s receipt without another Go event', async status => {
  const update = jest.fn()
  getRepository.mockReturnValue({ findOne: jest.fn().mockResolvedValue({ senderId, receiverId, status }), update })
  expect(await markMessageDelivered(messageId, receiverId)).toEqual({ senderId, changed: false })
  expect(update).not.toHaveBeenCalled()
  expect(relayReceipt).not.toHaveBeenCalled()
})

it('relays a receiver-scoped Seen update to Go after storage changes and suppresses replay', async () => {
  const execute = jest.fn().mockResolvedValueOnce({ affected: 3 }).mockResolvedValueOnce({ affected: 0 })
  const qb: any = { update: jest.fn().mockReturnThis(), set: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(), execute }
  getRepository.mockReturnValue({ createQueryBuilder: () => qb })
  expect(await markConversationSeen(senderId, receiverId)).toBe(3)
  expect(qb.where).toHaveBeenCalledWith('senderId = :senderId', { senderId })
  expect(qb.andWhere).toHaveBeenCalledWith('receiverId = :receiverId', { receiverId })
  expect(qb.andWhere).toHaveBeenCalledWith('status != :status', { status: MessageStatus.Seen })
  expect(qb.set).toHaveBeenCalledWith({ status: MessageStatus.Seen })
  expect(relayReceipt).toHaveBeenCalledWith({ type: 'read', userId: senderId, by: receiverId })
  expect(execute.mock.invocationCallOrder[0]).toBeLessThan(relayReceipt.mock.invocationCallOrder[0])
  expect(await markConversationSeen(senderId, receiverId)).toBe(0)
  expect(relayReceipt).toHaveBeenCalledTimes(1)
})

it('treats an empty scoped receipt as a no-op', async () => {
  expect(await markConversationSeen(senderId, receiverId, [])).toBe(0)
  expect(getRepository).not.toHaveBeenCalled()
  expect(relayReceipt).not.toHaveBeenCalled()
})
