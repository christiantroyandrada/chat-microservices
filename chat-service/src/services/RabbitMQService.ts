import amqp, { Channel } from 'amqplib'
import { v4 as uuid_v4 } from 'uuid'
import config from '../config/config'

class RabbitMQService {
  private requestQueue = 'USER_DETAILS_REQUEST'
  private responseQueue = 'USER_DETAILS_RESPONSE'
  private correlationMap = new Map()
  private channel!: Channel

  constructor () {
    this.connect()
  }

  async connect () {
    const connection = await amqp.connect(config.msgBrokerURL!)
    this.channel = await connection.createChannel()
    await this.channel.assertQueue(this.requestQueue)
    await this.channel.assertQueue(this.responseQueue)

    this.channel.consume(this.responseQueue, (msg) => {
      if (msg) {
        const correlationId = msg.properties.correlationId
        const user = JSON.parse(msg.content.toString())

        const callback = this.correlationMap.get(correlationId)
        if (callback) {
          callback(user)
          this.correlationMap.delete(correlationId)
        }
      }
    }, { noAck: true })
  }

  async getUserDetails (userId:string, callback: Function) {
    const correlationId = uuid_v4()
    this.correlationMap.set(correlationId, callback)
    this.channel.sendToQueue(
      this.requestQueue,
      Buffer.from(JSON.stringify({ userId })),
      { correlationId }
    )
  }

  async notifyReceiver (
    receiverId: string,
    messageContent: string,
    senderEmail: string,
    senderName: string,
  ) {
    await this.getUserDetails(receiverId, async (user: any) => {
      const notificationPayload = {
        type: 'MESSAGE_RECEIVED',
        userId: receiverId,
        userEmail: user.email,
        message: messageContent,
        from: senderEmail,
        fromName: senderName,
      }

      try {
        await this.channel.assertQueue(config.queue.notifications)
        this.channel.sendToQueue(
          config.queue.notifications,
          Buffer.from(JSON.stringify(notificationPayload)),
        )
      } catch (error) {
        console.error(error)
      }
    })
  }
}

export const rabbitMQService = new RabbitMQService()