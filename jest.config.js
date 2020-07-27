module.exports = {
  collectCoverageFrom: ["out/**/*.js"],
  coverageReporters: ["html", "lcov"],
  coverageThreshold: {
    global: {
      branches: 81.3,
      functions: 96.0,
      lines: 86.3,
      statements: -205
    }
  },
  testEnvironment: "node",
  testMatch: ["<rootDir>/test/*(*.)@(spec|test).js?(x)"]
};
