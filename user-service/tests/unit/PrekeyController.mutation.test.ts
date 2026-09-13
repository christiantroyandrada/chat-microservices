// Importing PrekeyController pulls in config which expects a JWT secret.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_which_is_long_enough_32_chars'

import PrekeyController from '../../src/controllers/PrekeyController'
import { PrekeyMutationService } from '../../src/services/PrekeyMutationService'

const userId = 'u1'
const bundle = {
  identityKey: 'idk',
  registrationId: 42,
  signedPreKey: { id: 7, publicKey: 'spk', signature: 'sig' },
  preKeys: [{ id: 1, publicKey: 'pk1' }],
}
const encryptedBundle = { encrypted: 'ct', iv: 'iv', salt: 'salt', version: 1, deviceId: 'd1' }

function reqRes(body: unknown) {
  const req: any = { user: { id: userId }, body, ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' } }
  const res: any = { json: jest.fn(), status: jest.fn().mockReturnThis() }
  const next = jest.fn()
  return { req, res, next }
}

describe('PrekeyController mutations via PrekeyMutationService', () => {
  afterEach(() => jest.restoreAllMocks())

  it('catches controller-owned publish: new bundle delegates to the service and returns published', async () => {
    const publish = jest.spyOn(PrekeyMutationService.prototype, 'publish').mockResolvedValue({ created: true })
    const { req, res, next } = reqRes({ deviceId: 'd1', bundle })

    await PrekeyController.publishPrekey(req, res, next)

    expect(publish).toHaveBeenCalledWith(userId, 'd1', bundle)
    expect(res.json).toHaveBeenCalledWith({ status: 200, message: 'Prekey bundle published' })
    expect(next).not.toHaveBeenCalled()
  })

  it('catches controller-owned publish: existing bundle delegates to the service and returns updated', async () => {
    const publish = jest.spyOn(PrekeyMutationService.prototype, 'publish').mockResolvedValue({ created: false })
    const { req, res, next } = reqRes({ deviceId: 'd1', bundle })

    await PrekeyController.publishPrekey(req, res, next)

    expect(publish).toHaveBeenCalledWith(userId, 'd1', bundle)
    expect(res.json).toHaveBeenCalledWith({ status: 200, message: 'Prekey bundle updated' })
    expect(next).not.toHaveBeenCalled()
  })

  it('catches controller-owned backup: new bundle delegates to the service and returns stored', async () => {
    const storeBackup = jest.spyOn(PrekeyMutationService.prototype, 'storeBackup').mockResolvedValue({ created: true })
    const { req, res, next } = reqRes({ deviceId: 'd1', encryptedBundle })

    await PrekeyController.storeSignalKeys(req, res, next)

    expect(storeBackup).toHaveBeenCalledWith(userId, 'd1', encryptedBundle)
    expect(res.json).toHaveBeenCalledWith({ status: 200, message: 'Encrypted keys stored' })
    expect(next).not.toHaveBeenCalled()
  })

  it('catches controller-owned backup: existing bundle delegates to the service and returns updated', async () => {
    const storeBackup = jest.spyOn(PrekeyMutationService.prototype, 'storeBackup').mockResolvedValue({ created: false })
    const { req, res, next } = reqRes({ deviceId: 'd1', encryptedBundle })

    await PrekeyController.storeSignalKeys(req, res, next)

    expect(storeBackup).toHaveBeenCalledWith(userId, 'd1', encryptedBundle)
    expect(res.json).toHaveBeenCalledWith({ status: 200, message: 'Encrypted keys updated' })
    expect(next).not.toHaveBeenCalled()
  })

  it('catches a dropped throttle: service hoursRemaining surfaces as the existing 429 message', async () => {
    jest.spyOn(PrekeyMutationService.prototype, 'storeBackup').mockResolvedValue({ created: false, hoursRemaining: 5 })
    const { req, res, next } = reqRes({ deviceId: 'd1', encryptedBundle })

    await PrekeyController.storeSignalKeys(req, res, next)

    expect(res.json).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(1)
    const error = next.mock.calls[0][0]
    expect(error.statusCode).toBe(429)
    expect(error.message).toBe('Rate limit: Please wait 5 hours before backing up keys again')
  })

  it('catches swallowed service failure: publish rejection reaches next(error) without a response', async () => {
    const failure = new Error('db down')
    jest.spyOn(PrekeyMutationService.prototype, 'publish').mockRejectedValue(failure)
    const { req, res, next } = reqRes({ deviceId: 'd1', bundle })

    await PrekeyController.publishPrekey(req, res, next)

    expect(res.json).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith(failure)
  })

  it('catches moved validation: missing deviceId still 400s without touching the service', async () => {
    const publish = jest.spyOn(PrekeyMutationService.prototype, 'publish').mockResolvedValue({ created: true })
    const storeBackup = jest.spyOn(PrekeyMutationService.prototype, 'storeBackup').mockResolvedValue({ created: true })
    const { res, next } = reqRes({ bundle })
    const req: any = { user: { id: userId }, body: { bundle } }

    await PrekeyController.publishPrekey(req, res, next)

    expect(publish).not.toHaveBeenCalled()
    expect(storeBackup).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(1)
    expect(next.mock.calls[0][0].statusCode).toBe(400)
  })
})
