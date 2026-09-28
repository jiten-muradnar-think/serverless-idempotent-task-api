/**
 * SWC transpiles without type checking, which `npm run typecheck` already does
 * once. Running tsc twice was costing minutes of CI time for no extra safety.
 */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  transform: {
    '^.+\\.ts$': ['@swc/jest', { jsc: { target: 'es2022', parser: { syntax: 'typescript' } } }],
  },
  collectCoverageFrom: ['src/**/*.ts', 'lib/**/*.ts'],
  coverageThreshold: {
    global: { branches: 70, functions: 90, lines: 90, statements: 90 },
  },
};
