import * as amqp from 'amqplib'
import config from '../config/config'
import { User } from '../database'
import { APIError } from '../utils'

type AmqpConnectionLike = {
  createChannel: () => Promise<amqp.Channel>
  close?: () => Promise<void>
}

const getUserDetails = async (userId:string) => {
  const userDetails = await User.findById(userId).select('-password')
  if (!userDetails) {
    throw new APIError(404, 'User not found')
  }
  return userDetails
}

class RabbitMQService {
  private requestQueue = "USER_DETAILS_REQUEST"
  private responseQueue = "USER_DETAILS_RESPONSE"
  private connection!: AmqpConnectionLike
  private channel!: amqp.Channel

  constructor () {
    // do not auto-connect in constructor; server bootstrap will call connect()
  }

  async connect () {
    // Initiate connection to RabbitMQ Server
    // The amqplib type definitions sometimes cause the returned
    // value to be interpreted as a different model; cast explicitly
    // to the Connection type that has createChannel.
    this.connection = (await amqp.connect(config.msgBrokerURL!)) as unknown as AmqpConnectionLike
    this.channel = await this.connection.createChannel()

    // assert queue that it exists
    await this.channel.assertQueue(this.requestQueue)
    await this.channel.assertQueue(this.responseQueue)

    // start listening
    this.listenForRequests()
  }

  private async listenForRequests () {
    this.channel.consume(this.requestQueue, async (msg) => {
        if (msg !== null) {
          try {
            const { userId } = JSON.parse(msg.content.toString())
            const userDetails = await User.findById(userId).select('-password')
            
            // Reply with user details
            this.channel.sendToQueue(
              msg.properties.replyTo,
              Buffer.from(JSON.stringify(userDetails)),
              { correlationId: msg.properties.correlationId }
            )
          } catch (parseError) {
            console.error('[user-service] RabbitMQ message parse error:', parseError)
            // Send error response
            this.channel.sendToQueue(
              msg.properties.replyTo,
              Buffer.from(JSON.stringify({ error: 'Invalid message format' })),
              { correlationId: msg.properties.correlationId }
            )
          } finally {
            this.channel.ack(msg)
          }
        }
      })
  }
}

export const rabbitMQService = new RabbitMQService()