import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  // The long journeys load a dozen pages; against a small hosted server (E2E_BASE_URL) that takes longer than a minute.
  timeout: process.env.E2E_BASE_URL ? 150_000 : 60_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "report" }]] : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:4700",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
});
