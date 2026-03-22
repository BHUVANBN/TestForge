import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.ts', '**/*.test.ts', '**/*.spec.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          // Allow importing JSON modules in tests
          resolveJsonModule: true,
          // Relax some strict checks for test mocks
          noImplicitAny: false,
        },
      },
    ],
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/cli/**',       // CLI is tested separately via E2E
    '!src/index.ts',     // Entry point
  ],
  coverageThreshold: {
    global: {
      branches: 45,
      functions: 60,
      lines: 60,
      statements: 60,
    },
  },
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  // Give Redis-backed tests more time
  testTimeout: 15000,
  // Show individual test results
  verbose: true,
  // Clear mocks between tests
  clearMocks: true,
  restoreMocks: true,
};

export default config;
