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
    '^@quant/config/server$': '<rootDir>/../../packages/config/src/server/index.ts',
    '^@quant/config/client$': '<rootDir>/../../packages/config/src/client/index.ts',
    '^@quant/config/prompts$': '<rootDir>/../../packages/config/src/prompts/index.ts',
    '^@quant/config$': '<rootDir>/../../packages/config/src/index.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  // Initialise ServerConfigCenter with defaults so tests instantiating
  // services that read through ConfigCenter don't have to do it manually.
  setupFiles: ['<rootDir>/test/setup-config-center.ts'],
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
