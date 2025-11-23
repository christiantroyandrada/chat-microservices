// Helper to require a controller after installing repository/query-builder mocks
module.exports.requireControllerWithMock = function(controllerPath, mockOptions = {}) {
  jest.resetModules()
  const { mockRepoWith } = require('./dbMock')
  const { repo, qb } = mockRepoWith(mockOptions)
  const controller = require(controllerPath)
  return { controller, repo, qb }
}

module.exports.requireControllerAfterMocks = function(controllerPath) {
  jest.resetModules()
  const controller = require(controllerPath)
  return { controller }
}
