import admin from 'firebase-admin'
import type { FCMMessagePayload } from '../types'
import { logInfo, logError } from '../utils/logger'

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
})

export const FCMService = {
  /**
   * Send a push notification. When `data` is provided it will be attached
   * to the message as the data payload (suitable for forwarding ciphertext to the client).
   * The visible `body` should never contain decrypted plaintext for E2EE messages.
   */
  sendPushNotification: async (token: string, message: string, data?: Record<string, string>) => {
    const payload: FCMMessagePayload = {
      notification: {
        title: 'New Message',
        body: message,
      },
      token: token,
    }

    if (data && Object.keys(data).length > 0) {
      payload.data = data
    }

    try {
      await admin.messaging().send(payload)
      logInfo('Push notification sent successfully')
    } catch (err) {
      logError('Error sending notification', err)
    }
  },
}