// Atlas is the only web UI (card acbb6df6). It replaces atlas-switch.spec.ts, whose subject — the
// per-browser Classic|Atlas switch — was deleted with the classic shell.
//
// Four claims:
//   1. A fresh browser (no stored preference at all) lands on the Atlas frame, with the cross-cutting
//      chrome wired into it, and an unknown address lands on the frame's own explanation.
//   2. A STORED legacy preference (`loom.atlasUi`, in each shape a real browser may still hold) is
//      ignored harmlessly: the app is Atlas either way and logs nothing about it.
//   3. A preference written by ANOTHER tab neither swaps this tab's shell nor raises the old
//      "reload to apply" notice — there is nothing left to switch to.
//   4. The Settings page no longer offers the switch, and still offers the theme.
//
// Every absence below carries a positive control: "no classic rail" and "no notice" read the same
// whether the app is right or the locator is wrong, so each is first shown able to match.
import { expect, test, type Page } from "./fixtures/daemon";

// The key the deleted lib/atlasUi.ts used, and the "1" = Atlas / anything-else = classic encoding it
// read. Hardcoded: nothing in src/ names it any more, which is the point.
const LEGACY_ATLAS_KEY = "loom.atlasUi";

const atlas = (page: Page) => page.getByTestId("atlas-shell");
// The classic shell's root marker. Its CSS and component are gone; a match here would mean the old
// shell had come back in some form.
const classicRail = (page: Page) => page.locator(".loom-rail");

// Console + page errors from before the first navigation, with a positive control so a zero reading
// is only believed from a collector shown to fire.
function collectConsoleErrors(page: Page): { errors: string[]; reset: () => void; assertFires: () => Promise<void> } {
  const errors: string[] = [];
  page.on("console", (msg) => { if (msg.type() === "error") errors.push("console.error: " + msg.text()); });
  page.on("pageerror", (err) => { errors.push("pageerror: " + err.message); });
  page.on("response", (res) => {
    if (res.status() >= 400) errors.push(`http ${res.status()}: ${new URL(res.url()).pathname}`);
  });
  return {
    errors,
    reset: () => { errors.length = 0; },
    assertFires: async () => {
      const probe = "loom-console-positive-control-" + Date.now();
      await page.evaluate((text) => { console.error(text); }, probe);
      await expect.poll(() => errors.some((e) => e.includes(probe)), {
        message: "positive control: the console collector never saw a deliberate console.error",
      }).toBe(true);
      const at = errors.findIndex((e) => e.includes(probe));
      if (at >= 0) errors.splice(at, 1);
    },
  };
}

// Forces ONE real piece of cross-cutting chrome to render, so "the banners slot is wired" is a claim
// about a rendered node rather than about six components that are all null on a healthy daemon. The
// response is fiction; nothing here clicks its action.
async function fakeUpdateAvailable(page: Page) {
  await page.route("**/api/update-status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        packaged: true, channel: "stable", installed: "0.0.1", latest: "0.0.2",
        updateAvailable: true, checkedAt: new Date().toISOString(),
      }),
    }),
  );
}

// Positive control for every `.loom-rail` absence below: the locator matches a node of that class
// when one exists, so a zero count is evidence rather than a typo.
async function assertRailLocatorFires(page: Page) {
  await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.className = "loom-rail";
    probe.id = "loom-rail-positive-control";
    document.body.appendChild(probe);
  });
  await expect(classicRail(page), "positive control: the rail locator did not match a planted node").toHaveCount(1);
  await page.evaluate(() => document.getElementById("loom-rail-positive-control")?.remove());
  await expect(classicRail(page)).toHaveCount(0);
}

test.describe("Atlas is the only web UI (card acbb6df6)", () => {
  test("a fresh browser lands on the Atlas frame, chrome wired, with zero console errors on the bare frame", async ({ page, loomDaemon }) => {
    const consoleErrors = collectConsoleErrors(page);
    await fakeUpdateAvailable(page);
    // No seeding of any kind: an untouched browser.
    await page.goto(loomDaemon.baseURL + "/");
    expect(await page.evaluate((k) => localStorage.getItem(k), LEGACY_ATLAS_KEY),
      "the fixture must not have seeded the legacy key for this leg").toBeNull();

    await expect(atlas(page)).toBeVisible();
    await expect(page).toHaveURL(/\/home$/);
    await expect(page.getByRole("heading", { level: 1, name: "Workspace" })).toBeVisible();
    await expect(page.getByTestId("atlas-tree")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toBeVisible();
    await assertRailLocatorFires(page);

    // The frame carries no way "back" to a classic UI and no preview badge any more.
    await expect(page.getByTestId("atlas-leave")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /classic/i })).toHaveCount(0);
    await expect(atlas(page).locator("header").getByText("preview", { exact: true })).toHaveCount(0);

    // The banners slot is really wired: the forced banner renders inside the frame.
    await expect(atlas(page).locator('[role="status"]').filter({ hasText: "A new Loom release is available" }))
      .toBeVisible();

    // An address that is no page lands on the frame's explanation, which no longer offers a switch.
    await page.goto(loomDaemon.baseURL + "/no-such-node");
    const empty = page.getByTestId("atlas-empty");
    await expect(empty).toBeVisible();
    await expect(empty).toContainText("doesn't match any page");
    await expect(empty).not.toContainText(/classic|preview/i);

    // Zero console errors, scoped to the bare frame (the catch-all mounts no page of its own, so any
    // error here is the frame's).
    consoleErrors.reset();
    await page.waitForLoadState("networkidle");
    await consoleErrors.assertFires();
    expect(consoleErrors.errors, "the bare Atlas frame logged errors").toEqual([]);
  });

  // Every value a real browser may still hold from the switch era: "1" (was Atlas), "0" and "" and
  // garbage (all read as classic by the old reader), and an explicit absence is the leg above.
  for (const stored of ["1", "0", "", "classic", "{\"on\":false}"]) {
    test(`a stored legacy preference ${JSON.stringify(stored)} is ignored harmlessly`, async ({ page, loomDaemon }) => {
      const consoleErrors = collectConsoleErrors(page);
      await page.addInitScript(([key, value]) => {
        try { localStorage.setItem(key, value); } catch { /* the assertion below will say so */ }
      }, [LEGACY_ATLAS_KEY, stored] as const);
      await page.goto(loomDaemon.baseURL + "/");
      expect(await page.evaluate((k) => localStorage.getItem(k), LEGACY_ATLAS_KEY),
        "the legacy value must really be in storage for this leg to mean anything").toBe(stored);

      await expect(atlas(page)).toBeVisible();
      await expect(page).toHaveURL(/\/home$/);
      await assertRailLocatorFires(page);

      // Survives a reload the same way (the old reader ran at module load).
      await page.reload();
      await expect(atlas(page)).toBeVisible();
      await expect(classicRail(page)).toHaveCount(0);

      await page.goto(loomDaemon.baseURL + "/no-such-node");
      await expect(page.getByTestId("atlas-empty")).toBeVisible();
      consoleErrors.reset();
      await page.waitForLoadState("networkidle");
      await consoleErrors.assertFires();
      expect(consoleErrors.errors, `a stored ${JSON.stringify(stored)} produced errors`).toEqual([]);
    });
  }

  test("a preference written by another tab changes nothing in this one", async ({ page, context, loomDaemon }) => {
    await page.goto(loomDaemon.baseURL + "/home");
    await expect(atlas(page)).toBeVisible();

    // Positive control on the storage-event path itself: this page must really receive the other
    // tab's write, or "nothing happened" would be true for the wrong reason.
    await page.evaluate(() => {
      (window as unknown as { __loomStorageEvents: string[] }).__loomStorageEvents = [];
      window.addEventListener("storage", (e) => {
        (window as unknown as { __loomStorageEvents: string[] }).__loomStorageEvents.push(String(e.key));
      });
    });
    const other = await context.newPage();
    try {
      await other.goto(loomDaemon.baseURL + "/home");
      await other.evaluate((k) => { localStorage.setItem(k, "0"); localStorage.removeItem(k); localStorage.setItem(k, "1"); }, LEGACY_ATLAS_KEY);
      await expect.poll(() => page.evaluate(() =>
        (window as unknown as { __loomStorageEvents: string[] }).__loomStorageEvents.length))
        .toBeGreaterThanOrEqual(3);

      // No "reload to apply" notice, and the shell is untouched.
      await expect(page.getByTestId("atlas-switch-notice")).toHaveCount(0);
      await expect(atlas(page)).toBeVisible();
      await expect(classicRail(page)).toHaveCount(0);
    } finally {
      await other.close();
    }
  });

  test("Settings offers the theme and no UI switch", async ({ page, loomDaemon }) => {
    await page.goto(loomDaemon.baseURL + "/workspace-settings");
    // The Interface section lives on the Workspace node's Settings tab.
    await expect(page).toHaveURL(/\/home\?tab=settings/);
    const theme = page.getByTestId("theme-switch");
    await expect(theme).toBeVisible();
    // Exercise it, so the section is shown to be live rather than merely rendered.
    await theme.getByRole("radio", { name: /^light$/i }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await theme.getByRole("radio", { name: /^dark$/i }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    await expect(page.getByTestId("atlas-ui-switch")).toHaveCount(0);
    await expect(page.getByText("Which UI this browser renders")).toHaveCount(0);
    await expect(page.getByRole("radio", { name: /atlas preview/i })).toHaveCount(0);
  });
});
