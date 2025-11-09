import { Request, Response, NextFunction, ErrorRequestHandler } from 'express'
import jwt from 'jsonwebtoken'
import { APIError } from '../utils'
import config from '../config/config'
import type { TokenPayload, IUser, AuthenticatedRequest } from '../types'

const jwtSecret = config.JWT_SECRET as string

const authMiddleware = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    // Check for token in Authorization header first (backward compatibility)
    let token: string | undefined
    const authHeader = req.headers.authorization
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7)
    }
    
    // Check for token in httpOnly cookie (primary method for browser clients)
    if (!token && req.cookies?.jwt) {
      token = req.cookies.jwt
    }
    
    if (!token) {
      return next(new APIError(401, 'Authentication required'))
    }
    
    const decoded = jwt.verify(token, jwtSecret) as TokenPayload
    req.user = {
      _id: decoded.id,
      name: decoded.name,
      email: decoded.email,
      password: '',
      createdAt: new Date(decoded.iat * 1000),
      updatedAt: new Date(decoded.exp * 1000),
    }
    // proceed to next middleware / route handler
    return next()
  } catch (error) {
    console.error('[chat-service] Error in auth middleware:', error)
    return next(new APIError(401, 'Invalid or expired token'))
  }
}

const errorMiddleware: ErrorRequestHandler = (
  err, req, res, next
) => {
  let error = err
  if ( !(error instanceof APIError) ) {
    const statusCode = error.statusCode || (
      error instanceof APIError ? 400 : 500
    )
    const message = error.message || (
      statusCode === 500 ? 'Internal Server Error' : 'Bad Request'
    )
    error = new APIError(statusCode, message, false, error.stack.toString())
  }
  next(error)
}

const errorHandler: ErrorRequestHandler = (
  err, req, res, next
) => {
  let { statusCode, message } = err
  const environment = config.env || 'development'

  if (environment === 'production' && !err.isOperational) {
    statusCode = 500
    message = 'Internal Server Error'
  }

  res.locals.errorMessage = err.message

  const response = {
    code: statusCode,
    message,
    ...(environment === 'development' && { stack: err.stack }),
  }

  if (environment === 'development') {
    console.error('[chat-service] Error Handler:', err)
  }

  res.status(statusCode).json(response)
}

export {
  authMiddleware,
  errorMiddleware,
  errorHandler,
}

// Re-export types for convenience
export type { AuthenticatedRequest } from '../types'