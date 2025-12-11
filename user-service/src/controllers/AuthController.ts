import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { User, AppDataSource } from '../database'
import { APIError, encryptPassword, isPasswordMatch } from '../utils'
import config from '../config/config'
import type { RegistrationBody } from '../types'
import { rabbitMQService } from '../services/RabbitMQService'

const JWT_SECRET = config.JWT_SECRET as string
const COOKIE_EXPIRATION_DAYS = 7

const getCookieOptions = () => {
  const expirationDate = new Date(
    Date.now() + COOKIE_EXPIRATION_DAYS * 24 * 60 * 60 * 1000
  )
  
  return {
    expires: expirationDate,
    // Secure cookies in production (HTTPS required)
    // In dev, we proxy frontend through nginx so same-origin applies even without HTTPS
    secure: config.env === 'production',
    httpOnly: true, // Prevent XSS attacks by blocking JavaScript access
    // Use 'lax' instead of 'strict' to allow cookies when navigating from localhost:5173 to localhost:85
    // 'strict' blocks cross-port requests even on localhost
    sameSite: config.env === 'production' ? 'strict' as const : 'lax' as const,
    path: '/', // Cookie available for all paths
  }
}

const registration = async (
  req: Request<unknown, unknown, RegistrationBody>,
  res: Response,
  _next: NextFunction
) => {
  try {
    const { username, email, password } = req.body
    const userRepo = AppDataSource.getRepository(User)

    // Basic username validation: allow letters, numbers, underscores, hyphens; 3-30 chars
    const uname = String(username || '').trim().toLowerCase()
    const usernameRegex = /^[a-z0-9_-]{3,30}$/
    if (!usernameRegex.test(uname)) {
      throw new APIError(400, 'Invalid username. Use 3-30 characters: letters, numbers, _ or -')
    }

    // Check uniqueness for email and username
    const existing = await userRepo.findOne({ where: [ { email }, { username: uname } ] })
    if (existing) {
      if (existing.email === email) {
        throw new APIError(400, 'User with this email already exists')
      }
      throw new APIError(400, 'Username already taken')
    }

    const user = await userRepo.save({
      username: uname,
      email,
      password: await encryptPassword(password),
    })

    const userData = {
      id: user.id,
      username: user.username,
      email: user.email,
    }

    // Token is sent via httpOnly cookie only (not in response body for security)
    // Also create and send JWT cookie so clients are authenticated immediately
    await createSendToken(user as User, res)

    // Publish a notification event so the notification-service can create
    // a DB notification and optionally send a welcome email to the user.
    try {
      await rabbitMQService.publishNotification({
        type: 'USER_REGISTERED',
        userId: user.id,
        userEmail: user.email,
        fromName: 'System',
        message: 'Welcome to the Chat App!'
      })
    } catch (e) {
      // Log and continue — registration succeeded even if publishing fails
      console.warn('[user-service] Failed to publish USER_REGISTERED event', e)
    }

    return res.json({
      status: 200,
      message: 'User registered successfully',
      data: userData,
    })
  } catch (error: unknown) {
    _next(error)
  }
}

const createSendToken = async (
  user: User,
  res: Response,
) => {
  // Use TypeORM entity properties
  const { username, email, id } = user

  const token = jwt.sign({ username, email, id }, JWT_SECRET, {
    expiresIn: '1d',
  })

  const cookieOptions = getCookieOptions()
  res.cookie('jwt', token, cookieOptions)

  return token
}

const login = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { email, password } = req.body
    const userRepo = AppDataSource.getRepository(User)
    
    const user = await userRepo.findOne({ 
      where: { email },
      select: ['id', 'username', 'email', 'password', 'createdAt', 'updatedAt']
    })
    
    // Check if user exists first before comparing passwords
    if (!user) {
      throw new APIError(401, 'Invalid email or password')
    }
    
    const passwordMatches = await isPasswordMatch(password, user.password)

    if (!passwordMatches) {
      throw new APIError(401, 'Invalid email or password')
    }
    
    // Create and send JWT via httpOnly cookie
    await createSendToken(user, res)

    return res.json({
      status: 200,
      message: 'Login successful',
    })
  } catch ( error: unknown ) {
    // Pass error to Express error handling middleware
    next(error)
  }
}

const getCurrentUser = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    // req.user is populated by authenticate middleware
    if (!req.user) {
      throw new APIError(401, 'Authentication required')
    }

    // Fetch full user data from database
    const userRepo = AppDataSource.getRepository(User)
    const user = await userRepo.findOne({ 
      where: { id: req.user.id },
      select: ['id', 'username', 'email', 'createdAt', 'updatedAt']
    })
    
    if (!user) {
      throw new APIError(404, 'User not found')
    }

    return res.json({
      status: 200,
      message: 'User retrieved successfully',
      data: {
        id: user.id,
        username: user.username,
        email: user.email,
      }
    })
  } catch (error: unknown) {
    next(error)
  }
}

const search = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const q = (req.query.q as string) || ''
    if (!q || q.trim().length === 0) {
      return res.json({ status: 200, data: [] })
    }

    // Get current user ID from JWT token
    const currentUserId = req.user?.id
    const userRepo = AppDataSource.getRepository(User)

    // Search by username or email, excluding the current logged-in user
    // Using ILIKE for case-insensitive search
    const searchTerm = `%${q.trim()}%`
    const users = await userRepo
      .createQueryBuilder('user')
      .where('user.id != :currentUserId', { currentUserId })
      .andWhere('(user.username ILIKE :searchTerm OR user.email ILIKE :searchTerm)', { searchTerm })
      .select(['user.id', 'user.username', 'user.email'])
      .limit(20)
      .getMany()

    const mapped = users.map((u: User) => ({ _id: u.id, username: u.username, email: u.email }))

    return res.json({ status: 200, data: mapped })
  } catch (error) {
    console.warn('[WARN] AuthController.search failed, returning empty result', error)
    return res.json({ status: 200, data: [] })
  }
}

const getUserById = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.params.userId as string
    
    if (!userId) {
      throw new APIError(400, 'User ID is required')
    }

    const userRepo = AppDataSource.getRepository(User)
    const user = await userRepo.findOne({ 
      where: { id: userId },
      select: ['id', 'username', 'email', 'createdAt', 'updatedAt']
    })
    
    if (!user) {
      throw new APIError(404, 'User not found')
    }

    return res.json({
      status: 200,
      message: 'User retrieved successfully',
      data: {
        id: user.id,
        username: user.username,
        email: user.email,
      }
    })
  } catch (error: unknown) {
    next(error)
  }
}

const logout = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    // Clear the jwt cookie set during login/registration
    const cookieOptions = getCookieOptions()
    // Use clearCookie (express) with same options so browser removes it
    res.clearCookie('jwt', { path: cookieOptions.path, httpOnly: cookieOptions.httpOnly, secure: cookieOptions.secure, sameSite: cookieOptions.sameSite })

    return res.json({ status: 200, message: 'Logged out successfully' })
  } catch (error: unknown) {
    next(error)
  }
}

export default {
  registration,
  login,
  getCurrentUser,
  logout,
  search,
  getUserById,
}

// Named exports for CommonJS `require()` based tests
export {
  registration,
  login,
  getCurrentUser,
  logout,
  search,
  getUserById,
}