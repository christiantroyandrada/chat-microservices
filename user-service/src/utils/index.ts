import bcrypt from 'bcryptjs'

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
  const encryptedPassword = await bcrypt.hash(password, 10) 
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