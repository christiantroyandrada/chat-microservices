import * as logger from '../../src/utils/logger'

describe('user-service logger', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {})
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    jest.spyOn(console, 'error').mockImplementation(() => {})
    jest.spyOn(console, 'debug').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('log functions accept plain values and do not throw', () => {
    const v = 42
    expect(() => logger.logInfo('i', v)).not.toThrow()
    expect(() => logger.logWarn('w', v)).not.toThrow()
    expect(() => logger.logError('e', v)).not.toThrow()
    expect(() => logger.logDebug('d', v)).not.toThrow()
  })
})
describe('logger utilities (user-service)', () => {
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
