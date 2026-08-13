/**
 * Jest configuration.
 *
 * We use the explicit `transform` form rather than `preset: 'ts-jest'`
 * because the preset shorthand is being phased out and emits deprecation
 * warnings on Jest 30. This form does exactly the same thing, visibly.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  // Our code runs in Node, not a browser. (Browser work happens through
  // Playwright/CDP from Phase 7, which is a real Chrome - not jsdom.)
  testEnvironment: 'node',

  // Where Jest is allowed to look for tests.
  roots: ['<rootDir>/src', '<rootDir>/tests'],

  // What counts as a test file.
  testMatch: ['**/*.test.ts'],

  // Compile TypeScript on the fly. ts-jest type-checks as it goes, so a
  // type error fails the test run - that is intentional.
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },

  moduleFileExtensions: ['ts', 'js', 'json'],

  /**
   * Run test files one at a time.
   *
   * From Phase 7 the suite launches a real Chrome. With Jest's default
   * parallelism, several workers each hold a ts-jest compilation cache while
   * one of them also owns a browser, and workers start dying with "Jest
   * worker ran out of memory and crashed" - which surfaces as five suites
   * "failed to run" and no useful error.
   *
   * Serial execution costs a few seconds and removes the whole class of
   * problem. The target project's own jest setup uses --runInBand for the
   * same reason.
   */
  maxWorkers: 1,

  // Never scan build output or dependencies.
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],

  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],

  clearMocks: true,
};
