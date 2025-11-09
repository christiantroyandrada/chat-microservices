export interface JwtPayload {
  id: string
  email: string
  name: string
}

export interface AuthenticatedUser {
  _id: string
  email: string
  name: string
}

export interface AuthenticatedRequest extends Express.Request {
  user?: AuthenticatedUser
}
