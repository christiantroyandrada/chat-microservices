describe('logger stack parsing branches', () => {
  afterEach(() => {
    jest.restoreAllMocks()
    jest.resetModules()
  })

  it('parses a stack line with parentheses and logs file:line', () => {
    process.env.NODE_ENV = 'development'
    jest.resetModules()
    const logger = require('../../src/utils/logger')

    // Spy on console.log to verify output
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {})

    // Monkeypatch Error.prepareStackTrace to inject a custom stack string
    const originalPrepare = (Error as any).prepareStackTrace
    ;(Error as any).prepareStackTrace = function () {
      return 'Error: test\n    at firstLine\n    at Object.<anonymous> (src/controllers/Fake.ts:123:45)\n'
    }

    try {
      logger.logInfo('x')
      expect(spy).toHaveBeenCalled()
      const args = spy.mock.calls[0]
      // second arg should include the parsed file:line
      expect(typeof args[1]).toBe('string')
      expect(args[1]).toContain('Fake.ts:123')
    } finally {
      if (originalPrepare) (Error as any).prepareStackTrace = originalPrepare
    }
  })
})
