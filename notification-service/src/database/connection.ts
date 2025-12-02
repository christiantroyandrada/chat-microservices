import 'reflect-metadata'
import { DataSource } from 'typeorm'
import config from '../config/config'
import { logInfo, logError } from '../utils/logger'
import { Notification } from './models/NotificationModel'
import { InitialSchema1733150000000 } from './migrations/1733150000000-InitialSchema'

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: config.DATABASE_URL,
  synchronize: config.env === 'development', // Auto-sync in dev, use migrations in production
  logging: config.env === 'development',
  entities: [Notification],
  migrations: [InitialSchema1733150000000],
  migrationsRun: false, // We run migrations explicitly before starting services
  migrationsTableName: 'typeorm_migrations',
  subscribers: [],
  // Connection pooling for better performance and reliability
  extra: {
    max: 20, // Maximum number of connections in pool
    min: 5,  // Minimum number of connections in pool
    idleTimeoutMillis: 30000, // Close idle connections after 30s
    connectionTimeoutMillis: 2000, // Fail fast on connection issues
  },
  maxQueryExecutionTime: 1000, // Log queries taking longer than 1s
})

export const connectDB = async () => {
  try {
    logInfo('[notification-service] Connecting to PostgreSQL...')
    await AppDataSource.initialize()
    logInfo('[notification-service] PostgreSQL connected successfully')
  } catch (error) {
    logError('[notification-service] Error connecting to PostgreSQL:', error)
    process.exit(1)
  }
}

export const runMigrations = async () => {
  try {
    logInfo('[notification-service] Running database migrations...')
    const migrations = await AppDataSource.runMigrations()
    if (migrations.length > 0) {
      logInfo(`[notification-service] ✅ Ran ${migrations.length} migration(s): ${migrations.map(m => m.name).join(', ')}`)
    } else {
      logInfo('[notification-service] ⏭️ No pending migrations')
    }
  } catch (error) {
    logError('[notification-service] Error running migrations:', error)
    throw error
  }
}
