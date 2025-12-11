import * as logger from '../../src/utils/logger'

describe('notification-service logger', () => {
  const origConsole = { log: console.log, warn: console.warn, error: console.error, debug: console.debug }

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {})
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    jest.spyOn(console, 'error').mockImplementation(() => {})
    jest.spyOn(console, 'debug').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
    console.log = origConsole.log
    console.warn = origConsole.warn
    console.error = origConsole.error
    console.debug = origConsole.debug
  })

  test('log functions accept error and object args and call console', () => {
    const err = new Error('oh no')
    const obj = { a: 1 }

    expect(() => logger.logInfo('hi', obj)).not.toThrow()
    expect(() => logger.logWarn(err)).not.toThrow()
    expect(() => logger.logError('err', obj)).not.toThrow()
    expect(() => logger.logDebug('dbg')).not.toThrow()

    expect(console.log).toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalled()
    expect(console.error).toHaveBeenCalled()
    expect(console.debug).toHaveBeenCalled()
  })
})
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

  it('in production logDebug is suppressed but logInfo/logWarn/logError still emit', () => {
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
    expect(sprint).toHaveBeenCalled()
    expect(swarn).toHaveBeenCalled()
    expect(serr).toHaveBeenCalled()
  })
})
