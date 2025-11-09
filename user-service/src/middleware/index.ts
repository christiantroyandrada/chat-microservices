import { ErrorRequestHandler } from 'express'
import { APIError } from '../utils'

export const errorMiddleware: ErrorRequestHandler = (
  err,
  req,
  res,
  next,
) => {
  let error = err

  if (!(error instanceof APIError)) {
    const statusCode = error.statusCode || (error instanceof Error ? 400 : 500)
    const message = error.message || (
      statusCode === 500 ? 'Internal Server Error' : 'Bad Request'
    )
    error = new APIError(statusCode, message, false, err.stack.toString())
  }
  next(error)
}

export const errorHandler: ErrorRequestHandler = (
  err,
  req,
  res,
  next,
) =>{
  let { statusCode, message } = err
  const environment = process.env.NODE_ENV ?? 'development'

  // Log errors with appropriate detail based on environment
  const safeErrorLog = {
    message: err.message,
    statusCode: err.statusCode,
    isOperational: err.isOperational,
    path: req.path,
    method: req.method,
  }
  
  console.error('[user-service] Error:', safeErrorLog)
  
  // Only log stack traces in non-production
  if (environment !== 'production' && err.stack) {
    console.error('[user-service] Stack:', err.stack)
  }

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

  res.status(statusCode).json(response)
}