module.exports = {
  collectCoverageFrom: ["out/**/*.js"],
  coverageReporters: ["html", "lcov"],
  coverageThreshold: {
    global: {
      branches: 87.27,
      functions: 96.25,
      lines: 92.28,
      statements: -249
    }
  },
  testEnvironment: "node",
  testMatch: ["<rootDir>/test/*(*.)@(spec|test).js?(x)"]
};
