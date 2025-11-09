import type * as amqp from 'amqplib'

export type RegistrationBody = {
  name: string
  email: string
  password: string
}

export type AmqpConnectionLike = {
  createChannel: () => Promise<amqp.Channel>
  close?: () => Promise<void>
}

export interface JwtPayload {
  id: string
  email: string
  name: string
}

export type AuthenticatedRequestUser = JwtPayload
