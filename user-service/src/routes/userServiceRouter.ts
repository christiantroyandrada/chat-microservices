import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import AuthController from '../controllers/AuthController'
import PrekeyController from '../controllers/PrekeyController'
import { publishPrekeyValidation } from '../middleware/validation/prekeyValidation'
import { registrationValidation, loginValidation } from '../middleware/validation/authValidation'
import { validateRequest } from '../middleware/validation/validateRequest'
import { authenticated } from '../middleware/auth'

const userServiceRouter = Router()

const authLimiter = rateLimit({ 
  windowMs: 15 * 60 * 1000,
  max: 100, // Increased from 10 to 100 for development/testing
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

userServiceRouter.get(
  '/me',
  authenticated,
  AuthController.getCurrentUser
)

userServiceRouter.post(
  '/logout',
  AuthController.logout
)

// Publish a prekey bundle for a user/device (used by clients to publish Signal prekeys)
// Publish prekey: require authentication so clients cannot spoof another user's bundle
// Rate limiters for prekey endpoints
const prekeyPostLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // max 10 publishes per minute per IP (should be fine for device registration)
  message: 'Too many prekey publish requests, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
})

const prekeyGetLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60, // max 60 GETs per minute per IP
  message: 'Too many prekey requests, please slow down',
  standardHeaders: true,
  legacyHeaders: false,
})

// Publish prekey: authenticated + validation + rate limit
userServiceRouter.post('/prekeys', prekeyPostLimiter, authenticated, publishPrekeyValidation, validateRequest, PrekeyController.publishPrekey)

// Get a prekey bundle for a user (consumes a one-time prekey when available)
// Get prekey bundle (public) - consumption is handled atomically in the controller
// Get prekey bundle (public) - consumption is handled atomically in the controller
userServiceRouter.get('/prekeys/:userId', prekeyGetLimiter, PrekeyController.getPrekeyBundle)

// Store complete Signal key set (authenticated) - uses /user prefix like other auth routes
userServiceRouter.post('/signal-keys', prekeyPostLimiter, authenticated, PrekeyController.storeSignalKeys)

// Get stored Signal key set (authenticated) - uses /user prefix like other auth routes
userServiceRouter.get('/signal-keys', prekeyGetLimiter, authenticated, PrekeyController.getSignalKeys)

// Search users (used by frontend for starting new conversations)
userServiceRouter.get(
  '/search',
  authenticated,
  AuthController.search
)

// Get user by ID (used by chat service to fetch usernames)
userServiceRouter.get(
  '/users/:userId',
  AuthController.getUserById
)

export default userServiceRouter