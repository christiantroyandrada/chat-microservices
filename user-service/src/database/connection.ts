import 'reflect-metadata'
import { DataSource } from 'typeorm'
import config from '../config/config'
import { User } from './models/UserModel'
import { Prekey } from './models/PrekeyModel'

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: config.DATABASE_URL,
  synchronize: config.env !== 'production', // ✅ SAFE: Only auto-sync in development
  logging: config.env === 'development',
  entities: [User, Prekey],
  migrations: [],
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
    console.info('[user-service] Connecting to PostgreSQL...')
    await AppDataSource.initialize()
    console.info('[user-service] PostgreSQL connected successfully')
  } catch (error) {
    console.error('[user-service] Error connecting to PostgreSQL:', error)
    process.exit(1)
  }
}