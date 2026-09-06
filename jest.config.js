module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  collectCoverageFrom: ['src/domain/**/*.ts', 'src/lib/extract.ts', 'src/lib/telegram.ts'],
};
