module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/lambda', '<rootDir>/agent', '<rootDir>/cdk'],
  testMatch: ['**/*.test.ts'],
  transform: { '^.+\\.tsx?$': 'ts-jest' },
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
};
