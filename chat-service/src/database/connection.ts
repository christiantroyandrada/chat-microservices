import 'reflect-metadata'
import { DataSource } from 'typeorm'
import config from '../config/config'
import { Message } from './models/MessageModel'

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: config.DATABASE_URL,
  synchronize: config.env !== 'production', // ✅ SAFE: Only auto-sync in development
  logging: config.env === 'development',
  entities: [Message],
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
    console.info('[chat-service] Connecting to PostgreSQL...')
    await AppDataSource.initialize()
    console.info('[chat-service] PostgreSQL connected successfully')
  } catch (error) {
    console.error('[chat-service] Error connecting to PostgreSQL:', error)
    process.exit(1)
  }
}