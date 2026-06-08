const isOnline = jest.fn()
const getUserDetails = jest.fn()
const notifyReceiver = jest.fn()

jest.mock('../../src/services/PresenceStore', () => ({
  getPresenceStore: () => ({ isOnline }),
}))
jest.mock('../../src/services/RabbitMQService', () => ({
  rabbitMQService: { getUserDetails, notifyReceiver },
}))

import { handleMessageReceived } from '../../src/utils/messageHandler'

describe('handleMessageReceived — offline notification with receiver email', () => {
  beforeEach(() => {
    isOnline.mockReset()
    getUserDetails.mockReset()
    notifyReceiver.mockReset()
  })

  it('resolves the receiver email and forwards it when recipient is offline', async () => {
    isOnline.mockResolvedValue(false)
    getUserDetails.mockImplementation((_id: string, cb: any) =>
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
    getUserDetails.mockImplementation((_id: string, cb: any) => cb(null))

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
})
