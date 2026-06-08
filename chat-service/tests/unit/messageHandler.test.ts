// Mock the rabbitMQService module before importing the handler
jest.mock('../../src/services/RabbitMQService', () => ({
  rabbitMQService: {
    notifyReceiver: jest.fn(),
    getUserDetails: jest.fn((_id: string, cb: (u: null) => void) => cb(null))
  }
}))

import { handleMessageReceived } from '../../src/utils/messageHandler'
import { rabbitMQService } from '../../src/services/RabbitMQService'

describe('handleMessageReceived', () => {
  beforeEach(() => {
    jest.resetAllMocks()
    // resetAllMocks wipes factory impls; resolveReceiver awaits this callback.
    ;(rabbitMQService.getUserDetails as jest.Mock).mockImplementation(
      (_id: string, cb: (u: null) => void) => cb(null),
    )
  })

  test('calls notifyReceiver with encrypted envelope and does not include plaintext', async () => {
    const envelope = JSON.stringify({ __encrypted: true, body: 'abc' })
    await handleMessageReceived({
      senderName: 'Alice',
      senderEmail: 'a@x.com',
      receiverId: 'r1',
      messageContent: 'secret',
      isEncrypted: true,
      envelope,
    })

    expect(rabbitMQService.notifyReceiver).toHaveBeenCalledTimes(1)
    expect((rabbitMQService.notifyReceiver as jest.Mock).mock.calls[0][0].messageContent).toBe('[Encrypted message]')
    expect((rabbitMQService.notifyReceiver as jest.Mock).mock.calls[0][0].envelope).toBe(envelope)
  })

  test('calls notifyReceiver with plaintext when not encrypted', async () => {
    await handleMessageReceived({
      senderName: 'Bob',
      senderEmail: 'b@x.com',
      receiverId: 'r2',
      messageContent: 'hello',
      isEncrypted: false,
    })

    expect(rabbitMQService.notifyReceiver).toHaveBeenCalledTimes(1)
    expect((rabbitMQService.notifyReceiver as jest.Mock).mock.calls[0][0].messageContent).toBe('hello')
    expect((rabbitMQService.notifyReceiver as jest.Mock).mock.calls[0][0].isEncrypted).toBe(false)
  })
})
