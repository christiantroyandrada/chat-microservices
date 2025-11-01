import express from 'express'
import proxy from 'express-http-proxy'
import { URL } from 'url'

const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// proxy options to forward parsed JSON bodies from the gateway to the target service
const proxyOptions = {
  proxyReqOptDecorator: (proxyReqOpts: any, srcReq: any) => {
    // ensure content-type is forwarded
    proxyReqOpts.headers['Content-Type'] = srcReq.headers['content-type'] || 'application/json'
    return proxyReqOpts
  },
  proxyReqPathResolver: (req: any) => {
    // forward the original path and querystring
    const urlObj = new URL(req.url, `http://${req.headers.host}`)
    return urlObj.pathname + urlObj.search
  },
  proxyReqBodyDecorator: (bodyContent: any, srcReq: any) => {
    // express.json() parsed body will be available here as an object.
    // Return a stringified body to be sent to the proxied service.
    if (!bodyContent || Object.keys(bodyContent).length === 0) {
      return ''
    }
    return JSON.stringify(bodyContent)
  }
}

const auth = proxy('http://localhost:8081', proxyOptions)
const messages = proxy('http://localhost:8082', proxyOptions)
const notifications = proxy('http://localhost:8083', proxyOptions)

app.use('/api/auth', auth)
app.use('/api/messages', messages)
app.use('/api/notifications', notifications)

const server = app.listen(8080, () => {
  console.log('API Gateway running on port 8080')
})

const exitHandler = () => {
  if (server) {
    server.close(() => {
      console.info('API Gateway server closed')
      process.exit(1)
    })
  } else {
    process.exit(1)
  }
}

const unexpectedErrorHandler = (error: unknown) => {
  console.error('[api-gateway]: Uncaught Exception', error)
  exitHandler()
}

process.on('uncaughtException', unexpectedErrorHandler)
process.on('unhandledRejection', unexpectedErrorHandler)