import { randomUUID } from 'node:crypto'
import type { DataSource, EntityManager } from 'typeorm'
import { AppDataSource } from '../database/connection'
import { Message, MessageStatus } from '../database/models/MessageModel'
import { OutboxEvent } from '../database/models/OutboxEventModel'
import type { MessageReceivedEventPayload } from '../types'
import { APIError } from '../utils/apiError'

export interface SubmitMessageCommand {
  senderId: string
  receiverId: string
  encryptedEnvelope: string
  clientMessageId?: string
  senderName: string
  senderEmail: string
}

export interface SubmitMessageResult {
  message: Message
  replayed: boolean
}

type ValidatedCommand = SubmitMessageCommand & {
  clientMessageId?: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function validate(command: SubmitMessageCommand): ValidatedCommand {
  if (
    typeof command.senderId !== 'string' ||
    typeof command.receiverId !== 'string' ||
    typeof command.senderName !== 'string' ||
    typeof command.senderEmail !== 'string'
  ) throw new APIError(400, 'Invalid message sender or receiver')

  const senderId = command.senderId.trim()
  const receiverId = command.receiverId.trim()
  if (!senderId || !receiverId || senderId === receiverId) {
    throw new APIError(400, 'Invalid message sender or receiver')
  }

  if (typeof command.encryptedEnvelope !== 'string') {
    throw new APIError(400, 'Invalid message content')
  }
  const encryptedEnvelope = command.encryptedEnvelope.trim()
  if (!encryptedEnvelope || encryptedEnvelope.length > 5000) {
    throw new APIError(400, 'Message must be between 1 and 5000 characters')
  }

  let envelope: unknown
  try {
    envelope = JSON.parse(encryptedEnvelope)
  } catch {
    throw new APIError(400, 'Messages must be end-to-end encrypted (invalid envelope)')
  }
  const candidate = envelope as { __encrypted?: unknown; body?: unknown } | null
  if (candidate?.__encrypted !== true || typeof candidate.body !== 'string') {
    throw new APIError(400, 'Messages must be end-to-end encrypted')
  }

  let clientMessageId: string | undefined
  if (command.clientMessageId !== undefined) {
    if (typeof command.clientMessageId !== 'string' || !UUID.test(command.clientMessageId)) {
      throw new APIError(400, 'Client message ID must be a valid UUID')
    }
    clientMessageId = command.clientMessageId.toLowerCase()
  }

  return { ...command, senderId, receiverId, encryptedEnvelope, clientMessageId }
}

export class MessageSubmissionService {
  constructor(private readonly dataSource: DataSource = AppDataSource) {}

  async submit(command: SubmitMessageCommand): Promise<SubmitMessageResult> {
    const value = validate(command)

    return this.dataSource.transaction(async manager => {
      const messageRepo = manager.getRepository(Message)
      let message: Message

      if (value.clientMessageId) {
        const insertion = await manager.createQueryBuilder()
          .insert()
          .into(Message)
          .values({
            senderId: value.senderId,
            receiverId: value.receiverId,
            message: value.encryptedEnvelope,
            clientMessageId: value.clientMessageId,
            isEncrypted: true,
            status: MessageStatus.NotDelivered,
          })
          .orIgnore()
          .returning(['id'])
          .execute()
        const insertedId = insertion.raw[0]?.id as string | undefined

        if (!insertedId) {
          const existing = await messageRepo.findOneByOrFail({
            senderId: value.senderId,
            clientMessageId: value.clientMessageId,
          })
          if (existing.receiverId !== value.receiverId || existing.message !== value.encryptedEnvelope) {
            throw new APIError(409, 'Client message ID already belongs to a different message')
          }
          return { message: existing, replayed: true }
        }

        message = await messageRepo.findOneByOrFail({ id: insertedId })
      } else {
        message = await messageRepo.save(messageRepo.create({
          senderId: value.senderId,
          receiverId: value.receiverId,
          message: value.encryptedEnvelope,
          clientMessageId: null,
          isEncrypted: true,
          status: MessageStatus.NotDelivered,
        }))
      }

      await this.saveEvent(manager, message, value)
      return { message, replayed: false }
    })
  }

  private async saveEvent(manager: EntityManager, message: Message, command: ValidatedCommand): Promise<void> {
    const id = randomUUID()
    const payload: MessageReceivedEventPayload = {
      type: 'MESSAGE_RECEIVED',
      eventId: id,
      senderId: message.senderId,
      userId: message.receiverId,
      message: '[Encrypted message]',
      from: command.senderEmail,
      fromName: command.senderName,
      isEncrypted: true,
      envelope: message.message,
    }
    await manager.getRepository(OutboxEvent).insert({ id, payload })
  }
}
