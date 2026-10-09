import amqp from 'amqplib'

type AmqpClient = Pick<typeof amqp, 'connect'>

function isBrokerUrl(url: string | undefined): url is string {
  if (!url) return false
  try {
    const parsed = new URL(url)
    return (parsed.protocol === 'amqp:' || parsed.protocol === 'amqps:') && parsed.hostname.length > 0
  } catch {
    return false
  }
}

export async function runBrokerPreflight(url = process.env.MESSAGE_BROKER_URL, client: AmqpClient = amqp): Promise<void> {
  if (!isBrokerUrl(url)) throw new Error('MESSAGE_BROKER_URL must be a valid amqp or amqps URL')

  let connection: Awaited<ReturnType<typeof amqp.connect>> | undefined
  let channel: Awaited<ReturnType<Awaited<ReturnType<typeof amqp.connect>>['createChannel']>> | undefined
  let failed = false
  try {
    connection = await client.connect(url)
    channel = await connection.createChannel()
    await channel.close()
    channel = undefined
    await connection.close()
    connection = undefined
  } catch {
    failed = true
  }
  try {
    await channel?.close()
  } catch {
    failed = true
  }
  try {
    await connection?.close()
  } catch {
    failed = true
  }
  if (failed) throw new Error('broker preflight failed')
}

if (require.main === module) {
  const deadline = setTimeout(() => {
    console.error('broker preflight failed')
    process.exit(1)
  }, 10000)
  runBrokerPreflight().catch(() => {
    console.error('broker preflight failed')
    process.exit(1)
  }).finally(() => clearTimeout(deadline))
}
