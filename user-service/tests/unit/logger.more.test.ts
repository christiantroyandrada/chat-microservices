describe('additional logger tests (user-service)', () => {
  let originalNodeEnv: string | undefined

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'
    jest.resetModules()
  })

  afterEach(() => {
    jest.restoreAllMocks()
    jest.resetModules()
    process.env.NODE_ENV = originalNodeEnv
    try {
      delete (globalThis as any).structuredClone
    } catch {
      ;(globalThis as any).structuredClone = undefined
    }
  })

  it('uses structuredClone when available and returns a clone', () => {
    const originalSC = (globalThis as any).structuredClone
    try {
      const sc = jest.fn((o: any) => ({ ...o }))
      ;(globalThis as any).structuredClone = sc
      const logger = require('../../src/utils/logger')
      const spy = jest.spyOn(console, 'log').mockImplementation(() => {})
      const payload: any = { a: 1 }
      logger.logInfo(payload)
      expect(sc).toHaveBeenCalledWith(payload)
      expect(spy).toHaveBeenCalled()
      const passed = spy.mock.calls[0][2]
      // clone should be deep-equal but not the same reference
      expect(passed).toEqual(payload)
      expect(passed).not.toBe(payload)
    } finally {
      if (originalSC) (globalThis as any).structuredClone = originalSC
    }
  })

  it('falls back to using the original object when structuredClone throws', () => {
  const originalSC = (globalThis as any).structuredClone
    try {
      const sc = jest.fn(() => {
        throw new Error('sc-fail')
      })
  ;(globalThis as any).structuredClone = sc
      const logger = require('../../src/utils/logger')
      const spy = jest.spyOn(console, 'log').mockImplementation(() => {})
      const payload: any = { a: 2 }
      logger.logInfo(payload)
      expect(sc).toHaveBeenCalledWith(payload)
      expect(spy).toHaveBeenCalled()
      const passed = spy.mock.calls[0][2]
      // when structuredClone throws the implementation returns the original
      expect(passed).toBe(payload)
    } finally {
      if (originalSC) (globalThis as any).structuredClone = originalSC
    }
  })

  it('formats Error arguments into message/stack objects', () => {
    const logger = require('../../src/utils/logger')
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const err = new Error('boom')
    logger.logError(err)
    expect(spy).toHaveBeenCalled()
    const formatted = spy.mock.calls[0][2]
    expect(formatted).toBeDefined()
    expect(formatted.message).toBe('boom')
    expect(typeof formatted.stack).toBe('string')
  })

  it('passes through primitive arguments unchanged for debug', () => {
    const logger = require('../../src/utils/logger')
    const spy = jest.spyOn(console, 'debug').mockImplementation(() => {})
    logger.logDebug('hello')
    expect(spy).toHaveBeenCalled()
    const passed = spy.mock.calls[0][2]
    expect(passed).toBe('hello')
  })
})
