describe('logger utilities (notification-service)', () => {
  afterEach(() => {
    jest.restoreAllMocks()
    jest.resetModules()
  })

  it('logWarn calls console.warn and exercises cloning fallbacks', () => {
    process.env.NODE_ENV = 'development'
    const originalSC = (globalThis as any).structuredClone
    try {
      delete (globalThis as any).structuredClone
      jest.resetModules()
      const logger = require('../../src/utils/logger')
      const spy = jest.spyOn(console, 'warn').mockImplementation(() => {})
      const payload: any = { a: 1, f: () => {} }
      logger.logWarn(payload)
      expect(spy).toHaveBeenCalled()
    } finally {
      if (originalSC) (globalThis as any).structuredClone = originalSC
    }
  })

  it('in production logDebug/logInfo/logWarn/logError are no-ops', () => {
    process.env.NODE_ENV = 'production'
    jest.resetModules()
    const logger = require('../../src/utils/logger')
    const sdebug = jest.spyOn(console, 'debug').mockImplementation(() => {})
    const sprint = jest.spyOn(console, 'log').mockImplementation(() => {})
    const swarn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const serr = jest.spyOn(console, 'error').mockImplementation(() => {})
    logger.logDebug('x')
    logger.logInfo('x')
    logger.logWarn('x')
    logger.logError('x')
    expect(sdebug).not.toHaveBeenCalled()
    expect(sprint).not.toHaveBeenCalled()
    expect(swarn).not.toHaveBeenCalled()
    expect(serr).not.toHaveBeenCalled()
  })
})
