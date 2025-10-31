import mongoose from 'mongoose'
import config from '../config/config'

export const connectDB = async () => {
  try {
    console.info('[chat-service] Connecting to MongoDB...' + config.MONGO_URI)
    await mongoose.connect(config.MONGO_URI! as string)
    console.info('[chat-service] MongoDB connected successfully')
  } catch (error) {
    console.error('[chat-service] Error connecting to MongoDB:', error)
    process.exit(1)
  }
}