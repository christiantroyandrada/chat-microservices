import { config } from 'dotenv'

const configFile = `./.env`
config({ path: configFile })

const { DATABASE_URL, PORT, JWT_SECRET, NODE_ENV, MESSAGE_BROKER_URL } = process.env

export default {
  DATABASE_URL,
  PORT,
  JWT_SECRET,
  env: NODE_ENV,
  msgBrokerURL: MESSAGE_BROKER_URL,
}