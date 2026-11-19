/**
 * Shared constants for the notification-service.
 *
 * Centralises magic strings / URLs used across multiple handlers
 * so they can be updated in one place (DRY).
 */

export const WELCOME_EMAIL_SUBJECT = 'Welcome to Secret'

/** Fallback application URL for links in email templates. */
export const APP_URL = process.env.PUBLIC_URL || 'http://localhost:85'
