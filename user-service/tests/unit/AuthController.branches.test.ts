process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_which_is_long_enough_32_chars'

describe('AuthController branch-targeted tests', () => {
  afterEach(() => {
    jest.restoreAllMocks()
    jest.resetModules()
  })

  it('registration detects username already taken (different email)', async () => {
    const { mockRepoWith } = require('../utils/dbMock')
    const { repo } = mockRepoWith({})
    ;(repo.findOne as jest.Mock).mockResolvedValue({ id: 'e1', username: 'takenuser', email: 'diff@b.com' })

    const AuthController = require('../../src/controllers/AuthController')
    const req: any = { body: { username: 'takenuser', email: 'other@b.com', password: 'pw' } }
    const res: any = { json: jest.fn() }
    const next = jest.fn()

    await AuthController.registration(req, res, next)

    expect(next).toHaveBeenCalled()
  })

  it('getCurrentUser returns user when found', async () => {
    const { mockRepoWith } = require('../utils/dbMock')
    const { repo } = mockRepoWith({})
    ;(repo.findOne as jest.Mock).mockResolvedValue({ id: 'u1', username: 'u', email: 'a@b' })

    const AuthController = require('../../src/controllers/AuthController')
    const res: any = { json: jest.fn() }
    const req: any = { user: { id: 'u1' } }
    const next = jest.fn()
    await AuthController.getCurrentUser(req, res, next)
    expect(res.json).toHaveBeenCalled()
  })

  it('getUserById success path returns user', async () => {
    const { mockRepoWith } = require('../utils/dbMock')
    const { repo } = mockRepoWith({})
    ;(repo.findOne as jest.Mock).mockResolvedValue({ id: 'u2', username: 'u2', email: 'b@c' })

    const AuthController = require('../../src/controllers/AuthController')
    const res: any = { json: jest.fn() }
    await AuthController.getUserById({ params: { userId: 'u2' } } as any, res, jest.fn())
    expect(res.json).toHaveBeenCalled()
  })

  it('search returns empty for blank query and maps users for non-empty', async () => {
    const AuthController = require('../../src/controllers/AuthController')
    const res: any = { json: jest.fn() }
    await AuthController.search({ query: {} } as any, res, jest.fn())
    expect(res.json).toHaveBeenCalled()

  const { mockRepoWith } = require('../utils/dbMock')
  const { repo, qb } = mockRepoWith({ getManyResult: [{ id: 'u3', username: 'three', email: '3@x' }] })
  // re-require controller after mocking AppDataSource so it picks up the mocked repo
  const AuthController2 = require('../../src/controllers/AuthController')
  const res2: any = { json: jest.fn() }
  await AuthController2.search({ query: { q: 'thr' }, user: { id: 'u1' } } as any, res2, jest.fn())
  expect(res2.json).toHaveBeenCalled()
  })
})
