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

  // Only publish notification events if the recipient is considered offline.
  // This conserves messaging queue budget — when the recipient is online they
  // receive messages over WebSocket and don't need an external notification.
  const recipientOnline = userStatusStore.isUserOnline(receiverId)
  if (!recipientOnline) {
    await rabbitMQService.notifyReceiver(
      receiverId,
      notifyBody,
      senderEmail,
      senderName,
      isEncrypted,
      envelope,
    )
  }
}