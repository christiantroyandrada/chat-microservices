import type { Message } from '../database/models/MessageModel'
import { logWarn } from '../utils/logger'

let active = 0

export async function relayAcceptedMessage(message: Message): Promise<void> {
  const url = process.env.GO_WS_BRIDGE_URL
  const token = process.env.GO_WS_BRIDGE_TOKEN
  if (!url || !token || active >= 32) return

  active++
  try {
    const { id, senderId, receiverId, status, createdAt, clientMessageId } = message
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id, senderId, receiverId, message: message.message, status, createdAt, clientMessageId }),
      redirect: 'error',
      signal: AbortSignal.timeout(750),
    })
    await response.body?.cancel()
    if (!response.ok) logWarn('Go WebSocket relay rejected an accepted message')
  } catch {
    logWarn('Go WebSocket relay could not forward an accepted message')
  } finally {
    active--
  }
}
