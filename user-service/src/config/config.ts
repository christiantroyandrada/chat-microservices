import { config } from 'dotenv'

// 12-factor III: Only load .env in non-production environments.
// In production containers, env vars are injected directly by the orchestrator.
if (process.env.NODE_ENV !== 'production') {
  config({ path: './.env' })
}

const { DATABASE_URL, PORT, JWT_SECRET, NODE_ENV, MESSAGE_BROKER_URL } = process.env

export default {
  DATABASE_URL,
  PORT,
  JWT_SECRET,
  env: NODE_ENV,
  msgBrokerURL: MESSAGE_BROKER_URL,
}