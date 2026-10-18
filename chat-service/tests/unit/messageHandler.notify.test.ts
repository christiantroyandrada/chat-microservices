const isOnline = jest.fn()
const getUserDetails = jest.fn()
const notifyReceiver = jest.fn()

jest.mock('../../src/services/PresenceStore', () => ({
  getPresenceStore: () => ({ isOnline }),
}))
jest.mock('../../src/services/RabbitMQService', () => ({
  rabbitMQService: { getUserDetails, notifyReceiver },
}))

import { enrichMessageReceivedPayload, handleMessageReceived } from '../../src/utils/messageHandler'
import * as logger from '../../src/utils/logger'

const event = {
  type: 'MESSAGE_RECEIVED' as const,
  eventId: '11111111-1111-4111-8111-111111111111',
  senderId: 'sender-1',
  userId: 'r1',
  message: '[Encrypted message]',
  from: 'alice@example.com',
  fromName: 'Alice',
  isEncrypted: true as const,
  envelope: '{"__encrypted":true,"body":"ciphertext"}',
}

describe('enrichMessageReceivedPayload', () => {
  beforeEach(() => {
    isOnline.mockReset()
    getUserDetails.mockReset()
  })

  it('preserves canonical receipt fields while adding current contact and presence', async () => {
    isOnline.mockResolvedValue(true)
    getUserDetails.mockImplementation(async (_id: string, callback: any) =>
      callback({ id: 'r1', username: 'bob', email: 'bob@example.com' }),
    )

    await expect(enrichMessageReceivedPayload(event)).resolves.toEqual({
      ...event,
      recipientOnline: true,
      userEmail: 'bob@example.com',
    })
    expect(event).not.toHaveProperty('recipientOnline')
    expect(event).not.toHaveProperty('userEmail')
  })

  it('keeps an RPC timeout retryable and resolves fresh data on the next attempt', async () => {
    isOnline.mockResolvedValue(false)
    getUserDetails
      .mockImplementationOnce(async (_id: string, callback: any) => callback(null))
      .mockImplementationOnce(async (_id: string, callback: any) =>
        callback({ id: 'r1', username: 'bob', email: 'new@example.com' }),
      )

    await expect(enrichMessageReceivedPayload(event)).rejects.toThrow('Recipient lookup failed')
    await expect(enrichMessageReceivedPayload(event)).resolves.toMatchObject({
      eventId: event.eventId,
      envelope: event.envelope,
      userEmail: 'new@example.com',
      recipientOnline: false,
    })
  })

  it('joins a blocked presence read before exposing an RPC failure', async () => {
    let releasePresence!: () => void
    isOnline.mockImplementationOnce(() => new Promise<boolean>(resolve => {
      releasePresence = () => resolve(false)
    }))
    getUserDetails.mockImplementationOnce(async (_id: string, callback: any) => callback(null))
    let settled = false
    const enriching = enrichMessageReceivedPayload(event)
      .catch(error => error)
      .finally(() => { settled = true })

    for (let attempt = 0; attempt < 10; attempt++) await Promise.resolve()
    const settledBeforePresence = settled
    releasePresence()
    const failure = await enriching

    expect(settledBeforePresence).toBe(false)
    expect(failure).toEqual(new Error('Recipient lookup failed'))
  })
})

describe('handleMessageReceived — offline notification with receiver email', () => {
  beforeEach(() => {
    isOnline.mockReset()
    getUserDetails.mockReset()
    notifyReceiver.mockReset()
  })

  it('resolves the receiver email and forwards it when recipient is offline', async () => {
    isOnline.mockResolvedValue(false)
    getUserDetails.mockImplementation(async (_id: string, cb: any) =>
      cb({ id: 'r1', username: 'bob', email: 'bob@example.com' }),
    )

    await handleMessageReceived({
      senderName: 'Alice',
      senderEmail: 'alice@example.com',
      receiverId: 'r1',
      messageContent: 'hello',
      isEncrypted: true,
      envelope: '{"__encrypted":true}',
    })

    expect(notifyReceiver).toHaveBeenCalledTimes(1)
    expect(notifyReceiver.mock.calls[0][0].receiverEmail).toBe('bob@example.com')
  })

  it('does NOT notify when the recipient is online', async () => {
    isOnline.mockResolvedValue(true)

    await handleMessageReceived({
      senderName: 'Alice',
      senderEmail: 'alice@example.com',
      receiverId: 'r1',
      messageContent: 'hello',
      isEncrypted: true,
    })

    expect(notifyReceiver).not.toHaveBeenCalled()
  })

  it('still notifies (without email) when lookup returns null', async () => {
    isOnline.mockResolvedValue(false)
    getUserDetails.mockImplementation(async (_id: string, cb: any) => cb(null))

    await handleMessageReceived({
      senderName: 'Alice',
      senderEmail: 'alice@example.com',
      receiverId: 'r1',
      messageContent: 'hello',
      isEncrypted: true,
    })

    expect(notifyReceiver).toHaveBeenCalledTimes(1)
    expect(notifyReceiver.mock.calls[0][0].receiverEmail).toBeUndefined()
  })

  it('still persists a notification when the broker rejects the lookup', async () => {
    const warning = jest.spyOn(logger, 'logWarn').mockImplementation(() => undefined)
    isOnline.mockResolvedValue(false)
    getUserDetails.mockRejectedValue(new Error('channel closed'))
    await handleMessageReceived({ senderName: 'Alice', senderEmail: 'alice@example.com', receiverId: 'r1', messageContent: '[Encrypted message]', isEncrypted: true })
    expect(notifyReceiver).toHaveBeenCalledTimes(1)
    expect(notifyReceiver.mock.calls[0][0].receiverEmail).toBeUndefined()
    expect(warning).toHaveBeenCalledWith(
      '[chat-service] receiver lookup failed; notifying without email',
      expect.any(Error),
    )
  })
})
