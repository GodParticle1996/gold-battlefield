import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const pkg = (name: string) => path.resolve(__dirname, `../../packages/${name}/src/index.ts`);

export default defineConfig({
  plugins: [react()],
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
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
  },
  build: {
    // Stage 5 perf: split the heavy vendor libraries so the initial payload is
    // small and the 3D engine loads in a separate, cacheable chunk.
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three', '@react-three/fiber', '@react-three/drei'],
          react: ['react', 'react-dom'],
          state: ['zustand'],
        },
      },
    },
  },
});
