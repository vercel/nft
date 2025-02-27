module.exports = {
  collectCoverageFrom: ['out/**/*.js'],
  coverageReporters: ['html', 'lcov'],
  coverageThreshold: {
    global: {
      branches: 85.7,
      functions: 95.65,
      lines: 90.45,
      statements: -249,
    },
  },
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/*(*.)@(spec|test).js?(x)'],
};
