import { fork, ChildProcess } from 'node:child_process'
import { join } from 'node:path'

export type ProviderRequest =
  | { provider: 'email'; to: string; subject: string; html: string }
  | { provider: 'push'; token: string; message: string; envelope?: string }

export type ProviderResult =
  | { status: 'sent'; attempt: 'started' }
  | { status: 'deferred'; attempt: 'not_started'; reason: 'provider_disabled' | 'sender_unconfigured' }
  | { status: 'retry'; attempt: 'started' | 'unknown'; reason: 'transient' | 'timeout' | 'child_failed' | 'protocol_error' }
  | { status: 'failed'; attempt: 'started'; reason: 'invalid_destination' | 'invalid_payload' | 'provider_rejected' }

export class NotificationProviderBoundaryError extends Error {
  constructor(readonly code: 'PROVIDER_CAPACITY' | 'PROVIDER_TERMINATION_UNCONFIRMED') { super(code) }
}

function fields(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === null || Object.getPrototypeOf(Object.getPrototypeOf(value)) === null) && !('toJSON' in value) &&
    Reflect.ownKeys(value).every(key => typeof key === 'string' && [...required, ...optional].includes(key) && 'value' in Object.getOwnPropertyDescriptor(value, key)!) &&
    required.every(key => Object.prototype.hasOwnProperty.call(value, key))
}

export function validateProviderRequest(value: unknown): ProviderRequest {
  const invalid = () => { throw new TypeError('Invalid notification provider request') }
  if (!fields(value, ['provider'], ['to', 'subject', 'html', 'token', 'message', 'envelope'])) return invalid()
  const request = value
  const limits = request.provider === 'email' ? { to: 320, subject: 255, html: 100000 } : { token: 4096, message: 5000, envelope: 5000 }
  const required = request.provider === 'email' ? ['provider', 'to', 'subject', 'html'] : ['provider', 'token', 'message']
  if (!['email', 'push'].includes(request.provider as string) || !fields(value, required, request.provider === 'push' ? ['envelope'] : [])) return invalid()
  for (const [key, limit] of Object.entries(limits)) {
    if (key === 'envelope' && !Object.prototype.hasOwnProperty.call(request, key)) continue
    const field = request[key]
    if (typeof field !== 'string' || !field.trim() || field.length > limit || /[\u0000\uD800-\uDFFF]/u.test(field)) return invalid()
  }
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > 100000) return invalid()
  return request as ProviderRequest
}

function validResult(value: unknown): value is ProviderResult {
  if (!fields(value, ['status', 'attempt'], ['reason'])) return false
  const result = value
  if (result.status === 'sent') return fields(value, ['status', 'attempt']) && result.attempt === 'started'
  if (!fields(value, ['status', 'attempt', 'reason'])) return false
  if (result.status === 'deferred') return result.attempt === 'not_started' && ['provider_disabled', 'sender_unconfigured'].includes(result.reason as string)
  if (result.status === 'retry') return ['started', 'unknown'].includes(result.attempt as string) && ['transient', 'timeout', 'child_failed', 'protocol_error'].includes(result.reason as string)
  return result.status === 'failed' && result.attempt === 'started' && ['invalid_destination', 'invalid_payload', 'provider_rejected'].includes(result.reason as string)
}

export class NotificationProvider {
  private live = 0
  private blocked = false

  async dispatch(value: unknown): Promise<ProviderResult> {
    if (this.blocked) throw new NotificationProviderBoundaryError('PROVIDER_TERMINATION_UNCONFIRMED')
    const request = validateProviderRequest(value)
    if (this.live >= 2) throw new NotificationProviderBoundaryError('PROVIDER_CAPACITY')
    this.live++
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'production' }
    for (const key of ['EMAIL_FROM', 'SENDINBLUE_APIKEY', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'GOOGLE_APPLICATION_CREDENTIALS']) {
      if (process.env[key] !== undefined) env[key] = process.env[key]
    }
    return new Promise((resolve, reject) => {
      let child: ChildProcess | undefined
      let result: ProviderResult | undefined
      let failure: 'timeout' | 'child_failed' | 'protocol_error' | undefined
      let exited = false
      let confirmation: NodeJS.Timeout | undefined
      const terminate = (reason: typeof failure) => {
        if (exited || failure) return
        failure = reason
        try { child?.kill('SIGKILL') } catch { /* Exit confirmation determines whether the slot is reusable. */ }
        confirmation = setTimeout(() => {
          if (!exited) {
            this.blocked = true
            reject(new NotificationProviderBoundaryError('PROVIDER_TERMINATION_UNCONFIRMED'))
          }
        }, 1000)
      }
      const deadline = setTimeout(() => terminate('timeout'), 15000)
      try {
        child = fork(join(__dirname, 'NotificationProviderChild.js'), [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env })
      } catch {
        clearTimeout(deadline)
        this.live--
        resolve({ status: 'retry', attempt: 'unknown', reason: 'child_failed' })
        return
      }
      child.on('message', value => {
        if (result || !validResult(value)) terminate('protocol_error')
        else result = value
      })
      child.on('error', () => terminate('child_failed'))
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (exited) return
        exited = true
        clearTimeout(deadline)
        if (confirmation) clearTimeout(confirmation)
        this.live--
        if (failure) resolve({ status: 'retry', attempt: 'unknown', reason: failure })
        else if (code === 0 && signal === null && result) resolve(result)
        else resolve({ status: 'retry', attempt: 'unknown', reason: code === 0 && signal === null ? 'protocol_error' : 'child_failed' })
      }
      child.once('exit', finish)
      child.once('close', (code, signal) => { if (child?.pid === undefined) finish(code, signal) })
      try { child.send(request, error => { if (error) terminate('child_failed') }) }
      catch { terminate('child_failed') }
    })
  }
}
