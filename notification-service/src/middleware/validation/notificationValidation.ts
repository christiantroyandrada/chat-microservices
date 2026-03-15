import { body, param, ValidationChain } from 'express-validator'

export const markAsReadValidation: ValidationChain[] = [
  param('notificationId')
    .trim()
    .notEmpty()
    .withMessage('Notification ID is required')
    .isUUID()
    .withMessage('Notification ID must be a valid UUID')
]

export const deleteNotificationValidation: ValidationChain[] = [
  param('notificationId')
    .trim()
    .notEmpty()
    .withMessage('Notification ID is required')
    .isUUID()
    .withMessage('Notification ID must be a valid UUID')
]

export const createNotificationValidation: ValidationChain[] = [
  body('userId')
    .trim()
    .notEmpty()
    .withMessage('User ID is required')
    .isUUID()
    .withMessage('User ID must be a valid UUID'),

  body('type')
    .trim()
    .notEmpty()
    .withMessage('Notification type is required')
    .isString()
    .withMessage('Notification type must be a string')
    .isIn(['message', 'system', 'alert'])
    .withMessage('Notification type must be: message, system, or alert'),

  body('title')
    .trim()
    .notEmpty()
    .withMessage('Title is required')
    .isString()
    .withMessage('Title must be a string')
    .isLength({ max: 255 })
    .withMessage('Title exceeds maximum length of 255 characters'),

  body('message')
    .notEmpty()
    .withMessage('Message is required')
    .isString()
    .withMessage('Message must be a string')
    .isLength({ max: 5000 })
    .withMessage('Message exceeds maximum length of 5000 characters')
]
