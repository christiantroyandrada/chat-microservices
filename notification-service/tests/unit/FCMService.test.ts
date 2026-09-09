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

  test('initializes an empty registry once and delivers two messages through the initialized app', async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/tmp/firebase-service-account.json'
    const credential = { kind: 'application-default' }
    const defaultApp = { name: '[DEFAULT]' }
    const send = jest.fn().mockResolvedValue('message-1')
    firebaseApp().getApps
      .mockReturnValueOnce([])
      .mockReturnValue([defaultApp])
    firebaseApp().applicationDefault.mockReturnValue(credential)
    firebaseApp().initializeApp.mockReturnValue(defaultApp)
    firebaseMessaging().getMessaging.mockReturnValue({ send })
    const { FCMService } = loadService()

    await expect(FCMService.sendPushNotification('device-token', 'Encrypted preview', { conversationId: 'c-1' })).resolves.toBeUndefined()
    await expect(FCMService.sendPushNotification('device-token', 'Follow up')).resolves.toBeUndefined()

    expect(firebaseApp().getApps).toHaveBeenCalledTimes(2)
    expect(firebaseApp().applicationDefault).toHaveBeenCalledTimes(1)
    expect(firebaseApp().initializeApp).toHaveBeenCalledTimes(1)
    expect(firebaseApp().initializeApp).toHaveBeenCalledWith({ credential })
    expect(firebaseMessaging().getMessaging).toHaveBeenNthCalledWith(1, defaultApp)
    expect(firebaseMessaging().getMessaging).toHaveBeenNthCalledWith(2, defaultApp)
    expect(send).toHaveBeenNthCalledWith(1, {
      notification: { title: 'New Message', body: 'Encrypted preview' },
      token: 'device-token',
      data: { conversationId: 'c-1' },
    } satisfies FCMMessagePayload)
    expect(send).toHaveBeenNthCalledWith(2, {
      notification: { title: 'New Message', body: 'Follow up' },
      token: 'device-token',
    } satisfies FCMMessagePayload)
  })

  test('uses an existing default app without credential discovery and omits empty data', async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/tmp/firebase-service-account.json'
    const defaultApp = { name: '[DEFAULT]' }
    firebaseApp().getApps.mockReturnValue([defaultApp])
    const send = jest.fn().mockResolvedValue('message-2')
    firebaseMessaging().getMessaging.mockReturnValue({ send })

    await expect(loadService().FCMService.sendPushNotification('device-token', 'Hello', {})).resolves.toBeUndefined()

    expect(firebaseApp().initializeApp).not.toHaveBeenCalled()
    expect(firebaseApp().applicationDefault).not.toHaveBeenCalled()
    expect(firebaseMessaging().getMessaging).toHaveBeenCalledWith(defaultApp)
    expect(send).toHaveBeenCalledWith({
      notification: { title: 'New Message', body: 'Hello' },
      token: 'device-token',
    } satisfies FCMMessagePayload)
  })

  test('uses a named app when no default app exists without credential discovery', async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/tmp/firebase-service-account.json'
    const namedApp = { name: 'notifications' }
    const send = jest.fn().mockResolvedValue('message-3')
    firebaseApp().getApps.mockReturnValue([namedApp])
    firebaseMessaging().getMessaging.mockReturnValue({ send })

    await expect(loadService().FCMService.sendPushNotification('device-token', 'Hello')).resolves.toBeUndefined()

    expect(firebaseApp().initializeApp).not.toHaveBeenCalled()
    expect(firebaseApp().applicationDefault).not.toHaveBeenCalled()
    expect(firebaseMessaging().getMessaging).toHaveBeenCalledWith(namedApp)
    expect(send).toHaveBeenCalledWith({
      notification: { title: 'New Message', body: 'Hello' },
      token: 'device-token',
    } satisfies FCMMessagePayload)
  })

  test('reinitializes after an app disappears from the registry', async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/tmp/firebase-service-account.json'
    const removedApp = { name: 'notifications' }
    const recoveredApp = { name: '[DEFAULT]' }
    const credential = { kind: 'application-default' }
    const send = jest.fn().mockResolvedValue('message-4')
    firebaseApp().getApps
      .mockReturnValueOnce([removedApp])
      .mockReturnValueOnce([])
    firebaseApp().applicationDefault.mockReturnValue(credential)
    firebaseApp().initializeApp.mockReturnValue(recoveredApp)
    firebaseMessaging().getMessaging.mockReturnValue({ send })
    const { FCMService } = loadService()

    await expect(FCMService.sendPushNotification('device-token', 'Before deletion')).resolves.toBeUndefined()
    await expect(FCMService.sendPushNotification('device-token', 'After deletion')).resolves.toBeUndefined()

    expect(firebaseApp().applicationDefault).toHaveBeenCalledTimes(1)
    expect(firebaseApp().initializeApp).toHaveBeenCalledWith({ credential })
    expect(firebaseMessaging().getMessaging).toHaveBeenNthCalledWith(1, removedApp)
    expect(firebaseMessaging().getMessaging).toHaveBeenNthCalledWith(2, recoveredApp)
    expect(send).toHaveBeenCalledTimes(2)
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

describe('Firebase Admin modular smoke', () => {
  test('initializes a named local app and constructs messaging without network access', async () => {
    const { deleteApp, initializeApp } = jest.requireActual('firebase-admin/app') as typeof import('firebase-admin/app')
    const { getMessaging } = jest.requireActual('firebase-admin/messaging') as typeof import('firebase-admin/messaging')
    const app = initializeApp({ projectId: 'notification-service-fcm-smoke' }, `notification-service-fcm-smoke-${Date.now()}`)

    try {
      expect(getMessaging(app)).toBeDefined()
    } finally {
      await deleteApp(app)
    }
  })
})
