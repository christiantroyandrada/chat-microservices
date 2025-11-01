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
    // do not auto-connect in constructor; server will initialize by calling connect()
  }

  async connect () {
    const connection = await amqp.connect(config.msgBrokerURL!)
    this.channel = await connection.createChannel()
    await this.consumeNotification()
  }

  async consumeNotification () {
    await this.channel.assertQueue(config.queue.notifications)
    this.channel.consume(config.queue.notifications, async (msg) => {
      if (!msg) return
      try {
        const {
          type,
          userId,
          message,
          userEmail,
          userToken,
          fromName,
        } = JSON.parse(msg.content.toString())

        if (type !== 'MESSAGE_RECEIVED') {
          this.channel.ack(msg)
          return
        }

        const online = this.userStatusStore.isUserOnline(userId)

        if (online && userToken) {
          await this.fcmService.sendPushNotification(userToken, message)
          this.channel.ack(msg)
          return
        }

        if (userEmail) {
          await this.emailService.sendEmail(
            userEmail,
            `New message from ${fromName}`,
            message,
          )
          this.channel.ack(msg)
          return
        }

        // nothing to do for this message, acknowledge to remove from queue
        this.channel.ack(msg)
      } catch (err) {
        console.error('[notification-service] consumeNotification error:', err)
        // avoid infinite requeues on failure — nack and drop the message
        try {
          this.channel.nack(msg, false, false)
        } catch (e) {
          console.error('[notification-service] failed to nack message:', e)
        }
      }
    })
  }
}

export const rabbitMQService = new RabbitMQService()