import { getPresenceStore } from '../services/PresenceStore'
import { rabbitMQService } from '../services/RabbitMQService'
import { logWarn } from './logger'
import type { UserDetails } from '../types'

/**
 * Resolve the recipient's contact details over the user-service RPC, degrading
 * gracefully (returns null) on timeout or transport failure so a notification
 * is still persisted even when lookup fails.
 */
async function resolveReceiver (receiverId: string): Promise<UserDetails | null> {
  try {
    return await new Promise<UserDetails | null>((resolve) => {
      rabbitMQService.getUserDetails(receiverId, resolve)
    })
  } catch (err) {
    logWarn('[chat-service] receiver lookup failed; notifying without email', err)
    return null
  }
}

export interface IncomingMessageNotification {
  senderName: string
  senderEmail: string
  receiverId: string
  messageContent: string
  isEncrypted?: boolean
  envelope?: string | object
}

export const handleMessageReceived = async (args: IncomingMessageNotification) => {
  const { senderName, senderEmail, receiverId, messageContent, isEncrypted = false, envelope } = args
  // When messages are encrypted we must NOT include plaintext in notifications.
  const notifyBody = isEncrypted ? '[Encrypted message]' : messageContent

  // Only publish notification events if the recipient is considered offline.
  // This conserves messaging queue budget — when the recipient is online they
  // receive messages over WebSocket and don't need an external notification.
  // getPresenceStore() is async-safe: works with both LocalPresenceStore (in-process)
  // and RedisPresenceStore (distributed) without any call-site changes.
  const recipientOnline = await getPresenceStore().isOnline(receiverId)
  if (!recipientOnline) {
    // Resolve the recipient's email so the notification-service can actually
    // deliver it (otherwise it only writes a DB row). FCM token stays undefined
    // until web-push is wired up — the consumer falls back to email.
    const receiver = await resolveReceiver(receiverId)
    await rabbitMQService.notifyReceiver({
      receiverId,
      messageContent: notifyBody,
      senderEmail,
      senderName,
      isEncrypted,
      envelope,
      receiverEmail: receiver?.email,
    })
  }
}