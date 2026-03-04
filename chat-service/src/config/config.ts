import { config } from 'dotenv'

// 12-factor III: Only load .env in non-production environments.
// In production containers, env vars are injected directly by the orchestrator.
if (process.env.NODE_ENV !== 'production') {
  config({ path: './.env' })
}

const {
  DATABASE_URL,
  PORT,
  JWT_SECRET,
  MESSAGE_BROKER_URL,
  NODE_ENV,
  REDIS_URL,
} = process.env

const queue = { notifications: 'NOTIFICATIONS' }

export default {
  DATABASE_URL,
  PORT,
  JWT_SECRET,
  msgBrokerURL: MESSAGE_BROKER_URL,
  env: NODE_ENV,
  queue,
  // Optional — when set, enables Redis adapter for horizontal scaling (12-factor VI).
  // When absent, chat-service runs in single-node in-memory mode.
  redisUrl: REDIS_URL,
}