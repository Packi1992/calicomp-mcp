import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Abdeckung nur auf Abruf (`--coverage.enabled=true`), z. B. über tools/test-inventory.mjs run mcp --abdeckung.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
  },
});
