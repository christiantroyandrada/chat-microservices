export interface JwtPayload {
  id: string
  email: string
  username: string
}
// JWT payload used by notification-service auth middleware (if applicable)

export interface AuthenticatedUser {
  _id: string
  email: string
  username: string
}

export interface AuthenticatedRequest extends Express.Request {
  user?: AuthenticatedUser
}
// Extended request type used by any authenticated endpoints in notification-service

// Brevo (SendinBlue) email payload
export interface BrevoEmailPayload {
  sender: {
    email: string
    name: string
  }
  to: Array<{ email: string }>
  subject: string
  htmlContent: string
  textContent?: string
}
// Used by `notification-service/src/services/SecureEmailService.ts` when sending emails

// Brevo account info response
export interface BrevoAccountInfo {
  email: string
  firstName?: string
  lastName?: string
  companyName?: string
  address?: {
    street?: string
    city?: string
    zipCode?: string
    country?: string
  }
  [key: string]: unknown
}
// Returned shape from Brevo account API; used in SecureEmailService.getAccount

// Firebase Cloud Messaging payload
export interface FCMMessagePayload {
  notification: {
    title: string
    body: string
  }
  token: string
  data?: Record<string, string>
}
// Used by `notification-service/src/services/FCMService.ts` when sending push notifications

// Axios error response shape
export interface AxiosErrorResponse {
  status: number
  data: unknown
}
// Local typing for handling axios error responses in SecureEmailService
