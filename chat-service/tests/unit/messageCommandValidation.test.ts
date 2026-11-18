import { validationResult } from 'express-validator'
import { sendMessageValidation, fetchConversationValidation, getConversationsValidation, markAsReadValidation, acknowledgeDeliveryValidation } from '../../src/middleware/validation/messageValidation'

describe('delivery acknowledgement validation', () => {
  const user = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const message = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  it.each([
    [{ expectedUserId: user }, { messageId: message }, true],
    [{ expectedUserId: user.toUpperCase() }, { messageId: message.toUpperCase() }, true],
    [{}, { messageId: message }, false],
    [{ expectedUserId: [user] }, { messageId: message }, false],
    [{ expectedUserId: user }, { messageId: 'invalid' }, false],
    [{ expectedUserId: user }, {}, false],
  ])('validates the account and message together', async (query, params, valid) => {
    const req = { query, params }
    for (const chain of acknowledgeDeliveryValidation) await chain.run(req)
    expect(validationResult(req).isEmpty()).toBe(valid)
  })
})

describe.each([['history', fetchConversationValidation], ['conversations', getConversationsValidation], ['markAsRead', markAsReadValidation]] as const)('%s expectedUserId validation', (_name, chains) => {
  it.each([null, [], ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'], '', 7, 'invalid', ' aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa '])('rejects malformed expectedUserId %p', async expectedUserId => {
    const req: any = { params: { receiverId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', senderId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, query: { expectedUserId } }
    for (const chain of chains) await chain.run(req)
    expect(validationResult(req).isEmpty()).toBe(false)
  })
  it.each([undefined, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'])('accepts absent or valid expectedUserId %p', async expectedUserId => {
    const req: any = { params: { receiverId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', senderId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, query: { expectedUserId } }
    for (const chain of chains) await chain.run(req)
    expect(validationResult(req).isEmpty()).toBe(true)
  })
})

it.each([null, [], ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'], '', 7, 'invalid', ' aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa '])('rejects a provided invalid expectedSenderId %p in REST middleware', async expectedSenderId => {
  const req: any = { body: { receiverId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', message: '{"__encrypted":true,"body":"x"}', expectedSenderId } }
  for (const chain of sendMessageValidation) await chain.run(req)
  expect(validationResult(req).isEmpty()).toBe(false)
})

it.each(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'])('accepts a valid expectedSenderId %s', async expectedSenderId => {
  const req: any = { body: { receiverId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', message: '{"__encrypted":true,"body":"x"}', expectedSenderId } }
  for (const chain of sendMessageValidation) await chain.run(req)
  expect(validationResult(req).isEmpty()).toBe(true)
})

it.each([null, '', 7, 'invalid'])('rejects a provided invalid clientMessageId %p in REST middleware', async clientMessageId => {
  const req: any = { body: { receiverId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', message: '{"__encrypted":true,"body":"x"}', clientMessageId } }
  for (const chain of sendMessageValidation) await chain.run(req)
  expect(validationResult(req).isEmpty()).toBe(false)
})

it('accepts an absent clientMessageId for legacy REST callers', async () => {
  const req: any = { body: { receiverId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', message: '{"__encrypted":true,"body":"x"}' } }
  for (const chain of sendMessageValidation) await chain.run(req)
  expect(validationResult(req).isEmpty()).toBe(true)
})
