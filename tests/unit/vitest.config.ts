import path from 'node:path';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) => path.resolve(__dirname, `../../packages/${name}/src/index.ts`);

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@gb/market-types': pkg('market-types'),
      '@gb/shared-config': pkg('shared-config'),
      '@gb/order-book': pkg('order-book'),
      '@gb/analytics': pkg('analytics'),
      '@gb/visual-mapping': pkg('visual-mapping'),
      '@gb/provider-adapters': pkg('provider-adapters'),
    },
  },
});
