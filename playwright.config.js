import { defineConfig, devices } from "@playwright/test";

// Runs against a static server serving the repo root, which serves whatever
// config.js currently says (see scripts/build-config.mjs). globalSetup
// refuses to proceed if that's the production Supabase project — see
// tests/e2e/global-setup.js.
export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.js",
  fullyParallel: false, // tests share one seeded account/dataset
  forbidOnly: !!process.env.CI,
  // Every test hits a real, free-tier Supabase project over the network —
  // one retry absorbs a rare transient blip (a dropped connection, an
  // occasional auth hiccup) far more cheaply than re-running the whole
  // suite. A test that fails twice in a row is a real failure, not noise.
  retries: 1,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.PW_BASE_URL || "http://localhost:8765",
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } }
  ],
  webServer: {
    command: "npm run serve",
    url: "http://localhost:8765",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000
  }
});
