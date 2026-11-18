import { rabbitMQService } from '../services/RabbitMQService'
import type { MessageReceivedEventPayload, NotificationPayload, UserDetails } from '../types'

export async function enrichMessageReceivedPayload(
  payload: MessageReceivedEventPayload,
): Promise<NotificationPayload> {
  const receiver = await new Promise<UserDetails>((resolve, reject) => {
    rabbitMQService.getUserDetails(payload.userId, user => {
      if (user) resolve(user)
      else reject(new Error('Recipient lookup failed'))
    }).catch(reject)
  })

  // Node does not own presence. Omit the advisory until authoritative data is available.
  return { ...payload, userEmail: receiver.email }
}
