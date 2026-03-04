import { config } from 'dotenv'

// 12-factor III: Only load .env in non-production environments.
// In production containers, env vars are injected directly by the orchestrator.
if (process.env.NODE_ENV !== 'production') {
  config({ path: './.env' })
}

const {
  PORT,
  JWT_SECRET,
  NODE_ENV,
  MESSAGE_BROKER_URL,
  SENDINBLUE_APIKEY,
  EMAIL_FROM,
  SMTP_HOST,
  SMTP_PORT = 587,
  SMTP_USER,
  SMTP_PASS,
  DATABASE_URL
} = process.env

const queue = { notifications: 'NOTIFICATIONS' }

export default {
  PORT,
  JWT_SECRET,
  env: NODE_ENV,
  msgBrokerURL: MESSAGE_BROKER_URL,
  SENDINBLUE_APIKEY,
  EMAIL_FROM,
  DATABASE_URL,
  queue,
  smtp: {
    host: SMTP_HOST,
    port: SMTP_PORT as number,
    user: SMTP_USER,
    pass: SMTP_PASS
  }
}