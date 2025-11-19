import type { Request } from 'express'

export interface TokenPayload {
  id: string
  username: string
  email: string
  iat: number
  exp: number
}
// Used when decoding/verifying JWTs in auth middleware and controllers

export interface IUser {
  _id: string
  username: string
  email: string
  password: string
  createdAt: Date
  updatedAt: Date
}
// Represents the application user shape returned by the User service
// Used throughout controllers (e.g. MessageController) and middleware

export interface AuthenticatedRequest extends Request {
  user: IUser
}
// Extended Express Request injected by authentication middleware

// Row shape returned by the conversations raw SQL query in MessageController
export interface ConversationRow {
  userId: string
  lastMessageSenderId?: string
  lastMessage: string
  lastMessageTime: string
  unreadCount: number
}
// Row shape returned by the conversations raw SQL query in MessageController

// Notification payload sent to RabbitMQ queue
export interface NotificationPayload {
  type: 'MESSAGE_RECEIVED'
  userId: string
  message: string
  from: string
  fromName: string
  isEncrypted: boolean
  envelope?: string | object
}
// Notification payload published to RabbitMQ in `chat-service/src/services/RabbitMQService.ts`

// User details response from RabbitMQ user service
export interface UserDetails {
  id: string
  username: string
  email: string
}
// User details shape expected from the user-service over RPC (RabbitMQ)

// Callback type for getUserDetails
export type UserDetailsCallback = (user: UserDetails | null) => void
// Callback signature used by RabbitMQService.getUserDetails for async responses
