import type { Request } from 'express'

export interface TokenPayload {
  id: string
  name: string
  email: string
  iat: number
  exp: number
}

export interface IUser {
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
