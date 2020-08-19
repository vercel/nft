module.exports = {
  collectCoverageFrom: ["out/**/*.js"],
  coverageReporters: ["html", "lcov"],
  coverageThreshold: {
    global: {
      branches: 80.5,
      functions: 95.28,
      lines: 85.7,
      statements: -252
    }
  },
  testEnvironment: "node",
  testMatch: ["<rootDir>/test/*(*.)@(spec|test).js?(x)"]
};
