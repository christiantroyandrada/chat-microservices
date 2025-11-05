import express, { Express } from 'express'
import mongoose from 'mongoose'
import helmet from 'helmet'
import mongoSanitize from 'express-mongo-sanitize'
import rateLimit from 'express-rate-limit'
import chatServiceRouter from './routes/messageRoutes'
import { errorMiddleware, errorHandler } from './middleware'

const app: Express = express()

app.set('trust proxy', 1)
app.use(helmet())
app.get('/health', async (req, res) => {
	try {
		const state = mongoose.connection.readyState
		if (state !== 1) {
			return res.status(503).json({ status: 'error', dbState: state })
		}
		if (mongoose.connection.db) {
			await mongoose.connection.db.admin().ping()
		}
		return res.status(200).json({ status: 'ok', db: 'ok' })
	} catch (err) {
		console.error('[chat-service] Health check error:', err)
		return res.status(503).json({ status: 'error', error: String(err) })
	}
})

// NOTE: MongoDB sanitization disabled due to express-mongo-sanitize incompatibility with Express 5.x

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: 'Too many requests from this IP, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
})
app.use(globalLimiter)
app.use(express.json({ limit: '100kb' }))
app.use(express.urlencoded({ extended: true, parameterLimit: 1000 }))

app.use(chatServiceRouter)
app.use(errorMiddleware)
app.use(errorHandler)

export default app