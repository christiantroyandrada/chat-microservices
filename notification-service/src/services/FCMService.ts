import admin from 'firebase-admin'

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
    const payload: any = {
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
      console.log('Push notification sent successfully')
    } catch (err) {
      console.error('Error sending notification', err)
    }
  },
}