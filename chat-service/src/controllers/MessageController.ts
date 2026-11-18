import { Response, Request, NextFunction } from 'express'
import { LRUCache } from 'lru-cache'
import type { ConversationRow, UserDetails } from '../types'
import { AuthenticatedRequest } from '../middleware'
import { parseConversationPagination } from '../middleware/validation/messageValidation'
import { Message, AppDataSource } from '../database'
import { APIError } from '../utils'
import { MessageSubmissionService } from '../services/MessageSubmissionService'
import { relayAcceptedMessage } from '../services/websocketRelay'
import { canonicalUserId, UUID } from '../utils/messageIdentity'
import { logWarn, logError } from '../utils/logger'
import { markConversationSeen, markMessageDelivered } from '../services/messageReceipts'
import { chatMessagesSentTotal, chatMessagesReadTotal } from '../utils/metrics'
import { rabbitMQService } from '../services/RabbitMQService'

// Cache only profile names, never the caller's credentials or contact details.
const USER_CACHE_TTL_MS = 60_000; // 1 minute TTL
type CachedUserDetail = { data: { username?: string } | null };
const userDetailCache = new LRUCache<string, CachedUserDetail>({
  max: 500,
  ttl: USER_CACHE_TTL_MS,
});
const messageSubmission = new MessageSubmissionService()

const validateExpectedIdentity = (expectedId: unknown, authenticatedId: string, subject: 'user' | 'sender' = 'user') => {
  if (expectedId === undefined) return;
  if (typeof expectedId !== 'string' || !UUID.test(expectedId)) {
    throw new APIError(400, `Expected ${subject} ID must be a valid UUID`);
  }
  if (canonicalUserId(expectedId) !== canonicalUserId(authenticatedId)) {
    throw new APIError(403, `Expected ${subject} does not match authenticated user`);
  }
};

/** Clear the user detail cache — exposed for testing */
export const clearUserDetailCache = () => userDetailCache.clear();

const fetchUserDetails = async (
  userId: string,
): Promise<{ username?: string } | null> => {
  // LRU cache handles TTL expiration automatically
  const cached = userDetailCache.get(userId);
  if (cached !== undefined) {
    return cached.data;
  }

  try {
    const user = await new Promise<UserDetails | null>((resolve, reject) => {
      rabbitMQService.getUserDetails(userId, resolve).catch(reject);
    });
    if (!user || typeof user.username !== 'string' || !user.username.trim()) return null;
    const result = { username: user.username };
    userDetailCache.set(userId, { data: result });

    return result;
  } catch (error) {
    logError(`Error fetching user ${userId}:`, error);
    return null;
  }
};

/**
 * Batch-fetch user details for multiple user IDs.
 * Checks cache first, then fetches missing ones in parallel.
 */
const fetchUserDetailsBatch = async (
  userIds: string[],
): Promise<Map<string, { username?: string } | null>> => {
  const results = new Map<string, { username?: string } | null>();
  const uncached: string[] = [];

  for (const id of userIds) {
    const cached = userDetailCache.get(id);
    if (cached !== undefined) {
      results.set(id, cached.data);
    } else {
      uncached.push(id);
    }
  }

  // Fetch all uncached in parallel
  if (uncached.length > 0) {
    const fetched = await Promise.all(
      uncached.map((id) => fetchUserDetails(id)),
    );
    uncached.forEach((id, idx) => results.set(id, fetched[idx]));
  }

  return results;
};

const sendMessage = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { receiverId, message, clientMessageId, expectedSenderId } = req.body;
    const { _id, email, username } = req.user;

    validateExpectedIdentity(expectedSenderId, _id, 'sender');

    validateReceiver(_id, receiverId);

    // Validate message content - enforce end-to-end encrypted envelope
    if (!message || typeof message !== "string") {
      throw new APIError(400, "Invalid message content");
    }

    const trimmedMessage = message.trim();
    if (trimmedMessage.length === 0) {
      throw new APIError(400, "Message cannot be empty");
    }

    if (trimmedMessage.length > 5000) {
      throw new APIError(
        400,
        "Message exceeds maximum length of 5000 characters",
      );
    }

    // Expect the client to send a Signal-style encrypted envelope encoded as JSON:
    // { __encrypted: true, type: number, body: <base64-string> }
    let parsedEnvelope: unknown = null;
    try {
      parsedEnvelope = JSON.parse(trimmedMessage);
    } catch (e) {
      logWarn("Failed to parse encrypted message envelope");
      throw new APIError(
        400,
        "Messages must be end-to-end encrypted (invalid envelope)",
      );
    }

    const envelopeCandidate = parsedEnvelope as {
      __encrypted?: boolean;
      body?: unknown;
    } | null;
    if (
      envelopeCandidate?.__encrypted !== true ||
      typeof envelopeCandidate?.body !== "string"
    ) {
      throw new APIError(400, "Messages must be end-to-end encrypted");
    }

    const { message: newMessage, replayed } = await messageSubmission.submit({
      senderId: _id,
      receiverId,
      encryptedEnvelope: message,
      clientMessageId,
      senderName: username,
      senderEmail: email,
    });
    if (!replayed) chatMessagesSentTotal.inc({ channel: "rest" });

    const response = res.json({
      status: 200,
      message: "Message sent successfully",
      data: newMessage,
    });
    if (!replayed) void relayAcceptedMessage(newMessage, username);
    return response;
  } catch (error: unknown) {
    next(error);
  }
};

const validateReceiver = (senderId: string, receiverId: string) => {
  if (!receiverId) {
    throw new APIError(404, "Receiver ID is required");
  }
  if (canonicalUserId(senderId) === canonicalUserId(receiverId)) {
    throw new APIError(400, "Sender and receiver cannot be the same user");
  }
};

const fetchConversation = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    validateExpectedIdentity(req.query?.expectedUserId, req.user._id);
    const receiverId = typeof req.params.receiverId === 'string' ? canonicalUserId(req.params.receiverId) : req.params.receiverId;
    const senderId = canonicalUserId(req.user._id);

    // Keep controller parsing aligned with route validation so bypassed middleware
    // cannot pass Infinity or unsafe values into TypeORM's skip/take methods.
    let limit: number
    let offset: number
    try {
      ({ limit, offset } = parseConversationPagination(req.query))
    } catch (error) {
      throw new APIError(400, error instanceof Error ? error.message : 'Invalid pagination parameters')
    }
    
    const messageRepo = AppDataSource.getRepository(Message)
    const [messages, total] = await messageRepo
      .createQueryBuilder("message")
      .where(
        "(message.senderId = :senderId AND message.receiverId = :receiverId) OR (message.senderId = :receiverId AND message.receiverId = :senderId)",
        { senderId, receiverId },
      )
      .orderBy("message.createdAt", "DESC") // newest first for pagination
      .skip(offset)
      .take(limit)
      .getManyAndCount();

    messages.reverse();

    return res.json({
      status: 200,
      message: "Conversation fetched successfully",
      data: messages,
      pagination: { total, limit, offset, hasMore: offset + limit < total },
    });
  } catch (error: unknown) {
    next(error);
  }
};

const getConversations = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    validateExpectedIdentity(req.query?.expectedUserId, req.user._id);
    const userId = canonicalUserId(req.user._id);

    const messageRepo = AppDataSource.getRepository(Message);

    // Get all unique conversation partners with their last messages using SQL.
    // Uses UNION ALL instead of OR to let Postgres use individual B-tree indexes
    // on senderId and receiverId instead of a bitmap union scan.
    const conversationsRaw = await messageRepo.query(
      `
      WITH all_messages AS (
        SELECT "receiverId" as "userId",
               "senderId" as "lastMessageSenderId",
               message as "lastMessage",
               "createdAt" as "lastMessageTime"
        FROM messages
        WHERE "senderId" = $1
        UNION ALL
        SELECT "senderId" as "userId",
               "senderId" as "lastMessageSenderId",
               message as "lastMessage",
               "createdAt" as "lastMessageTime"
        FROM messages
        WHERE "receiverId" = $1
      ),
      ranked_messages AS (
        SELECT
          "userId",
          "lastMessageSenderId",
          "lastMessage",
          "lastMessageTime",
          ROW_NUMBER() OVER (
            PARTITION BY "userId"
            ORDER BY "lastMessageTime" DESC
          ) as rn
        FROM all_messages
      ),
      unread_counts AS (
        SELECT 
          "senderId" as "userId",
          COUNT(*)::integer as "unreadCount"
        FROM messages
        WHERE "receiverId" = $1 AND status != 'Seen'
        GROUP BY "senderId"
      )
      SELECT 
        rm."userId",
        rm."lastMessageSenderId",
        rm."lastMessage",
        rm."lastMessageTime",
        COALESCE(uc."unreadCount", 0)::integer as "unreadCount"
      FROM ranked_messages rm
      LEFT JOIN unread_counts uc ON rm."userId" = uc."userId"
      WHERE rm.rn = 1
      ORDER BY rm."lastMessageTime" DESC
    `,
      [userId],
    );

    const conversationsArray = Array.isArray(conversationsRaw)
      ? conversationsRaw
      : conversationsRaw
        ? [conversationsRaw]
        : [];

    const userIds = (conversationsArray as ConversationRow[]).map(
      (c) => c.userId,
    );
    const userDetailsMap = await fetchUserDetailsBatch(userIds);

    const conversations = (conversationsArray as ConversationRow[]).map((conv) => {
      const userDetails = userDetailsMap.get(conv.userId)
      return {
        // Keep legacy fields during the client rollout; the published contract
        // below supplies the canonical conversation shape.
        ...conv,
        username: userDetails?.username || 'Unknown User',
        id: conv.userId,
        name: userDetails?.username || 'Unknown User',
        avatar: null,
        lastMessage: conv.lastMessage,
        unreadCount: conv.unreadCount,
        lastMessageTime: conv.lastMessageTime,
      }
    })

    return res.json({
      status: 200,
      message: 'Conversations fetched successfully',
      data: conversations,
    })
  } catch (error: unknown) {
    next(error);
  }
};

const markAsRead = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    validateExpectedIdentity(req.query?.expectedUserId, req.user._id);
    const { senderId: requestedSenderId } = req.params;
    const receiverId = canonicalUserId(req.user._id);

    if (typeof requestedSenderId !== 'string' || !requestedSenderId) {
      throw new APIError(400, "Sender ID is required");
    }
    const modifiedCount = await markConversationSeen(canonicalUserId(requestedSenderId), receiverId);

    chatMessagesReadTotal.inc();

    return res.json({
      status: 200,
      message: "Messages marked as read",
      data: {
        modifiedCount,
      },
    });
  } catch (error: unknown) {
    next(error);
  }
};

const acknowledgeDelivery = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    if (req.query?.expectedUserId === undefined) throw new APIError(400, 'Expected user ID is required')
    validateExpectedIdentity(req.query.expectedUserId, req.user._id)
    const { messageId } = req.params
    if (typeof messageId !== 'string' || !UUID.test(messageId)) {
      throw new APIError(400, 'Message ID must be a valid UUID')
    }
    const id = canonicalUserId(messageId)
    const receiverId = canonicalUserId(req.user._id)
    const result = await markMessageDelivered(id, receiverId)
    if (!result) throw new APIError(404, 'Message not found')
    return res.json({
      status: 200,
      message: 'Delivery acknowledged',
      data: { modifiedCount: Number(result.changed) },
    })
  } catch (error) {
    next(error)
  }
}

export default {
  acknowledgeDelivery,
  sendMessage,
  fetchConversation,
  getConversations,
  markAsRead,
};

// Also provide named exports to support CommonJS `require()` consumers in tests
export { sendMessage, fetchConversation, getConversations, markAsRead };
