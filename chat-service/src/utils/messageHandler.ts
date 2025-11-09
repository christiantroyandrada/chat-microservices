import { UserStatusStore } from './userStatusStore'
import { rabbitMQService } from '../services/RabbitMQService'

const userStatusStore = UserStatusStore.getInstance()

export const handleMessageReceived = async (
  senderName: string,
  senderEmail: string,
  receiverId: string,
  messageContent: string,
  isEncrypted = false,
  envelope?: string | object,
) => {
  // When messages are encrypted we must NOT include plaintext in notifications.
  const notifyBody = isEncrypted ? '[Encrypted message]' : messageContent

  // Always create notification record in database for notification bell
  // The notification-service will determine whether to send push/email based on online status
  await rabbitMQService.notifyReceiver(
    receiverId,
    notifyBody,
    senderEmail,
    senderName,
    isEncrypted,
    envelope,
  )
}