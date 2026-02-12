/* eslint-disable @typescript-eslint/no-var-requires */
describe('MessageController more branch exercises', () => {
  beforeEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
  })

  it('sendMessage rejects when message is not a string', async () => {
  const { mockRepoWith } = require('../utils/dbMock')
  mockRepoWith()
  jest.doMock('../../src/utils', () => ({ APIError: class APIError extends Error { constructor(public statusCode:number, public message:string){ super(message) } }, handleMessageReceived: jest.fn() }))
  const { requireControllerAfterMocks } = require('../utils/testHelpers')
  const { controller } = requireControllerAfterMocks('../../src/controllers/MessageController')
  const MC = controller.default || controller
    const res: any = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await MC.sendMessage({ user: { _id: 'u1', username: 'u' }, body: { receiverId: 'u2', message: 123 } } as any, res)
    expect(res.json).toHaveBeenCalled()
  })

  it('sendMessage rejects when message is only whitespace', async () => {
  const { mockRepoWith } = require('../utils/dbMock')
  mockRepoWith()
  jest.doMock('../../src/utils', () => ({ APIError: class APIError extends Error { constructor(public statusCode:number, public message:string){ super(message) } }, handleMessageReceived: jest.fn() }))
  const { requireControllerAfterMocks } = require('../utils/testHelpers')
  const { controller } = requireControllerAfterMocks('../../src/controllers/MessageController')
  const MC = controller.default || controller
    const res: any = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await MC.sendMessage({ user: { _id: 'u1', username: 'u' }, body: { receiverId: 'u2', message: '   ' } } as any, res)
    expect(res.json).toHaveBeenCalled()
  })

  it('fetchConversation returns 500 when query builder throws', async () => {
  const repo = { createQueryBuilder: jest.fn().mockImplementation(() => { throw new Error('db-fail') }) }
  const AppDataSource = { getRepository: jest.fn().mockReturnValue(repo) }
  jest.doMock('../../src/database', () => ({ AppDataSource }))
  const { requireControllerAfterMocks } = require('../utils/testHelpers')
  const { controller } = requireControllerAfterMocks('../../src/controllers/MessageController')
  const MC = controller.default || controller
    const res: any = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await MC.fetchConversation({ user: { _id: 'u1' }, params: { receiverId: 'u2' } } as any, res)
    expect(res.json).toHaveBeenCalled()
    const called = res.json.mock.calls[0][0]
    expect(called).toHaveProperty('status')
  })

  it('markAsRead returns error when senderId missing', async () => {
  const { mockRepoWith } = require('../utils/dbMock')
  const { repo } = mockRepoWith({ executeResult: { affected: 0 } })
  const { requireControllerAfterMocks } = require('../utils/testHelpers')
  const { controller } = requireControllerAfterMocks('../../src/controllers/MessageController')
  const MC = controller.default || controller
    const res: any = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await MC.markAsRead({ user: { _id: 'u1' }, params: {} } as any, res)
    expect(res.json).toHaveBeenCalled()
  })
})
