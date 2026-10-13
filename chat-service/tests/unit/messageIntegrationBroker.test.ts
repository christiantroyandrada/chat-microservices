import { requireMessageIntegrationBroker } from '../integration/messageIntegrationBroker'

describe('requireMessageIntegrationBroker', () => {
  const safe = 'amqp://task6b:task6b-local-only@127.0.0.1:35672/task6b'

  it('accepts only the dedicated explicit loopback fixture', () => {
    expect(requireMessageIntegrationBroker({ CHAT_INTEGRATION_BROKER_URL: safe })).toBe(safe)
  })

  it.each([
    [undefined],
    ['amqp://task6b:task6b-local-only@localhost:35672/task6b'],
    ['amqp://task6b:task6b-local-only@127.0.0.1/task6b'],
    ['amqp://guest:guest@127.0.0.1:35672/'],
    ['amqps://task6b:task6b-local-only@127.0.0.1:35672/task6b'],
    ['amqp://task6b:task6b-local-only@127.0.0.1:35672/task6b?heartbeat=5'],
  ])('rejects an unsafe broker endpoint %#', value => {
    expect(() => requireMessageIntegrationBroker({ CHAT_INTEGRATION_BROKER_URL: value }))
      .toThrow(value ? 'Unsafe CHAT_INTEGRATION_BROKER_URL' : 'CHAT_INTEGRATION_BROKER_URL is required')
  })
})
