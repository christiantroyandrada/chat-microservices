import type * as amqp from 'amqplib'
import type { CookieOptions as ExpressCookieOptions } from 'express'

export type RegistrationBody = {
  name: string
  email: string
  password: string
}
// Shape used by registration controller endpoints (req.body)

export type AmqpConnectionLike = {
  createChannel: () => Promise<amqp.Channel>
  close?: () => Promise<void>
}
// Light-weight abstraction used for tests or bootstrap code that accepts AMQP-like connections

export interface JwtPayload {
  id: string
  email: string
  name: string
}
// JWT payload shape used when issuing/verifying tokens in AuthController

export type AuthenticatedRequestUser = JwtPayload

// Prekey bundle shape stored in the database
export interface PrekeyBundle {
  identityKey: string
  registrationId: number
  signedPreKey: {
    id: number
    publicKey: string
    signature: string
  }
  preKeys: Array<{
    id: number
    publicKey: string
  }>
}
// Stored in `prekeys` table and used by `PrekeyController` and other Signal helpers

// Cookie options type for clearCookie/cookie operations
export type CookieOptions = ExpressCookieOptions
// Re-exported/used by AuthController when setting/clearing cookies for login/logout
