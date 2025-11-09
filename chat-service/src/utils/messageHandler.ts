import { UserStatusStore } from './userStatusStore'
import { rabbitMQService } from '../services/RabbitMQService'

const userStatusStore = UserStatusStore.getInstance()

export const handleMessageReceived = async (
  senderName: string,
  senderEmail: string,
  receiverId: string,
  messageContent: string,
) => {
  // Always create notification record in database for notification bell
  // The notification-service will determine whether to send push/email based on online status
  await rabbitMQService.notifyReceiver(
    receiverId,
    messageContent,
    senderEmail,
    senderName,
  )
}