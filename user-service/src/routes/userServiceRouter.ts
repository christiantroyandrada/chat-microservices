import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import AuthController from '../controllers/AuthController'
import { registrationValidation, loginValidation } from '../middleware/validation/authValidation'
import { validateRequest } from '../middleware/validation/validateRequest'

const userServiceRouter = Router()

const authLimiter = rateLimit({ 
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many authentication attempts, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
})

userServiceRouter.post(
  '/register',
  authLimiter,
  ...registrationValidation,
  validateRequest,
  AuthController.registration
)

userServiceRouter.post(
  '/login',
  authLimiter,
  ...loginValidation,
  validateRequest,
  AuthController.login
)

export default userServiceRouter