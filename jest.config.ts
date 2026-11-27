import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/cli/**', '!src/index.ts'],
  coverageThreshold: {
    global: { branches: 60, functions: 70, lines: 75, statements: 75 },
  },
  coverageDirectory: 'coverage',
  coverageReporters: ['text-summary', 'lcov'],
  testTimeout: 20000,
  clearMocks: true,
  restoreMocks: true,
};

export default config;
