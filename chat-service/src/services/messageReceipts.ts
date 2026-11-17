import { AppDataSource, Message } from '../database'
import { MessageStatus } from '../database/models/MessageModel'
import { relayReceipt } from './websocketRelay'

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
