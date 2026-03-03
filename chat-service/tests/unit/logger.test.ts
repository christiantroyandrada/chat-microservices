describe('logger utilities', () => {
  afterEach(() => {
    jest.restoreAllMocks()
    jest.resetModules()
  })

  it('logWarn calls console.warn and exercises cloning fallbacks', () => {
    // Ensure non-production so logging is enabled when module loads
    process.env.NODE_ENV = 'development'
    // Force structuredClone to be unavailable so code exercises v8/json branch
    const originalSC = (globalThis as any).structuredClone
    try {
      delete (globalThis as any).structuredClone

      // Load fresh module after resetting modules
      jest.resetModules()
      const logger = require('../../src/utils/logger')

      const spy = jest.spyOn(console, 'warn').mockImplementation(() => {})

      // Pass an object containing a function which structuredClone would
      // reject if it were present; this helps exercise the fallback paths.
      const payload: any = { a: 1, f: () => {} }

      logger.logWarn(payload)

      expect(spy).toHaveBeenCalled()
    } finally {
  if (originalSC) (globalThis as any).structuredClone = originalSC
    }
  })

  it('in production logDebug is suppressed but logInfo/logWarn/logError still emit', () => {
    process.env.NODE_ENV = 'production'
    jest.resetModules()
    const logger = require('../../src/utils/logger')

    const sdebug = jest.spyOn(console, 'debug').mockImplementation(() => {})
    // Production: logInfo → process.stdout.write (JSON), logWarn/logError → process.stderr.write
    const sout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const serr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true)

    logger.logDebug('x')
    logger.logInfo('x')
    logger.logWarn('x')
    logger.logError('x')

    expect(sdebug).not.toHaveBeenCalled()
    expect(sout).toHaveBeenCalled()          // logInfo emits JSON to stdout
    expect(serr).toHaveBeenCalledTimes(2)    // logWarn + logError emit JSON to stderr
  })
})
