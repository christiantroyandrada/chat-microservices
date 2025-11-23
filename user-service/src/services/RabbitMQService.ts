import amqp, { Channel } from 'amqplib'
import config from '../config/config'
import { User, AppDataSource } from '../database'
import { APIError } from '../utils'
import { logError } from '../utils/logger'


const getUserDetails = async (userId:string) => {
  const userRepo = AppDataSource.getRepository(User)
  const userDetails = await userRepo.findOne({ 
    where: { id: userId },
    select: ['id', 'username', 'email', 'createdAt', 'updatedAt']
  })
  if (!userDetails) {
    throw new APIError(404, 'User not found')
  }
  return userDetails
}

class RabbitMQService {
  private readonly requestQueue = "USER_DETAILS_REQUEST"
  private readonly responseQueue = "USER_DETAILS_RESPONSE"
  private channel!: Channel

  async connect () {
    // Initiate connection to RabbitMQ Server
    // Ensure the broker URL is present at runtime and narrow its type for TS.
    const brokerUrl = config.msgBrokerURL
    if (!brokerUrl) {
      logError('[chat-service] MESSAGE_BROKER_URL is not configured')
      throw new Error('Missing MESSAGE_BROKER_URL')
    }

    const connection = await amqp.connect(brokerUrl)
    this.channel = await connection.createChannel()
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
            const userRepo = AppDataSource.getRepository(User)
            const userDetails = await userRepo.findOne({ 
              where: { id: userId },
              select: ['id', 'username', 'email', 'createdAt', 'updatedAt']
            })
            
            // Reply with user details
            this.channel.sendToQueue(
              msg.properties.replyTo,
              Buffer.from(JSON.stringify(userDetails)),
              { correlationId: msg.properties.correlationId }
            )
          } catch (parseError) {
            logError('[user-service] RabbitMQ message parse error:', parseError)
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