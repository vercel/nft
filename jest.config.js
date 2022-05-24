module.exports = {
  collectCoverageFrom: ["out/**/*.js", "!out/vendor/**/*"],
  coverageReporters: ["html", "lcov"],
  coverageThreshold: {
    global: {
      branches: 80.5,
      functions: 95.2,
      lines: 85.87,
      statements: -249
    }
  },
  testEnvironment: "node",
  testMatch: ["<rootDir>/test/*(*.)@(spec|test).js?(x)"]
};
