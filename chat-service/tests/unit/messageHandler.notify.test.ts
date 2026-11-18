const getUserDetails = jest.fn()
jest.mock('../../src/services/RabbitMQService', () => ({ rabbitMQService: { getUserDetails } }))

import { enrichMessageReceivedPayload } from '../../src/utils/messageHandler'

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

beforeEach(() => getUserDetails.mockReset())

it('preserves canonical receipt fields and omits unknown presence while adding current contact', async () => {
  getUserDetails.mockImplementation(async (_id: string, callback: any) =>
    callback({ id: 'r1', username: 'bob', email: 'bob@example.com' }),
  )
  const payload = await enrichMessageReceivedPayload(event)
  expect(payload).toEqual({ ...event, userEmail: 'bob@example.com' })
  expect(payload).not.toHaveProperty('recipientOnline')
  expect(event).not.toHaveProperty('userEmail')
})

it('keeps an RPC timeout retryable and resolves fresh data on the next attempt', async () => {
  getUserDetails
    .mockImplementationOnce(async (_id: string, callback: any) => callback(null))
    .mockImplementationOnce(async (_id: string, callback: any) =>
      callback({ id: 'r1', username: 'bob', email: 'new@example.com' }),
    )
  await expect(enrichMessageReceivedPayload(event)).rejects.toThrow('Recipient lookup failed')
  await expect(enrichMessageReceivedPayload(event)).resolves.toEqual({ ...event, userEmail: 'new@example.com' })
})

it('keeps a rejected broker lookup retryable', async () => {
  getUserDetails.mockRejectedValueOnce(new Error('channel closed'))
  await expect(enrichMessageReceivedPayload(event)).rejects.toThrow('channel closed')
})
