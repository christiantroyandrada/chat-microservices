import { runBrokerPreflight } from '../../src/preflight/brokerPreflight'

const brokerUrl = 'amqps://user:super-secret@broker.example/vhost'

function client(connect: jest.Mock) {
  return { connect } as never
}

describe('runBrokerPreflight', () => {
  it.each([undefined, '', 'https://broker.example', 'amqp://'])('rejects a missing or invalid broker URL without exposing it', async url => {
    await expect(runBrokerPreflight(url, client(jest.fn()))).rejects.toThrow('MESSAGE_BROKER_URL must be a valid amqp or amqps URL')
    await expect(runBrokerPreflight(url, client(jest.fn()))).rejects.not.toThrow(brokerUrl)
  })

  it('sanitizes connection failures', async () => {
    const connect = jest.fn().mockRejectedValue(new Error(`refused ${brokerUrl}`))

    await expect(runBrokerPreflight(brokerUrl, client(connect))).rejects.toThrow('broker preflight failed')
    await expect(runBrokerPreflight(brokerUrl, client(connect))).rejects.not.toThrow('super-secret')
  })

  it('creates and closes a channel and connection', async () => {
    const channel = { close: jest.fn().mockResolvedValue(undefined) }
    const connection = { createChannel: jest.fn().mockResolvedValue(channel), close: jest.fn().mockResolvedValue(undefined) }
    const connect = jest.fn().mockResolvedValue(connection)

    await expect(runBrokerPreflight(brokerUrl, client(connect))).resolves.toBeUndefined()
    expect(connect).toHaveBeenCalledWith(brokerUrl)
    expect(connection.createChannel).toHaveBeenCalledTimes(1)
    expect(channel.close).toHaveBeenCalledTimes(1)
    expect(connection.close).toHaveBeenCalledTimes(1)
  })

  it('always attempts connection close when channel close rejects', async () => {
    const channel = { close: jest.fn().mockRejectedValue(new Error('channel fail')) }
    const connection = { createChannel: jest.fn().mockResolvedValue(channel), close: jest.fn().mockResolvedValue(undefined) }
    const connect = jest.fn().mockResolvedValue(connection)

    await expect(runBrokerPreflight(brokerUrl, client(connect))).rejects.toThrow('broker preflight failed')
    // second call would double-count, so verify credentials not leaked via single invocation
    const channel2 = { close: jest.fn().mockRejectedValue(new Error('channel fail')) }
    const connection2 = { createChannel: jest.fn().mockResolvedValue(channel2), close: jest.fn().mockResolvedValue(undefined) }
    const connect2 = jest.fn().mockResolvedValue(connection2)
    await expect(runBrokerPreflight(brokerUrl, client(connect2))).rejects.not.toThrow('super-secret')
    expect(connection.close).toHaveBeenCalledTimes(1)
    expect(connection2.close).toHaveBeenCalledTimes(1)
  })
})
