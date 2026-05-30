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

    await handleMessageReceived('Alice', 'alice@example.com', 'r1', 'hello', true, '{"__encrypted":true}')

    expect(notifyReceiver).toHaveBeenCalledTimes(1)
    // 7th positional arg is the resolved receiver email
    expect(notifyReceiver.mock.calls[0][6]).toBe('bob@example.com')
  })

  it('does NOT notify when the recipient is online', async () => {
    isOnline.mockResolvedValue(true)

    await handleMessageReceived('Alice', 'alice@example.com', 'r1', 'hello', true)

    expect(notifyReceiver).not.toHaveBeenCalled()
  })

  it('still notifies (without email) when lookup returns null', async () => {
    isOnline.mockResolvedValue(false)
    getUserDetails.mockImplementation((_id: string, cb: any) => cb(null))

    await handleMessageReceived('Alice', 'alice@example.com', 'r1', 'hello', true)

    expect(notifyReceiver).toHaveBeenCalledTimes(1)
    expect(notifyReceiver.mock.calls[0][6]).toBeUndefined()
  })
})
