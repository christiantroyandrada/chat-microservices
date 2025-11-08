import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { User, IUser } from '../database'
import { APIError, encryptPassword, isPasswordMatch } from '../utils'
import config from '../config/config'

const JWT_SECRET = config.JWT_SECRET as string
const COOKIE_EXPIRATION_DAYS = 7

const getCookieOptions = () => {
  const expirationDate = new Date(
    Date.now() + COOKIE_EXPIRATION_DAYS * 24 * 60 * 60 * 1000
  )
  
  return {
    expires: expirationDate,
    secure: config.env === 'production', // HTTPS only in production
    httpOnly: true, // Prevent XSS attacks
    sameSite: 'strict' as const, // CSRF protection
    path: '/', // Cookie path
  }
}

type RegistrationBody = {
  name: string
  email: string
  password: string
}

const registration = async (
  req: Request<unknown, unknown, RegistrationBody>,
  res: Response,
  _next: NextFunction
) => {
  try {
    const { name, email, password } = req.body
    const userExists = await User.findOne({ email})
    if (userExists) {
      throw new APIError(400, 'User with this email already exists')
    }

    const user = await User.create({
      name,
      email,
      password: await encryptPassword(password),
    })

    const userData = {
      id: String(user._id),
      name: user.name,
      email: user.email,
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
  user: IUser,
  res: Response,
) => {
  // Ensure the token `id` is the MongoDB _id string for consistency
  const { name, email } = user as any
  const userId = String((user as any)._id ?? (user as any).id)

  const token = jwt.sign({ name, email, id: userId }, JWT_SECRET, {
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
    const user = await User.findOne({ email }).select('+password')
    const passwordMatches = await isPasswordMatch(password, user?.password as string)

    if ( !user || !passwordMatches ) {
      throw new APIError(401, 'Invalid email or password')
    }
    const token = await createSendToken(user!, res)

    return res.json({
      status: 200,
      message: 'Login successful',
      token,
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
    const user = await User.findById(req.user.id).select('-password')
    
    if (!user) {
      throw new APIError(404, 'User not found')
    }

    return res.json({
      status: 200,
      message: 'User retrieved successfully',
      data: {
        id: String(user._id),
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

    // Escape special regex characters to prevent ReDoS attacks
    const escapedQuery = q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escapedQuery, 'i')
    
    // Get current user ID from JWT token
    const currentUserId = req.user?.id

    // Search by name or email, excluding the current logged-in user
    const users = await User.find({
      $and: [
        { $or: [{ name: regex }, { email: regex }] },
        { _id: { $ne: currentUserId } } // Exclude current user
      ]
    })
      .select('-password')
      .limit(20)

    const mapped = users.map((u) => ({ _id: u._id, name: u.name, email: u.email }))

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

    const user = await User.findById(userId).select('-password')
    
    if (!user) {
      throw new APIError(404, 'User not found')
    }

    return res.json({
      status: 200,
      message: 'User retrieved successfully',
      data: {
        id: String(user._id),
        name: user.name,
        email: user.email,
      }
    })
  } catch (error: unknown) {
    next(error)
  }
}

export default {
  registration,
  login,
  getCurrentUser,
  search,
  getUserById,
}