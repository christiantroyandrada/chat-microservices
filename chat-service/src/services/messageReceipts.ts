import { AppDataSource, Message } from '../database'
import { MessageStatus } from '../database/models/MessageModel'
import { relayReceipt } from './websocketRelay'

export async function markMessageDelivered(messageId: string, receiverId: string) {
  const repository = AppDataSource.getRepository(Message)
  const existing = await repository.findOne({ where: { id: messageId, receiverId } })
  if (!existing || existing.receiverId !== receiverId) return null

  let changed = false
  if (existing.status === MessageStatus.NotDelivered) {
    const result = await repository.update(
      { id: messageId, receiverId, status: MessageStatus.NotDelivered },
      { status: MessageStatus.Delivered },
    )
    changed = (result.affected ?? 0) > 0
    if (changed) {
      void relayReceipt({ type: 'delivered', userId: existing.senderId, by: receiverId, messageId })
    }
  }
  return { senderId: existing.senderId, changed }
}

export async function markConversationSeen(senderId: string, receiverId: string): Promise<number> {
  const result = await AppDataSource.getRepository(Message)
    .createQueryBuilder()
    .update(Message)
    .set({ status: MessageStatus.Seen })
    .where('senderId = :senderId', { senderId })
    .andWhere('receiverId = :receiverId', { receiverId })
    .andWhere('status != :status', { status: MessageStatus.Seen })
    .execute()

  const count = result.affected ?? 0
  if (count > 0) void relayReceipt({ type: 'read', userId: senderId, by: receiverId })
  return count
}
