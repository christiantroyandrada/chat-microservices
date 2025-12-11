import bcrypt from 'bcryptjs'

/**
 * API Error class for consistent error handling
 * 
 * MICROSERVICES PATTERN: This class is duplicated across services intentionally.
 * Each microservice maintains its own copy for independent deployability.
 * Keep the interface consistent across: user-service, chat-service, notification-service
 */
class APIError extends Error {
  statusCode: number
  isOperational: boolean

  constructor(
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

const encryptPassword = async (password: string): Promise<string> => {
  // Using cost factor 12 for modern security standards (was 10)
  const encryptedPassword = await bcrypt.hash(password, 12) 
  return encryptedPassword
}

const isPasswordMatch = async (password: string, hashedPassword: string): Promise<boolean> => {
  const isMatch = await bcrypt.compare(password, hashedPassword)
  return isMatch
}

export {
  APIError,
  encryptPassword,
  isPasswordMatch,
}