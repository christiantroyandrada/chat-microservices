#!/usr/bin/env node
// Purge the NOTIFICATIONS queue for the notification-service
// Usage: cd notification-service && node scripts/purgeQueue.js

const amqp = require('amqplib')
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../.env') })

async function run() {
  const url = process.env.MESSAGE_BROKER_URL
  const queue = process.env.NOTIFICATIONS_QUEUE || 'NOTIFICATIONS'

  if (!url) {
    console.error('ERROR: MESSAGE_BROKER_URL not set in .env')
    process.exit(1)
  }

  console.log('[purgeQueue] connecting to', url)
  const conn = await amqp.connect(url)
  const ch = await conn.createChannel()

  try {
    await ch.assertQueue(queue)
    const qInfo = await ch.checkQueue(queue)
    console.log('[purgeQueue] queue:', queue, 'messageCount:', qInfo.messageCount, 'consumerCount:', qInfo.consumerCount)

    if (qInfo.messageCount === 0) {
      console.log('[purgeQueue] nothing to purge')
    } else {
      const res = await ch.purgeQueue(queue)
      console.log('[purgeQueue] purge result:', res)
    }
  } catch (err) {
    console.error('[purgeQueue] error:', err)
    process.exitCode = 2
  } finally {
    await ch.close()
    await conn.close()
  }
}

run().catch(err => {
  console.error('[purgeQueue] fatal error:', err)
  process.exit(1)
})
