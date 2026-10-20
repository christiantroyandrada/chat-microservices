import { validationResult } from 'express-validator'
import { sendMessageValidation } from '../../src/middleware/validation/messageValidation'

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
