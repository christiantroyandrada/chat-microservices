import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import config from '../config/config'
import { APIError } from '../utils'
import type { JwtPayload } from '../types'

// Extend Express Request type to include user
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload
    }
  }
}

export const authenticated = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    // Check for token in Authorization header
    const authHeader = req.headers.authorization
    let token: string | undefined

    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.substring(7)
    }

    // Also check for token in cookies as fallback
    if (!token && req.cookies?.jwt) {
      token = req.cookies.jwt
    }

    if (!token) {
      throw new APIError(401, 'Authentication required. Please log in.')
    }

    // Verify token
    const decoded = jwt.verify(token, config.JWT_SECRET as string) as JwtPayload

    // Attach user info to request
    req.user = decoded
    next()
  } catch (error: unknown) {
    if (error instanceof jwt.JsonWebTokenError) {
      next(new APIError(401, 'Invalid token. Please log in again.'))
    } else if (error instanceof jwt.TokenExpiredError) {
      next(new APIError(401, 'Token expired. Please log in again.'))
    } else {
      next(error)
    }
  }
}
