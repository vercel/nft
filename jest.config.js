module.exports = {
  collectCoverageFrom: ["out/**/*.js"],
  coverageReporters: ["html", "lcov"],
  coverageThreshold: {
    global: {
      branches: 87.36,
      functions: 96.25,
      lines: 92.4,
      statements: -249
    }
  },
  testEnvironment: "node",
  testMatch: ["<rootDir>/test/*(*.)@(spec|test).js?(x)"]
};
