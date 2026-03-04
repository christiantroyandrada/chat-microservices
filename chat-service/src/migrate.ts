/**
 * Standalone database migration entrypoint — 12-factor XII compliant.
 *
 * Run as a one-off process before (or independently of) the main server:
 *   docker compose run --rm chat node build/src/migrate.js
 *   docker compose run --rm chat-migrate          (see docker-compose.yml)
 *
 * Exits 0 on success, 1 on failure.  The main server no longer needs to run
 * migrations at startup — it merely checks for pending ones and aborts if any
 * remain (safety net).
 */
import 'reflect-metadata'
import { connectDB, runMigrations } from './database'
import { logInfo, logError } from './utils/logger'

const SERVICE = '[chat-service:migrate]'

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
