/** @type {import('jest').Config} */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: '(test|src)/.*\\.(spec|test)\\.ts$',
  transform: {
    '^.+\\.ts$': ['@swc/jest'],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  // NodeNext requires `.js` import suffix for TS sources; strip it for Jest resolver.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.module.ts', '!src/main.ts'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'lcov'],
  // V8 native coverage avoids the decorator-metadata false-branch problem
  // that istanbul reports on @Controller / @Get / @Injectable.
  coverageProvider: 'v8',
  // CLAUDE.md §3.1 — gate is unconditional, not just when invoked via npm script.
  coverageThreshold: {
    global: { branches: 80, lines: 90, functions: 90, statements: 90 },
  },
};
