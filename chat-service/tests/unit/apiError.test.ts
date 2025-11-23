import { APIError } from '../../src/utils/apiError'

describe('APIError', () => {
  test('sets properties and captures stack when not provided', () => {
    const err = new APIError(400, 'bad', true)
    expect(err.statusCode).toBe(400)
    expect(err.message).toBe('bad')
    expect(err.isOperational).toBe(true)
    expect(typeof err.stack).toBe('string')
  })

  test('uses provided stack trace when given', () => {
    const stack = 'custom stack'
    const err = new APIError(500, 'oops', false, stack)
    expect(err.stack).toBe(stack)
    expect(err.isOperational).toBe(false)
  })
})
