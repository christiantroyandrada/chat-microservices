import admin from 'firebase-admin'
import type { FCMMessagePayload } from '../types'
import { logInfo, logWarn, logError } from '../utils/logger'

let firebaseInitialized = false

/**
 * Lazily initialize Firebase Admin SDK on first use.
 * Returns true if Firebase is ready, false otherwise.
 */
function ensureFirebaseInitialized(): boolean {
  if (firebaseInitialized) return true
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    logWarn('[FCMService] GOOGLE_APPLICATION_CREDENTIALS not set — push notifications disabled')
    return false
  }
  try {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
    })
    firebaseInitialized = true
    logInfo('[FCMService] Firebase Admin SDK initialized')
    return true
  } catch (err) {
    logError('[FCMService] Failed to initialize Firebase Admin SDK:', err)
    return false
  }
}

export const FCMService = {
  /**
   * Send a push notification. When `data` is provided it will be attached
   * to the message as the data payload (suitable for forwarding ciphertext to the client).
   * The visible `body` should never contain decrypted plaintext for E2EE messages.
   */
  sendPushNotification: async (token: string, message: string, data?: Record<string, string>) => {
    if (!ensureFirebaseInitialized()) return

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