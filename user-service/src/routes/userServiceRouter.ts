import { Router } from 'express'
import AuthController from '../controllers/AuthController'

const userServiceRouter = Router()

userServiceRouter.post('/register', AuthController.registration)
userServiceRouter.post('/login', AuthController.login)

export default userServiceRouter