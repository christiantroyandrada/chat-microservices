/**
 * Test helpers for mocking TypeORM AppDataSource and repository/query-builder chains
 * for notification-service tests.
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
    // Common repo helpers so tests can spy/mock these methods
    findOne: jest.fn().mockResolvedValue(undefined),
    find: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    remove: jest.fn().mockResolvedValue(undefined),
  }
  return repo
}

export function mockAppDataSourceWith(repo: any) {
  jest.resetModules()
  jest.doMock('../../src/database', () => ({
    Notification: require('../../src/database/models/NotificationModel').default,
    AppDataSource: { getRepository: () => repo },
  }))
}

export function mockRepoWith(options: { getManyResult?: any; executeResult?: any; queryResult?: any; saveResult?: any } = {}) {
  const qb = createQueryBuilderMock({ getManyResult: options.getManyResult, executeResult: options.executeResult })
  const repo = createRepoMock({ queryResult: options.queryResult, saveResult: options.saveResult, qb })
  mockAppDataSourceWith(repo)
  return { repo, qb }
}
