/**
 * Standalone database migration entrypoint — 12-factor XII compliant.
 *
 * Run as a one-off process before (or independently of) the main server:
 *   docker compose run --rm notification node build/src/migrate.js
 *   docker compose run --rm notification-migrate  (see docker-compose.yml)
 *
 * Exits 0 on success, 1 on failure.
 */
import 'reflect-metadata'
import { connectDB, runMigrations } from './database'
import { logInfo, logError } from './utils/logger'

const SERVICE = '[notification-service:migrate]'

async function main(): Promise<void> {
  logInfo(`${SERVICE} Starting migration process…`)
  try {
    await connectDB()
    await runMigrations()
    logInfo(`${SERVICE} ✅ All migrations applied successfully`)
    process.exit(0)
  } catch (err) {
    logError(`${SERVICE} ❌ Migration failed:`, err)
    process.exit(1)
  }
}

main()
