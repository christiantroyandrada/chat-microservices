// Prevent ESM-only modules from breaking Jest when modules are imported
jest.mock('uuid', () => ({ v4: () => 'mock-uuid' }))
jest.mock('amqplib', () => ({ connect: jest.fn() }))

describe('MessageController.markAsRead', () => {
  beforeEach(() => jest.resetAllMocks())

  test('marks messages as read and returns modifiedCount from execute result', async () => {
  const { requireControllerWithMock } = require('../utils/testHelpers')
  const { controller, repo, qb } = requireControllerWithMock('../../src/controllers/MessageController', { executeResult: { affected: 5 } })
  const MessageController = controller

    const req: any = { params: { senderId: 's123' }, user: { _id: 'r456' } }
    const res: any = { json: jest.fn().mockImplementation((v) => v) }

    const outRaw = await MessageController.markAsRead(req, res)
    const out: any = outRaw as any

    expect(repo.createQueryBuilder).toHaveBeenCalled()
    expect(qb.execute).toHaveBeenCalled()
    expect(out.status).toBe(200)
    expect(out.data).toBeDefined()
    expect(out.data.modifiedCount).toBe(5)
  })
})
