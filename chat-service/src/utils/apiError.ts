/**
 * API Error class for consistent error handling
 * 
 * MICROSERVICES PATTERN: This class is duplicated across services intentionally.
 * Each microservice maintains its own copy for independent deployability.
 * Keep the interface consistent across: user-service, chat-service, notification-service
 */
export class APIError extends Error {
  statusCode: number
  isOperational: boolean

  constructor (
    statusCode: number,
    message: string | undefined,
    isOperational = true,
    stack = ''
  ) {
    super(message)
    this.name = 'APIError'
    this.statusCode = statusCode
    this.isOperational = isOperational
    if (stack) {
      this.stack = stack
    } else {
      Error.captureStackTrace(this, this.constructor)
    }
  }
}