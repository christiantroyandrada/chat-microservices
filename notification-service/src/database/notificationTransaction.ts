import type { DataSource, EntityManager } from 'typeorm'

export async function notificationTransaction<T>(
  database: DataSource,
  work: (manager: EntityManager) => Promise<T>,
  timeoutMessage = 'Notification receipt database operation timed out',
): Promise<T> {
  const runner = database.createQueryRunner()
  let client: { end(): Promise<void> } | undefined
  let timeout: NodeJS.Timeout | undefined
  let timedOut: Error | undefined
  let forcedClose: Promise<void> | undefined
  let workError: unknown
  try {
    client = await runner.connect() as { end(): Promise<void> }
    timeout = setTimeout(() => {
      timedOut = new Error(timeoutMessage)
      try { forcedClose = client?.end().catch(() => undefined) } catch { forcedClose = Promise.resolve() }
    }, 5000)
    timeout.unref?.()
    await runner.startTransaction()
    let result: T
    try {
      await runner.manager.query("SET LOCAL statement_timeout = '5000ms'")
      result = await work(runner.manager)
    } catch (error) { workError = error; throw error }
    await runner.commitTransaction()
    return result
  } catch (error) {
    const failure = workError ?? timedOut ?? error
    if (runner.isTransactionActive) await runner.rollbackTransaction().catch(() => undefined)
    throw failure
  } finally {
    if (timeout) clearTimeout(timeout)
    if (forcedClose) await forcedClose
    await runner.release().catch(() => undefined)
  }
}
