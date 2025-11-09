import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { User, AppDataSource } from '../database'
import { APIError, encryptPassword, isPasswordMatch } from '../utils'
import config from '../config/config'
import { Like, Not } from 'typeorm'
import type { RegistrationBody } from '../types'

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
    const { name, email, password } = req.body
    const userRepo = AppDataSource.getRepository(User)
    
    const userExists = await userRepo.findOne({ where: { email } })
    if (userExists) {
      throw new APIError(400, 'User with this email already exists')
    }

    const user = await userRepo.save({
      name,
      email,
      password: await encryptPassword(password),
    })

    // Generate JWT token for the newly registered user
    const token = await createSendToken(user, res)

    const userData = {
      id: user.id,
      name: user.name,
      email: user.email,
    }

    // Token is sent via httpOnly cookie only (not in response body for security)
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
  const { name, email, id } = user

  const token = jwt.sign({ name, email, id }, JWT_SECRET, {
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
      select: ['id', 'name', 'email', 'password', 'createdAt', 'updatedAt']
    })
    
    // Check if user exists first before comparing passwords
    if (!user) {
      throw new APIError(401, 'Invalid email or password')
    }
    
    const passwordMatches = await isPasswordMatch(password, user.password)

    if (!passwordMatches) {
      throw new APIError(401, 'Invalid email or password')
    }
    
    const token = await createSendToken(user, res)

    // Token is sent via httpOnly cookie only (not in response body for security)
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
      select: ['id', 'name', 'email', 'createdAt', 'updatedAt']
    })
    
    if (!user) {
      throw new APIError(404, 'User not found')
    }

    return res.json({
      status: 200,
      message: 'User retrieved successfully',
      data: {
        id: user.id,
        name: user.name,
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

    // Search by name or email, excluding the current logged-in user
    // Using Like for case-insensitive search
    const searchTerm = `%${q.trim()}%`
    const users = await userRepo
      .createQueryBuilder('user')
      .where('user.id != :currentUserId', { currentUserId })
      .andWhere('(user.name ILIKE :searchTerm OR user.email ILIKE :searchTerm)', { searchTerm })
      .select(['user.id', 'user.name', 'user.email'])
      .limit(20)
      .getMany()

    const mapped = users.map((u: User) => ({ _id: u.id, name: u.name, email: u.email }))

    return res.json({ status: 200, data: mapped })
  } catch (error) {
    // Delegate to error handling middleware
    next(error)
  }
}

const getUserById = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { userId } = req.params
    
    if (!userId) {
      throw new APIError(400, 'User ID is required')
    }

    const userRepo = AppDataSource.getRepository(User)
    const user = await userRepo.findOne({ 
      where: { id: userId },
      select: ['id', 'name', 'email', 'createdAt', 'updatedAt']
    })
    
    if (!user) {
      throw new APIError(404, 'User not found')
    }

    return res.json({
      status: 200,
      message: 'User retrieved successfully',
      data: {
        id: user.id,
        name: user.name,
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
    res.clearCookie('jwt', { path: cookieOptions.path, httpOnly: cookieOptions.httpOnly, secure: cookieOptions.secure, sameSite: cookieOptions.sameSite as any })

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