import mongoose from 'mongoose'
import config from '../config/config'

export const connectDB = async () => {
  try {
    console.info('[notification-service] Connecting to MongoDB...')
    await mongoose.connect(config.MONGO_URI!)
    console.info('[notification-service] MongoDB connected successfully')
  } catch (error) {
    console.error('[notification-service] Error connecting to MongoDB:', error)
    process.exit(1)
  }
}
