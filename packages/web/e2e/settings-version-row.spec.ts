// The running version, re-homed from the retired classic rail footer: a read-only "Version" line in
// Workspace Settings → Interface, rendered from `GET /api/version`.
// Set LOOM_E2E_SHOTS to a directory to persist light/dark screenshots of the row for review.
import path from "node:path";
import { expect, test } from "./fixtures/daemon";

test("Workspace Settings shows the running daemon version as a read-only line", async ({ page, loomDaemon }) => {
  const served = await (await fetch(loomDaemon.baseURL + "/api/version")).json() as { version: string };
  expect(served.version).toMatch(/^\d+\.\d+\.\d+/);
  await page.goto(loomDaemon.baseURL + "/home?tab=settings");
  const row = page.getByTestId("loom-version");
  await expect(row).toHaveText(`v${served.version}`);
  const dir = process.env.LOOM_E2E_SHOTS;
  if (dir) {
    for (const theme of ["light", "dark"]) {
      await page.evaluate((t) => localStorage.setItem("loom.theme", t), theme);
      await page.reload();
      await expect(row).toBeVisible();
      await page.screenshot({ path: path.join(dir, `version-row-${theme}.png`) });
    }
  }
});
