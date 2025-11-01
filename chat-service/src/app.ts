import express, { Express } from 'express'
import chatServiceRouter from './routes/messageRoutes'
import { errorMiddleware, errorHandler } from './middleware'

const app: Express = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(chatServiceRouter)
app.use(errorMiddleware)
app.use(errorHandler)

export default app