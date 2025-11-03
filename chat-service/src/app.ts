import express, { Express } from 'express'
import mongoose from 'mongoose'
import chatServiceRouter from './routes/messageRoutes'
import { errorMiddleware, errorHandler } from './middleware'

const app: Express = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
// Health check endpoint for Docker and monitoring (includes DB readiness)
app.get('/health', async (_req, res) => {
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
		return res.status(503).json({ status: 'error', error: String(err) })
	}
})
app.use(chatServiceRouter)
app.use(errorMiddleware)
app.use(errorHandler)

export default app