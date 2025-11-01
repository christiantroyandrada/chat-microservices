import { Request, Response, NextFunction, ErrorRequestHandler } from 'express'
import jwt from 'jsonwebtoken'
import { APIError } from '../utils'
import config from '../config/config'

interface TokenPayload {
  id: string
  name: string
  email: string
  iat: number
  exp: number
}

interface IUser {
  _id: string
  name: string
  email: string
  password: string
  createdAt: Date
  updatedAt: Date
}

export interface AuthenticatedRequest extends Request {
  user: IUser
}

const jwtSecret = config.JWT_SECRET as string

const authMiddleware = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => {
  const authHeader = req.headers.authorization
  if (!authHeader) {
    return next(new APIError(401, 'Authorization header missing'))
  }
  const [, token] = authHeader.split(' ')
  try {
    const decoded = jwt.verify(token, jwtSecret) as TokenPayload
    req.user = {
      _id: decoded.id,
      name: decoded.name,
      email: decoded.email,
      password: '',
      createdAt: new Date(decoded.iat * 1000),
      updatedAt: new Date(decoded.exp * 1000),
    }
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
  next()
}

export {
  authMiddleware,
  errorMiddleware,
  errorHandler,
}