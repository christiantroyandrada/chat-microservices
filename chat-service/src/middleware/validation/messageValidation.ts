import { body, param, query, ValidationChain } from 'express-validator'

const CHAT_PAGINATION = {
  limit: { defaultValue: 50, min: 1, max: 200 },
  offset: { defaultValue: 0, min: 0, max: Number.MAX_SAFE_INTEGER },
} as const

type PaginationField = keyof typeof CHAT_PAGINATION
type PaginationQuery = Partial<Record<PaginationField, unknown>>

function parseBoundedSafeInteger(field: PaginationField, value: unknown): number {
  const { min, max } = CHAT_PAGINATION[field]
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value)
      ? Number(value)
      : Number.NaN

  if (!Number.isSafeInteger(numeric) || numeric < min || numeric > max) {
    throw new Error(`${field} must be a safe integer between ${min} and ${max}`)
  }

  return numeric
}

export function parseConversationPagination(queryValues: PaginationQuery): {
  limit: number
  offset: number
} {
  return {
    limit: queryValues.limit === undefined
      ? CHAT_PAGINATION.limit.defaultValue
      : parseBoundedSafeInteger('limit', queryValues.limit),
    offset: queryValues.offset === undefined
      ? CHAT_PAGINATION.offset.defaultValue
      : parseBoundedSafeInteger('offset', queryValues.offset),
  }
}

export const sendMessageValidation: ValidationChain[] = [
  body('receiverId')
    .trim()
    .notEmpty()
    .withMessage('Receiver ID is required')
    .isUUID()
    .withMessage('Receiver ID must be a valid UUID'),

  body('message')
    .notEmpty()
    .withMessage('Message is required')
    .isString()
    .withMessage('Message must be a string')
    .isLength({ max: 5000 })
    .withMessage('Message exceeds maximum length of 5000 characters')
]

export const fetchConversationValidation: ValidationChain[] = [
  param('receiverId')
    .trim()
    .notEmpty()
    .withMessage('Receiver ID is required')
    .isUUID()
    .withMessage('Receiver ID must be a valid UUID'),
  query('limit').optional().custom((value) => {
    parseBoundedSafeInteger('limit', value)
    return true
  }),
  query('offset').optional().custom((value) => {
    parseBoundedSafeInteger('offset', value)
    return true
  })
]

export const markAsReadValidation: ValidationChain[] = [
  param('senderId')
    .trim()
    .notEmpty()
    .withMessage('Sender ID is required')
    .isUUID()
    .withMessage('Sender ID must be a valid UUID')
]
