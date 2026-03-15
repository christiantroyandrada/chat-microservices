import { body, param, ValidationChain } from 'express-validator'

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
]

export const fetchConversationValidation: ValidationChain[] = [
  param('receiverId')
    .trim()
    .notEmpty()
    .withMessage('Receiver ID is required')
    .isUUID()
    .withMessage('Receiver ID must be a valid UUID')
]

export const markAsReadValidation: ValidationChain[] = [
  param('senderId')
    .trim()
    .notEmpty()
    .withMessage('Sender ID is required')
    .isUUID()
    .withMessage('Sender ID must be a valid UUID')
]
