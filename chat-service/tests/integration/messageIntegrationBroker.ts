type Environment = Record<string, string | undefined>

export function requireMessageIntegrationBroker(env: Environment): string {
  const value = env.CHAT_INTEGRATION_BROKER_URL
  if (!value) throw new Error('CHAT_INTEGRATION_BROKER_URL is required for the isolated chat fixture')

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('Unsafe CHAT_INTEGRATION_BROKER_URL')
  }

  if (
    parsed.protocol !== 'amqp:' ||
    parsed.hostname !== '127.0.0.1' ||
    !parsed.port ||
    parsed.username !== 'task6b' ||
    parsed.password !== 'task6b-local-only' ||
    parsed.pathname !== '/task6b' ||
    parsed.search ||
    parsed.hash
  ) throw new Error('Unsafe CHAT_INTEGRATION_BROKER_URL')

  return value
}
