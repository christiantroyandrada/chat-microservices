import mongoose, { Schema, Document } from 'mongoose'

export interface INotification extends Document {
  userId: string
  type: 'message' | 'system' | 'alert'
  title: string
  message: string
  read: boolean
  createdAt: Date
  updatedAt: Date
}

const NotificationSchema: Schema = new Schema(
  {
    userId: {
      type: String,
      required: true,
      index: true
    },
    type: {
      type: String,
      enum: ['message', 'system', 'alert'],
      required: true
    },
    title: {
      type: String,
      required: true
    },
    message: {
      type: String,
      required: true
    },
    read: {
      type: Boolean,
      default: false,
      index: true
    }
  },
  {
    timestamps: true
  }
)

// Index for efficient queries
NotificationSchema.index({ userId: 1, createdAt: -1 })
NotificationSchema.index({ userId: 1, read: 1 })

const Notification = mongoose.model<INotification>('Notification', NotificationSchema)
export default Notification
