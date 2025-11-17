/* stylelint-disable */
/* eslint-disable */
/**
 * Jest setup file
 */

/* Setup test environment */
beforeAll(() => {
  /* Initialize test environment */
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-secret-key';
  process.env.USER_SERVICE_URL = 'http://localhost:8081';
  process.env.RABBITMQ_URL = 'amqp://localhost:5672';
});

/* Cleanup after tests */
afterAll(() => {
  /* nothing to clean yet */
});

/* Global test utilities */
(global as any).console = {
  ...console,
  /* Suppress console.log during tests */
  log: (jest && jest.fn) ? jest.fn() : () => {},
  /* Keep error and warn for debugging */
  error: console.error,
  warn: console.warn
};
