import { config } from 'dotenv'

const configFile = `./.env`
config ({ path: configFile })

const  {
  MONGO_URI,
  PORT,
  JWT_SECRET,
  MESSAGE_BROKER_URL,
  NODE_ENV,
} = process.env

const queue = { notifications: 'NOTIFICATIONS' }

export default {
  MONGO_URI,
  PORT,
  JWT_SECRET,
  msgBrokerURL: MESSAGE_BROKER_URL,
  env: NODE_ENV,
  queue, 
}