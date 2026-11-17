import type { Message } from '../database/models/MessageModel'
import { logWarn } from '../utils/logger'

let active = 0

type Receipt = { userId: string; by: string } & (
  | { type: 'read' }
  | { type: 'delivered'; messageId: string }
)

export function relayAcceptedMessage(message: Message, senderUsername: string): Promise<void> {
  const { id, senderId, receiverId, status, createdAt, clientMessageId } = message
  return relay('messages', { id, senderId, receiverId, message: message.message, status, createdAt, clientMessageId, senderUsername })
}

export function relayReceipt(receipt: Receipt): Promise<void> {
  return relay('receipts', receipt)
}

async function relay(kind: 'messages' | 'receipts', payload: object): Promise<void> {
  const url = process.env.GO_WS_BRIDGE_URL
  const token = process.env.GO_WS_BRIDGE_TOKEN
  if (!url || !token || active >= 32) return

  active++
  try {
    const endpoint = kind === 'messages' ? url : new URL('receipts', url).href
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: AbortSignal.timeout(750),
    })
    await response.body?.cancel()
    if (!response.ok) logWarn('Go WebSocket relay rejected an event')
  } catch {
    logWarn('Go WebSocket relay could not forward an event')
  } finally {
    active--
  }
}
