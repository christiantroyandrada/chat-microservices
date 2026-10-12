type Environment = Record<string, string | undefined>

export type MessageIntegrationDatabase = {
  url: string
  database: string
  user: string
}

export function requireMessageIntegrationDatabase(env: Environment): MessageIntegrationDatabase {
  const url = env.CHAT_INTEGRATION_DATABASE_URL
  if (!url) throw new Error('CHAT_INTEGRATION_DATABASE_URL is required for the isolated chat fixture')

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Unsafe CHAT_INTEGRATION_DATABASE_URL')
  }

  const database = parsed.pathname.slice(1)
  if (
    parsed.protocol !== 'postgresql:' ||
    parsed.hostname !== '127.0.0.1' ||
    !parsed.port ||
    parsed.username !== 'task6a' ||
    parsed.password ||
    !/^chat_task6_[a-z0-9_]+$/.test(database) ||
    parsed.search ||
    parsed.hash
  ) throw new Error('Unsafe CHAT_INTEGRATION_DATABASE_URL')

  return { url, database, user: parsed.username }
}

export function assertMessageIntegrationDatabaseIdentity(
  expected: MessageIntegrationDatabase,
  actual: unknown,
): void {
  const value = actual as Record<string, unknown> | null
  const address = typeof value?.address === 'string' ? value.address : ''
  const privateAddress = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address) || address === '::1'
  if (
    !value ||
    value.database !== expected.database ||
    value.user !== expected.user ||
    value.port !== 5432 ||
    !privateAddress
  ) throw new Error('Chat integration database server identity mismatch')
}
