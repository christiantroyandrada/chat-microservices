// Helper to require a controller after installing repository/query-builder mocks
// Ensures jest module cache is reset and the controller picks up mocked AppDataSource
module.exports.requireControllerWithMock = function(controllerPath, mockOptions = {}) {
  // reset modules so doMock/doMock replacements apply to subsequent requires
  jest.resetModules()
  const { mockRepoWith } = require('./dbMock')
  const { repo, qb } = mockRepoWith(mockOptions)
  const controller = require(controllerPath)
  return { controller, repo, qb }
}

// Require a controller after any test-installed mocks are in place.
// This does NOT install repo/database mocks — use requireControllerWithMock when
// you want the helper to create repo/query-builder mocks for you.
module.exports.requireControllerAfterMocks = function(controllerPath) {
  jest.resetModules()
  const controller = require(controllerPath)
  return { controller }
}
