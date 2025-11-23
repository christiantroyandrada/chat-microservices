// Prevent ESM-only modules from causing parse errors in Jest
jest.mock('uuid', () => ({ v4: () => 'mock-uuid' }))
jest.mock('amqplib', () => ({}))

import { Message, MessageStatus } from '../../src/database/models/MessageModel'

describe('Message model and enums', () => {
  it('exports Message and MessageStatus enum', () => {
    expect(Message).toBeDefined()
    expect(MessageStatus).toBeDefined()
    expect(MessageStatus.NotDelivered).toBe('NotDelivered')
    expect(Object.values(MessageStatus)).toEqual(
      expect.arrayContaining(['NotDelivered', 'Delivered', 'Seen'])
    )
  })

  it('can be instantiated and assigned properties', () => {
    const m = new Message()
    m.id = 'id1'
    m.senderId = 'alice'
    m.receiverId = 'bob'
    m.message = 'hello'
    m.isEncrypted = false
    m.status = MessageStatus.NotDelivered

    expect(m.senderId).toBe('alice')
    expect(m.receiverId).toBe('bob')
    expect(m.message).toBe('hello')
    expect(m.status).toBe(MessageStatus.NotDelivered)
  })
})
