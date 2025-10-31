import admin from 'firebase-admin'

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
})

export const FCMService = {
  sendPushNotification: async (token: string, message: string) => {
    const payload = {
      notification: {
        title: 'New Message',
        body: message,
      },
      token: token,
    }

    try {
      await admin.messaging().send(payload)
      console.log('Push notification sent successfully')
    } catch (err) {
      console.error('Error sending notification', err)
    }
  },
}