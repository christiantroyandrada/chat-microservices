import type { FCMMessagePayload } from '../../src/types'

const originalCredentials = process.env.GOOGLE_APPLICATION_CREDENTIALS

jest.mock('firebase-admin/app', () => ({
  applicationDefault: jest.fn(),
  getApps: jest.fn(),
  initializeApp: jest.fn(),
}))

jest.mock('firebase-admin/messaging', () => ({
  getMessaging: jest.fn(),
}))

jest.mock('../../src/utils/logger', () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
}))

type FirebaseAppBoundary = {
  applicationDefault: jest.Mock
  getApps: jest.Mock
  initializeApp: jest.Mock
}

type FirebaseMessagingBoundary = {
  getMessaging: jest.Mock
}

function firebaseApp(): FirebaseAppBoundary {
  return jest.requireMock('firebase-admin/app') as FirebaseAppBoundary
}

function firebaseMessaging(): FirebaseMessagingBoundary {
  return jest.requireMock('firebase-admin/messaging') as FirebaseMessagingBoundary
}

function loadService(): typeof import('../../src/services/FCMService') {
  return require('../../src/services/FCMService') as typeof import('../../src/services/FCMService')
}

function restoreCredentials(): void {
  if (originalCredentials === undefined) {
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS
    return
  }
  process.env.GOOGLE_APPLICATION_CREDENTIALS = originalCredentials
}

describe('FCMService.sendPushNotification', () => {
  beforeEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
    firebaseApp().getApps.mockReturnValue([])
  })

  afterEach(() => {
    restoreCredentials()
    jest.resetModules()
  })

  test('does nothing and resolves when application credentials are missing', async () => {
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS
    const send = jest.fn()
    firebaseMessaging().getMessaging.mockReturnValue({ send })

    await expect(loadService().FCMService.sendPushNotification('token-1', 'Hello')).resolves.toBeUndefined()

    expect(firebaseApp().getApps).not.toHaveBeenCalled()
    expect(firebaseApp().initializeApp).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  test('initializes an empty app registry once and sends the exact message with non-empty data', async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/tmp/firebase-service-account.json'
    const credential = { kind: 'application-default' }
    const send = jest.fn().mockResolvedValue('message-1')
    firebaseApp().applicationDefault.mockReturnValue(credential)
    firebaseMessaging().getMessaging.mockReturnValue({ send })

    await expect(loadService().FCMService.sendPushNotification('device-token', 'Encrypted preview', { conversationId: 'c-1' })).resolves.toBeUndefined()

    expect(firebaseApp().getApps).toHaveBeenCalledTimes(1)
    expect(firebaseApp().applicationDefault).toHaveBeenCalledTimes(1)
    expect(firebaseApp().initializeApp).toHaveBeenCalledTimes(1)
    expect(firebaseApp().initializeApp).toHaveBeenCalledWith({ credential })
    expect(send).toHaveBeenCalledWith({
      notification: { title: 'New Message', body: 'Encrypted preview' },
      token: 'device-token',
      data: { conversationId: 'c-1' },
    } satisfies FCMMessagePayload)
  })

  test('uses an existing app without initializing another app and omits empty data', async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/tmp/firebase-service-account.json'
    firebaseApp().getApps.mockReturnValue([{ name: '[DEFAULT]' }])
    const send = jest.fn().mockResolvedValue('message-2')
    firebaseMessaging().getMessaging.mockReturnValue({ send })

    await expect(loadService().FCMService.sendPushNotification('device-token', 'Hello', {})).resolves.toBeUndefined()

    expect(firebaseApp().initializeApp).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith({
      notification: { title: 'New Message', body: 'Hello' },
      token: 'device-token',
    } satisfies FCMMessagePayload)
  })

  test('logs an initialization failure, does not send, and retries initialization later', async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/tmp/firebase-service-account.json'
    const send = jest.fn().mockResolvedValue('message-3')
    firebaseApp().applicationDefault.mockReturnValue({ kind: 'application-default' })
    firebaseApp().initializeApp
      .mockImplementationOnce(() => { throw new Error('credential unavailable') })
      .mockReturnValue({ name: '[DEFAULT]' })
    firebaseMessaging().getMessaging.mockReturnValue({ send })
    const { logError } = jest.requireMock('../../src/utils/logger') as { logError: jest.Mock }
    const { FCMService } = loadService()

    await expect(FCMService.sendPushNotification('device-token', 'First try')).resolves.toBeUndefined()
    await expect(FCMService.sendPushNotification('device-token', 'Second try')).resolves.toBeUndefined()

    expect(firebaseApp().initializeApp).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({
      notification: { title: 'New Message', body: 'Second try' },
      token: 'device-token',
    } satisfies FCMMessagePayload)
    expect(logError).toHaveBeenCalledWith('[FCMService] Failed to initialize Firebase Admin SDK:', expect.any(Error))
  })

  test('contains a messaging send failure and resolves the caller', async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/tmp/firebase-service-account.json'
    firebaseApp().applicationDefault.mockReturnValue({ kind: 'application-default' })
    firebaseApp().initializeApp.mockReturnValue({ name: '[DEFAULT]' })
    const send = jest.fn().mockRejectedValue(new Error('messaging unavailable'))
    firebaseMessaging().getMessaging.mockReturnValue({ send })
    const { logError } = jest.requireMock('../../src/utils/logger') as { logError: jest.Mock }

    await expect(loadService().FCMService.sendPushNotification('device-token', 'Hello')).resolves.toBeUndefined()

    expect(logError).toHaveBeenCalledWith('Error sending notification', expect.any(Error))
  })
})
