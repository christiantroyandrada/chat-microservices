type Environment = Record<string, string | undefined>

export type PrekeyIntegrationDatabase = {
  url: string
  database: string
  user: string
  hostname: string
}

export function requirePrekeyIntegrationDatabase(env: Environment): PrekeyIntegrationDatabase {
  const url = env.PREKEY_INTEGRATION_DATABASE_URL
  if (!url) throw new Error('PREKEY_INTEGRATION_DATABASE_URL is required for the isolated prekey fixture')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Unsafe PREKEY_INTEGRATION_DATABASE_URL')
  }
  const database = parsed.pathname.slice(1)
  if (
    parsed.protocol !== 'postgresql:' ||
    parsed.hostname !== '127.0.0.1' ||
    !parsed.port ||
    parsed.username !== 'task5' ||
    parsed.password ||
    !/^task5_prekey_[a-z0-9_]+$/.test(database) ||
    parsed.search ||
    parsed.hash
  ) throw new Error('Unsafe PREKEY_INTEGRATION_DATABASE_URL')
  return { url, database, user: parsed.username, hostname: parsed.hostname }
}

export function assertPrekeyIntegrationDatabaseIdentity(expected: PrekeyIntegrationDatabase, actual: unknown): void {
  const value = actual as Record<string, unknown> | null
  const address = typeof value?.address === 'string' ? value.address : ''
  const privateAddress = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address) || address === '::1'
  if (
    !value ||
    value.database !== expected.database ||
    value.user !== expected.user ||
    value.port !== 5432 ||
    !privateAddress
  ) throw new Error('Prekey integration database server identity mismatch')
}
