import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    // packaging.test.ts shells out to tsup + npm pack; give it room.
    testTimeout: 120_000,
  },
});
