// e2e harness foundation (card c3fd1d68). Specs + fixtures are co-located here, kept OUT of the
// existing gates: the web `test/*.mjs` unit glob (packages/web/test/run-all.mjs) and the daemon
// hermetic array (packages/daemon/scripts/test-daemon.mjs) are untouched — this is its own runner
// (`pnpm --filter @loom/web test:e2e`) and will get its own CI job.
//
// No `webServer` block: each spec's `loomDaemon` fixture (./fixtures/daemon.ts) boots its OWN isolated,
// seeded daemon per worker and serves the built web app from it (single-process mode), so there is
// nothing for Playwright itself to start or proxy. `use.baseURL` is deliberately left unset for the
// same reason — the bound origin is only known once a worker's daemon has booted (a fixed port could
// collide across workers), so specs read it from `loomDaemon.baseURL` instead of relying on relative
// navigation.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  fullyParallel: false,
  // One worker: each worker boots its own full daemon (sqlite + fastify + the built web app), which is
  // heavier than a typical browser-only Playwright worker. Revisit if/when the per-feature specs (the
  // rollout's phase 2) make single-worker wall-clock a bottleneck.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    // The app's theme defaults to "system" (card 3b5b3106), and Playwright emulates a LIGHT OS unless
    // told otherwise. Pin the emulated OS to dark so every spec keeps rendering the theme it was written
    // against. Specs that test the theme itself (theme-switch.spec.ts) override this per test with
    // `test.use({ colorScheme })` or `page.emulateMedia`, and light is covered there and by the specs
    // that seed `loom.theme = "light"`.
    { name: "chromium", use: { ...devices["Desktop Chrome"], colorScheme: "dark" } },
  ],
});
