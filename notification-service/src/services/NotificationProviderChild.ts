import { validateProviderRequest, ProviderResult } from './NotificationProvider'

export async function deliverProviderRequest(value: unknown): Promise<ProviderResult> {
  const request = validateProviderRequest(value)
  const { default: config } = await import('../config/config')
  if (request.provider === 'email') {
    if (!(config.smtp?.host && config.smtp.user && config.smtp.pass) && !config.SENDINBLUE_APIKEY) return { status: 'deferred', attempt: 'not_started', reason: 'provider_disabled' }
    if (!config.EMAIL_FROM) return { status: 'deferred', attempt: 'not_started', reason: 'sender_unconfigured' }
  } else if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) return { status: 'deferred', attempt: 'not_started', reason: 'provider_disabled' }
  try {
    if (request.provider === 'email') {
      const { SecureEmailService } = await import('./SecureEmailService')
      await new SecureEmailService().sendTransactionalEmail(request.to, request.subject, request.html)
    } else {
      const { FCMService } = await import('./FCMService')
      const accepted = await FCMService.sendPushNotification(request.token, request.message, request.envelope === undefined ? undefined : { envelope: request.envelope })
      if (!accepted) return { status: 'retry', attempt: 'started', reason: 'transient' }
    }
    return { status: 'sent', attempt: 'started' }
  } catch (error) {
    const failure = error as { code?: unknown; responseCode?: unknown; response?: { status?: number; data?: { code?: unknown } } } | null
    const code = failure?.code
    if (request.provider === 'push') {
      if (['messaging/invalid-registration-token', 'messaging/registration-token-not-registered'].includes(code as string)) return { status: 'failed', attempt: 'started', reason: 'invalid_destination' }
      if (['messaging/invalid-argument', 'messaging/invalid-payload', 'messaging/payload-size-limit-exceeded', 'messaging/invalid-data-payload-key'].includes(code as string)) return { status: 'failed', attempt: 'started', reason: 'invalid_payload' }
    } else {
      if ((code === 'EENVELOPE' && [550, 551, 553].includes(failure?.responseCode as number)) || failure?.response?.data?.code === 'invalid_email') return { status: 'failed', attempt: 'started', reason: 'invalid_destination' }
      if (['invalid_parameter', 'missing_parameter'].includes(failure?.response?.data?.code as string)) return { status: 'failed', attempt: 'started', reason: 'invalid_payload' }
      const status = failure?.response?.status
      if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) return { status: 'failed', attempt: 'started', reason: 'provider_rejected' }
    }
    return { status: 'retry', attempt: 'started', reason: 'transient' }
  }
}

if (require.main === module) {
  process.once('disconnect', () => process.exit(1))
  const deadline = setTimeout(() => process.exit(1), 15000)
  if (!process.send) process.exit(1)
  process.once('message', value => {
    void deliverProviderRequest(value).then(result => {
      process.send!(result, error => { clearTimeout(deadline); process.exit(error ? 1 : 0) })
    }, () => process.exit(1))
  })
}
