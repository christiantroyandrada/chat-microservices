import { body, ValidationChain } from 'express-validator'

export const publishPrekeyValidation: ValidationChain[] = [
  body('deviceId')
    .trim()
    .notEmpty()
    .withMessage('deviceId is required')
    .isLength({ max: 255 })
    .withMessage('deviceId must be at most 255 characters'),

  body('bundle')
    .notEmpty()
    .withMessage('bundle is required')
    .custom((val) => {
      if (typeof val !== 'object' || val === null) return false
      // Basic size guard: prevent storing extremely large bundles
      try {
        const size = JSON.stringify(val).length
        return size <= 20000 // ~20KB limit for bundle JSON
      } catch {
        return false
      }
    })
    .withMessage('bundle must be a JSON object and not exceed 20KB')
]
