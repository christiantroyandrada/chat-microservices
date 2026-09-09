import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app'
import { getMessaging } from 'firebase-admin/messaging'
import type { FCMMessagePayload } from '../types'
import { logInfo, logWarn, logError } from '../utils/logger'

let firebaseInitialized = false

function ensureFirebaseInitialized(): boolean {
  if (firebaseInitialized) return true
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    logWarn('[FCMService] GOOGLE_APPLICATION_CREDENTIALS not set — push notifications disabled')
    return false
  }
  try {
    if (getApps().length === 0) initializeApp({ credential: applicationDefault() })
    firebaseInitialized = true
    logInfo('[FCMService] Firebase Admin SDK initialized')
    return true
  } catch (err) {
    logError('[FCMService] Failed to initialize Firebase Admin SDK:', err)
    return false
  }
}

export const FCMService = {
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
      await getMessaging().send(payload)
      logInfo('Push notification sent successfully')
    } catch (err) {
      logError('Error sending notification', err)
    }
  },
}
