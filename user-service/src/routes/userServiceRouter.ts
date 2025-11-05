import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import AuthController from '../controllers/AuthController'

const userServiceRouter = Router()

// Apply a strict rate limiter to auth endpoints to slow brute-force attacks
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 })

userServiceRouter.post('/register', authLimiter, AuthController.registration)
userServiceRouter.post('/login', authLimiter, AuthController.login)

export default userServiceRouter