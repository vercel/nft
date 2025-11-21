module.exports = {
  collectCoverageFrom: ['out/**/*.js'],
  coverageReporters: ['html', 'lcov'],
  coverageThreshold: {
    global: {
      branches: 87.25,
      functions: 96.25,
      lines: 90.85,
      statements: -249,
    },
  },
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/*(*.)@(spec|test).js?(x)'],
};
