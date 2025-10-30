import express, { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { User, IUser } from '../database'
import { APIError, encryptPassword, isPasswordMatch } from '../utils'
import config from '../config/config'

const JWT_SECRET = config.JWT_SECRET as string
const COOKIE_EXPIRATION_DAYS = 7
const expirationDate = new Date(
  Date.now() + COOKIE_EXPIRATION_DAYS * 24 * 60 * 60 * 1000
)

const cookieOptions = {
  expires: expirationDate,
  secure: false,
  httpOnly: true,
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
      id: user._id,
      name: user.name,
      email: user.email,
    }

    return res.json({
      status: 200,
      message: 'User registered successfully',
      data: userData,
    })
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Internal Server Error'

    return res.json({
      status: 500,
      message,
    })
  }
}

const createSendToken = async (
  user: IUser,
  res: Response,
) => {
  const { name, email, id } = user
  const token = jwt.sign({ name, email, id }, JWT_SECRET, {
    expiresIn: '1d',
  })
  if ( config.env === 'production' ) {
    cookieOptions.secure = true
  }
  res.cookie( 'jwt', token, cookieOptions )

  return token
}

const login = async (
  req: Request,
  res: Response,
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
    const message =
      error instanceof Error ? error.message : 'Internal Server Error'

    return res.json({
      status: 500,
      message,
    })
  }
}