import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.TOTEMORA_E2E_PORT ?? 4321);
const baseURL = process.env.TOTEMORA_E2E_BASE_URL ?? `http://127.0.0.1:${port}`;
const dataDir = process.env.TOTEMORA_E2E_DATA_DIR ?? `/tmp/totemora-e2e-${process.pid}`;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.pw.ts",
  fullyParallel: false,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium-desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "chromium-mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "bun run tests/e2e/start-web.ts",
    url: `${baseURL}/api/status`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: {
      TOTEMORA_HOST: "127.0.0.1",
      TOTEMORA_PORT: String(port),
      TOTEMORA_DATA_DIR: dataDir,
      TOTEMORA_E2E_CONFIG_DIR: `${dataDir}/config`,
    },
  },
});
