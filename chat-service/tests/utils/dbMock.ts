/**
 * Test helpers for mocking TypeORM AppDataSource and repository/query-builder chains.
 * Place under `tests/utils` and require from unit tests via `require('../utils/dbMock')`.
 */

export function createQueryBuilderMock(options: { getManyResult?: any; executeResult?: any } = {}) {
  const { getManyResult = [], executeResult = { affected: 0 } } = options
  const qb: any = {
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(getManyResult),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue(executeResult),
  }
  return qb
}

export function createRepoMock(options: { queryResult?: any; saveResult?: any; qb?: any } = {}) {
  const { queryResult = [], saveResult = undefined, qb = undefined } = options
  const repo: any = {
    query: jest.fn().mockResolvedValue(queryResult),
    save: jest.fn().mockResolvedValue(saveResult),
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    // Common repository methods used across tests. Provide jest.fn() so tests
    // can call .mockResolvedValue / .mockResolvedValueOnce on them without
    // triggering TypeError when they attempt to spy/mock.
    findOne: jest.fn().mockResolvedValue(undefined),
    find: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    remove: jest.fn().mockResolvedValue(undefined),
  }
  return repo
}

export function mockAppDataSourceWith(repo: any) {
  // Mock the database module so controllers pick up the fake AppDataSource
  // Reset modules to ensure the mock takes effect even if the controller module
  // was previously loaded in other tests. This matches common test patterns
  // where mocks are applied before requiring the module under test.
  jest.resetModules()
  jest.doMock('../../src/database', () => ({
    Message: require('../../src/database/models/MessageModel').default,
    AppDataSource: { getRepository: () => repo },
  }))
}

export function mockRepoWith(options: { getManyResult?: any; executeResult?: any; queryResult?: any; saveResult?: any } = {}) {
  const qb = createQueryBuilderMock({ getManyResult: options.getManyResult, executeResult: options.executeResult })
  const repo = createRepoMock({ queryResult: options.queryResult, saveResult: options.saveResult, qb })
  mockAppDataSourceWith(repo)
  return { repo, qb }
}
