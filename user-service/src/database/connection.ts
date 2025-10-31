import mongoose from 'mongoose'
import config from '../config/config'

export const connectDB = async () => {
  try {
    console.info('[user-service] Connecting to MongoDB...')
    await mongoose.connect(config.MONGO_URI!)
    console.info('[user-service] MongoDB connected successfully')
  } catch (error) {
    console.error('[user-service] Error connecting to MongoDB:', error)
    process.exit(1)
  }
}