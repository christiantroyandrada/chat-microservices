import { deliverProviderRequest } from '../../src/services/NotificationProviderChild'
import config from '../../src/config/config'
import { SecureEmailService } from '../../src/services/SecureEmailService'
import { FCMService } from '../../src/services/FCMService'

jest.mock('../../src/config/config', () => ({ __esModule: true, default: { EMAIL_FROM: undefined, SENDINBLUE_APIKEY: undefined, smtp: {} } }))
jest.mock('../../src/services/SecureEmailService', () => ({ SecureEmailService: jest.fn() }))
jest.mock('../../src/services/FCMService', () => ({ FCMService: { sendPushNotification: jest.fn() } }))
const sendEmail = jest.fn()
const sendPush = FCMService.sendPushNotification as jest.Mock
const email = { provider: 'email', to: 'person@fixture.invalid', subject: 'Subject', html: '<p>Body</p>' }
const push = { provider: 'push', token: 'fixture-device', message: '[Encrypted message]', envelope: '{"__encrypted":true,"body":"fixture"}' }
beforeEach(() => {
  jest.replaceProperty(process, 'env', { NODE_ENV: 'production' })
  jest.clearAllMocks()
  sendEmail.mockReset()
  sendPush.mockReset()
  config.EMAIL_FROM = undefined
  config.SENDINBLUE_APIKEY = undefined
  config.smtp = { host: undefined, user: undefined, pass: undefined, port: 587 }
  ;(SecureEmailService as jest.Mock).mockImplementation(() => ({ sendTransactionalEmail: sendEmail }))
})
afterEach(() => jest.restoreAllMocks())

test('defers disabled email and push before constructing or calling a provider', async () => {
  await expect(deliverProviderRequest(email)).resolves.toEqual({ status: 'deferred', attempt: 'not_started', reason: 'provider_disabled' })
  await expect(deliverProviderRequest(push)).resolves.toEqual({ status: 'deferred', attempt: 'not_started', reason: 'provider_disabled' })
  expect(SecureEmailService).not.toHaveBeenCalled()
  expect(sendEmail).not.toHaveBeenCalled()
  expect(sendPush).not.toHaveBeenCalled()
})

test.each(['smtp', 'brevo'])('requires a sender for %s before provider calls', async provider => {
  if (provider === 'smtp') config.smtp = { host: 'smtp.fixture.invalid', user: 'fixture-user', pass: 'fixture-pass', port: 587 }
  else config.SENDINBLUE_APIKEY = 'fixture-key'
  await expect(deliverProviderRequest(email)).resolves.toEqual({ status: 'deferred', attempt: 'not_started', reason: 'sender_unconfigured' })
  expect(SecureEmailService).not.toHaveBeenCalled()
  expect(sendEmail).not.toHaveBeenCalled()
})

test('accepts configured SMTP without a Brevo key', async () => {
  config.EMAIL_FROM = 'sender@fixture.invalid'
  config.smtp = { host: 'smtp.fixture.invalid', user: 'fixture-user', pass: 'fixture-pass', port: 587 }
  sendEmail.mockResolvedValue({ messageId: 'fixture-accepted' })
  await expect(deliverProviderRequest(email)).resolves.toEqual({ status: 'sent', attempt: 'started' })
  expect(sendEmail).toHaveBeenCalledWith(email.to, email.subject, email.html)
})

test('reports FCM acceptance and preserves the exact envelope', async () => {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = '/fixture/never-read.json'
  sendPush.mockResolvedValue('fixture-accepted')
  await expect(deliverProviderRequest(push)).resolves.toEqual({ status: 'sent', attempt: 'started' })
  expect(sendPush).toHaveBeenCalledWith(push.token, push.message, { envelope: push.envelope })
  sendPush.mockResolvedValue(undefined)
  await expect(deliverProviderRequest(push)).resolves.toEqual({ status: 'retry', attempt: 'started', reason: 'transient' })
})

test.each([
  ['messaging/invalid-registration-token', 'invalid_destination'],
  ['messaging/registration-token-not-registered', 'invalid_destination'],
  ['messaging/invalid-argument', 'invalid_payload'],
  ['messaging/payload-size-limit-exceeded', 'invalid_payload'],
  ['messaging/server-unavailable', 'transient'],
  ['unknown-private-code', 'transient'],
])('maps FCM %s to a fixed safe result', async (code, reason) => {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = '/fixture/never-read.json'
  sendPush.mockRejectedValue(Object.assign(new Error('fixture-private-token-and-error'), { code }))
  const result = await deliverProviderRequest(push)
  expect(result).toEqual({ status: reason === 'transient' ? 'retry' : 'failed', attempt: 'started', reason })
  expect(JSON.stringify(result)).not.toContain('private')
})

test.each([
  [{ code: 'EENVELOPE', responseCode: 550 }, 'invalid_destination'],
  [{ response: { status: 400, data: { code: 'invalid_email' } } }, 'invalid_destination'],
  [{ response: { status: 400, data: { code: 'invalid_parameter' } } }, 'invalid_payload'],
  [{ response: { status: 403 } }, 'provider_rejected'],
  [{ response: { status: 429 } }, 'transient'],
  [{ response: { status: 503 } }, 'transient'],
  [new Error('fixture-private-error'), 'transient'],
])('maps email rejection to a safe result: %j', async (failure, reason) => {
  config.EMAIL_FROM = 'sender@fixture.invalid'
  config.SENDINBLUE_APIKEY = 'fixture-key'
  sendEmail.mockRejectedValue(failure)
  await expect(deliverProviderRequest(email)).resolves.toEqual({ status: reason === 'transient' ? 'retry' : 'failed', attempt: 'started', reason })
})
