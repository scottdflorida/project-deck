import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".forge/run/playwright",
  timeout: 30_000,
  fullyParallel: false,
  reporter: [["line"]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.PLAYWRIGHT_NO_SERVER ? undefined : {
    command: "npm run build && npx vinext start",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
