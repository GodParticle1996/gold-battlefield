import { defineConfig } from '@playwright/test';

/**
 * End-to-end smoke test (spec §17/§20): boots the gateway + web dev server,
 * then verifies the app renders the battlefield, the persistent disclaimer,
 * accurate mode labels, and working accessibility toggles.
 */
export default defineConfig({
  testDir: './src',
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    launchOptions: {
      // Headless environments have no GPU — use SwiftShader software WebGL.
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu'],
    },
  },
  webServer: [
    {
      command: 'npm run start --workspace @gb/gateway',
      url: 'http://localhost:8081/health',
      timeout: 60_000,
      reuseExistingServer: true,
    },
    {
      command: 'npm run dev --workspace @gb/web',
      url: 'http://localhost:5173',
      timeout: 60_000,
      reuseExistingServer: true,
    },
  ],
});
