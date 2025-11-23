// Mock the rabbitMQService module before importing the handler
jest.mock('../../src/services/RabbitMQService', () => ({
  rabbitMQService: {
    notifyReceiver: jest.fn()
  }
}))

import { handleMessageReceived } from '../../src/utils/messageHandler'
import { rabbitMQService } from '../../src/services/RabbitMQService'

describe('handleMessageReceived', () => {
  beforeEach(() => jest.resetAllMocks())

  test('calls notifyReceiver with encrypted envelope and does not include plaintext', async () => {
    const envelope = JSON.stringify({ __encrypted: true, body: 'abc' })
    await handleMessageReceived('Alice', 'a@x.com', 'r1', 'secret', true, envelope)

    expect(rabbitMQService.notifyReceiver).toHaveBeenCalledTimes(1)
    expect((rabbitMQService.notifyReceiver as jest.Mock).mock.calls[0][1]).toBe('[Encrypted message]')
    expect((rabbitMQService.notifyReceiver as jest.Mock).mock.calls[0][5]).toBe(envelope)
  })

  test('calls notifyReceiver with plaintext when not encrypted', async () => {
    await handleMessageReceived('Bob', 'b@x.com', 'r2', 'hello', false)

    expect(rabbitMQService.notifyReceiver).toHaveBeenCalledTimes(1)
    expect((rabbitMQService.notifyReceiver as jest.Mock).mock.calls[0][1]).toBe('hello')
    expect((rabbitMQService.notifyReceiver as jest.Mock).mock.calls[0][4]).toBe(false)
  })
})
