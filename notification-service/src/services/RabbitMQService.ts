import amqp, { Channel } from 'amqplib'
import config from '../config/config'
import { FCMService } from './FCMService'
import { EmailService } from './EmailService'
import { UserStatusStore } from '../utils'

class RabbitMQService {
  private channel!: Channel
  private fcmService = FCMService
  private emailService = new EmailService()
  private userStatusStore = new UserStatusStore()

  constructor () {
    this.connect()
  }

  async connect () {
    const connection = await amqp.connect(config.msgBrokerURL!)
    this.channel = await connection.createChannel()
    await this.consumeNotification()
  }

  async consumeNotification () {
    await this.channel.assertQueue(config.queue.notifications)
    this.channel.consume(config.queue.notifications, async (msg) => {
      if (msg) {
        const {
          type,
          userId,
          message,
          userEmail,
          userToken,
          fromName,
        } = JSON.parse(msg.content.toString())

        if (type !== 'MESSAGE_RECEIVED') return
        const online = this.userStatusStore.isUserOnline(userId)

        if (online && userToken) {
          return this.fcmService.sendPushNotification(userToken, message)
        }

        if(userEmail) {
          return this.emailService.sendEmail(
            userEmail,
            `New message from ${fromName}`,
            message,
          )
        }
        this.channel.ack(msg)
      }
    })
  }
}

export const rabbitMQService = new RabbitMQService()