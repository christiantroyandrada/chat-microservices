// Prevent ESM-only modules from causing parse errors in Jest
jest.mock('uuid', () => ({ v4: () => 'mock-uuid' }))
jest.mock('amqplib', () => ({}))

describe('connectDB', () => {
  beforeEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
  })

  it('initializes AppDataSource and logs success', async () => {
    const logInfo = jest.fn()
    const logError = jest.fn()

    // Mock the logger before requiring the module so the module picks up the mock
    jest.doMock('../../src/utils/logger', () => ({ logInfo, logError }))

    const { AppDataSource, connectDB } = require('../../src/database/connection')

    // Spy on initialize to simulate successful DB init
    jest.spyOn(AppDataSource, 'initialize').mockResolvedValue(undefined)

    await connectDB()

    expect(logInfo).toHaveBeenCalledWith('[chat-service] Connecting to PostgreSQL...')
    expect(logInfo).toHaveBeenCalledWith('[chat-service] PostgreSQL connected successfully')
  })

  it('logs error and exits when initialize fails', async () => {
    const logInfo = jest.fn()
    const logError = jest.fn()

    jest.doMock('../../src/utils/logger', () => ({ logInfo, logError }))

    const { AppDataSource, connectDB } = require('../../src/database/connection')

    jest.spyOn(AppDataSource, 'initialize').mockRejectedValue(new Error('boom'))

    // Prevent real process.exit and observe that it would be called
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((code?: any) => {
      throw new Error('process.exit called')
    })

    await expect(connectDB()).rejects.toThrow('process.exit called')
    expect(logError).toHaveBeenCalled()

    exitSpy.mockRestore()
  })
})
