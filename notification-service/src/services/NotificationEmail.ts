import config from '../config/config'
import { APP_URL, WELCOME_EMAIL_SUBJECT } from '../config/constants'
import { loadTemplate, renderTemplate } from './EmailTemplateService'

const escapes = new Map([
  ['&', '&amp;'], ['<', '&lt;'], ['>', '&gt;'], ['"', '&quot;'], ["'", '&#39;']
])

function escapeHtml (value: string): string {
  return value.replace(/[&<>"']/g, character => escapes.get(character)!)
}

export function renderNotificationEmail ({ type, fromName, message, isEncrypted }: Record<string, unknown>) {
  const template = loadTemplate('notification.html')
  if (!template) return undefined

  const welcome = type === 'USER_REGISTERED'
  const name = typeof fromName === 'string' && fromName ? fromName : 'Unknown'
  const subject = welcome ? WELCOME_EMAIL_SUBJECT : `New message from ${name}`
  let body = typeof message === 'string' ? message : 'You have a new message.'
  if (welcome) body = 'Your account is ready. Find someone you know and send your first message.'
  else if (isEncrypted) body = 'You have a new encrypted message. Open the app to view it.'

  const html = renderTemplate(template, {
    TITLE: escapeHtml(subject),
    BODY: escapeHtml(body),
    APP_URL: escapeHtml(APP_URL),
    YEAR: String(new Date().getFullYear()),
    EMAIL_FROM: escapeHtml(config.EMAIL_FROM || 'notifications@chat-app'),
  })
  return { subject, html }
}
