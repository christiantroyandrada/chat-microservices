/**
 * Shared constants for the notification-service.
 *
 * Centralises magic strings / URLs used across multiple handlers
 * so they can be updated in one place (DRY).
 */

/** Public logo URL hosted on Cloudinary — used in all outgoing email templates. */
export const LOGO_URL =
  'https://res.cloudinary.com/dpqt9h7cn/image/upload/v1764081536/logo_blqxwc.png'

/** Fallback application URL for links in email templates. */
export const APP_URL = process.env.PUBLIC_URL || 'http://localhost:85'
