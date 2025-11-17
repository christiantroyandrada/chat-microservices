import type * as amqp from 'amqplib'
import type { CookieOptions as ExpressCookieOptions } from 'express'

export type RegistrationBody = {
  username: string
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
  username: string
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

// Complete Signal Protocol key set (including private keys)
// Used to backup and restore all Signal keys for a user
export interface SignalKeySet {
  identityKeyPair: {
    pubKey: string  // base64
    privKey: string // base64
  }
  registrationId: number
  signedPreKeyPair: {
    keyId: number
    keyPair: {
      pubKey: string
      privKey: string
    }
    signature: string
  }
  preKeys: Array<{
    keyId: number
    keyPair: {
      pubKey: string
      privKey: string
    }
  }>
}
// Complete key set that can be stored on backend and restored to IndexedDB

// Encrypted Signal Protocol key bundle for client-side encryption
// Keys are encrypted on the CLIENT before transmission - server never sees plaintext
export interface EncryptedKeyBundle {
  encrypted: string   // base64 encrypted data
  iv: string         // base64 initialization vector
  salt: string       // base64 salt for key derivation
  version: number    // encryption version for future-proofing
  deviceId: string   // device identifier for key isolation
}
// Used for secure key backup - server stores encrypted blobs only

// Cookie options type for clearCookie/cookie operations
export type CookieOptions = ExpressCookieOptions
// Re-exported/used by AuthController when setting/clearing cookies for login/logout
