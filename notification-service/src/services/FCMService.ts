import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app'
import { getMessaging } from 'firebase-admin/messaging'
import type { App } from 'firebase-admin/app'
import type { FCMMessagePayload } from '../types'
import { logInfo, logWarn, logError } from '../utils/logger'

function getFirebaseApp(): App | undefined {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    logWarn('[FCMService] GOOGLE_APPLICATION_CREDENTIALS not set — push notifications disabled')
    return undefined
  }
  try {
    const apps = getApps()
    const app = apps.find(({ name }) => name === '[DEFAULT]') ?? apps[0]
    if (app) return app

    const initializedApp = initializeApp({ credential: applicationDefault() })
    logInfo('[FCMService] Firebase Admin SDK initialized')
    return initializedApp
  } catch (err) {
    logError('[FCMService] Failed to initialize Firebase Admin SDK:', err)
    return undefined
  }
}

export const FCMService = {
  sendPushNotification: async (token: string, message: string, data?: Record<string, string>) => {
    const app = getFirebaseApp()
    if (!app) return

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
      await getMessaging(app).send(payload)
      logInfo('Push notification sent successfully')
    } catch (err) {
      logError('Error sending notification', err)
    }
  },
}
