import mongoose from 'mongoose'
import config from '../config/config'

export const connectDB = async () => {
  try {
    console.info('Connecting to MongoDB...')
    await mongoose.connect(config.MONGO_URI!)
    console.info('MongoDB connected successfully')
  } catch (error) {
    console.error('Error connecting to MongoDB:', error)
    process.exit(1)
  }
}