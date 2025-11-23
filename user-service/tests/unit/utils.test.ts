describe('utils module', () => {
	afterEach(() => {
		jest.restoreAllMocks()
		jest.resetModules()
	})

	it('APIError sets properties and stack when provided', () => {
		const { APIError } = require('../../src/utils')
		const e = new APIError(400, 'bad', true, 'mystack')
		expect(e).toBeInstanceOf(Error)
		expect(e.statusCode).toBe(400)
		expect(e.isOperational).toBe(true)
		expect(e.stack).toBe('mystack')
	})

	it('APIError captures stack when none provided', () => {
		const { APIError } = require('../../src/utils')
		const e = new APIError(500, 'err')
		expect(typeof e.stack).toBe('string')
		expect(e.message).toBe('err')
	})

	it('encryptPassword delegates to bcrypt.hash and returns the hash', async () => {
		jest.resetModules()
		const bcrypt = require('bcryptjs')
		const hashSpy = jest.spyOn(bcrypt, 'hash').mockResolvedValue('hashed_pw')
		const { encryptPassword } = require('../../src/utils')
		const out = await encryptPassword('pw')
		expect(hashSpy).toHaveBeenCalledWith('pw', 12)
		expect(out).toBe('hashed_pw')
	})

	it('isPasswordMatch delegates to bcrypt.compare and returns boolean', async () => {
		jest.resetModules()
		const bcrypt = require('bcryptjs')
		const cmp = jest.spyOn(bcrypt, 'compare').mockResolvedValue(true)
		const { isPasswordMatch } = require('../../src/utils')
		const ok = await isPasswordMatch('pw', 'hashed')
		expect(cmp).toHaveBeenCalledWith('pw', 'hashed')
		expect(ok).toBe(true)
	})
})
