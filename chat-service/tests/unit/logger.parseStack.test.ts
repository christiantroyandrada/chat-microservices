describe.skip('logger stack parsing branches', () => {
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

    // Monkeypatch Error.captureStackTrace so we can inject a custom stack
    const originalCapture = (Error as any).captureStackTrace
    ;(Error as any).captureStackTrace = (err: any) => {
      err.stack = 'Error: test\n    at firstLine\n    at Object.<anonymous> (src/controllers/Fake.ts:123:45)\n'
    }

    try {
      logger.logInfo('x')
      expect(spy).toHaveBeenCalled()
      const args = spy.mock.calls[0]
      // second arg should include the parsed file:line
      expect(typeof args[1]).toBe('string')
      expect(args[1]).toContain('Fake.ts:123')
    } finally {
      if (originalCapture) (Error as any).captureStackTrace = originalCapture
    }
  })
})
