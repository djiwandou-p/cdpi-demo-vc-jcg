import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    // Broadened from 'tests/integration/**' to 'tests/**' so the dependency-free
    // compose smoke test (tests/compose/**) runs alongside the live integration
    // suite. The smoke test needs no running stack, so this is safe for `vitest run`.
    include: ['tests/**/*.test.ts'],
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});
