import { defineConfig } from "@playwright/test";

// Browser tests against the demo build (no PTY server needed). Locally they
// can run on the installed Chrome (PW_CHANNEL=chrome); CI installs Chromium.
//   npx playwright test                    # check
//   npx playwright test --update-snapshots # accept new pictures
const PORT = 15199;

export default defineConfig({
  testDir: "e2e",
  // The snapshots cover only the pixel-art scene, which has no text, so one
  // picture per device pixel ratio serves every OS.
  snapshotPathTemplate: "{testDir}/__screenshots__/{projectName}/{arg}{ext}",
  expect: { toHaveScreenshot: { maxDiffPixels: 0 } },
  fullyParallel: true,
  // One retry in CI only: Playwright still reports a test that needed it as flaky.
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1280, height: 720 },
    channel: process.env.PW_CHANNEL || undefined,
  },
  projects: [
    { name: "dpr1", use: { deviceScaleFactor: 1 } },
    { name: "dpr2", use: { deviceScaleFactor: 2 } },
  ],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    env: { VITE_DEMO: "1" },
    port: PORT,
    reuseExistingServer: !process.env.CI,
  },
});
