import 'reflect-metadata'
import { DataSource } from 'typeorm'
import config from '../config/config'
import { logInfo, logError } from '../utils/logger'
import { Message } from './models/MessageModel'
import { InitialSchema1733150000000 } from './migrations/1733150000000-InitialSchema'

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: config.DATABASE_URL,
  synchronize: config.env === 'development', // Auto-sync in dev, use migrations in production
  logging: config.env === 'development',
  entities: [Message],
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
    logInfo('[chat-service] Connecting to PostgreSQL...')
    await AppDataSource.initialize()
    logInfo('[chat-service] PostgreSQL connected successfully')
  } catch (error) {
    logError('[chat-service] Error connecting to PostgreSQL:', error)
    process.exit(1)
  }
}

export const runMigrations = async () => {
  try {
    logInfo('[chat-service] Running database migrations...')
    const migrations = await AppDataSource.runMigrations()
    if (migrations.length > 0) {
      logInfo(`[chat-service] ✅ Ran ${migrations.length} migration(s): ${migrations.map(m => m.name).join(', ')}`)
    } else {
      logInfo('[chat-service] ⏭️ No pending migrations')
    }
  } catch (error) {
    logError('[chat-service] Error running migrations:', error)
    throw error
  }
}