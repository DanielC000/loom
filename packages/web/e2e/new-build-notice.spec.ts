// The "a new build is being served — reload" notice.
// Incident, scope limit, and why a separate cheap route: docs/decisions/e98bf784-*.md.
//
// @decision e98bf784 — every leg must first prove the tab and the server genuinely disagree, THEN assert
// what the user sees. A spec that only looks for the new element reds on a revert with "element not
// found", which fails identically whether the comparison is missing, present, or present and wrong.
//
// The fixture serves the REAL built dist, so the tab's own hash is genuine and unforgeable from here;
// what is faked is the SERVER's answer (a `page.route` on
// /api/update-status — it is the one side that can be moved purely client-side).
import { expect, test, type Page } from "./fixtures/daemon";

// Owned by src/lib/newBuild.ts. Hardcoded rather than imported: the e2e tsconfig
// covers `e2e/` only (tsconfig.e2e.json), so a spec cannot pull a `src/` module in.
const dismissKeyFor = (served: string) => `loom.newBuildDismissed.${served}`;

/** A bundle filename shaped exactly like vite's, but not the one this tab loaded. */
const SERVED_ELSEWHERE = "index-NEWBUILD.js";

const notice = (page: Page) => page.getByTestId("new-build-notice");

/** Make the server report `served` for the bundle it is currently serving. */
async function serveBundle(page: Page, served: string | null) {
  await page.route("**/api/web-bundle", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ webBundle: served }) }),
  );
}

/**
 * The bundle filename THIS tab actually loaded, read the same way the app reads it. Returned so every
 * leg can prove its own precondition — that the tab and the faked server really do disagree — rather
 * than assuming the fake differs from whatever the build happened to emit.
 */
async function ownBundle(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLScriptElement>('script[type="module"][src]');
    if (!el) return null;
    return new URL(el.src, document.baseURI).pathname.split("/").pop() ?? null;
  });
}

/**
 * Assert the tab is genuinely in the stale state before asserting what it shows. This is the precondition
 * that holds under BOTH the pre- and post-change code (the script tag and the route both exist either
 * way), so gating on it never couples the control to the fix.
 */
async function assertGenuinelyStale(page: Page) {
  const own = await ownBundle(page);
  expect(own, "the tab did not load a production bundle, so there is nothing to compare and this leg " +
    "would pass vacuously").toMatch(/^index-.*\.js$/);
  expect(own, `the faked served bundle (${SERVED_ELSEWHERE}) happens to equal the one this tab loaded, ` +
    "so the tab is NOT stale and this leg proves nothing").not.toBe(SERVED_ELSEWHERE);
  return own;
}

test.describe("new-build reload notice (card e98bf784)", () => {

  test("the Atlas shell renders the notice", async ({ page, loomDaemon }) => {
    await serveBundle(page, SERVED_ELSEWHERE);
    await page.goto(loomDaemon.baseURL + "/");
    await expect(page.getByTestId("atlas-shell")).toBeVisible();

    const own = await assertGenuinelyStale(page);
    await expect(notice(page),
      `the Atlas shell left a stale tab (running ${own}, server serving ${SERVED_ELSEWHERE}) with no notice — ` +
      "ShellBanners is passed into AtlasShell precisely so one mount covers both shells").toBeVisible();
  });

  test("Reload loads the new build: the notice is gone once the tab's own bundle matches", async ({ page, loomDaemon }) => {
    await serveBundle(page, SERVED_ELSEWHERE);
    await page.goto(loomDaemon.baseURL + "/");
    await assertGenuinelyStale(page);
    await expect(notice(page)).toBeVisible();

    // Stand in for the rebuild having been picked up: after the reload the server reports the very
    // bundle this tab is running. A real reload onto a current build lands in exactly this state.
    const own = await ownBundle(page);
    await serveBundle(page, own);

    await Promise.all([
      page.waitForLoadState("load"),
      page.getByTestId("new-build-notice-reload").click(),
    ]);

    expect(await ownBundle(page), "the reload did not land on a production bundle").toMatch(/^index-.*\.js$/);
    await expect(notice(page),
      "after reloading onto the build the server is actually serving, the tab was STILL told it was stale — " +
      "the notice would then be unclearable and the user would learn to ignore it").toHaveCount(0);
  });

  test("a tab already running the served build is never told anything", async ({ page, loomDaemon }) => {
    // The false-positive direction, and the one that matters most: a notice that cries wolf trains the
    // owner to ignore the banner this card exists to make them trust.
    await page.goto(loomDaemon.baseURL + "/");
    const own = await ownBundle(page);
    expect(own, "the tab did not load a production bundle").toMatch(/^index-.*\.js$/);

    await serveBundle(page, own);
    await page.reload();
    await expect(page.getByTestId("atlas-shell")).toBeVisible(); // the shell rendered (the only one since card acbb6df6)
    await expect(notice(page),
      `the tab is running ${own} and the server is serving ${own} — there is nothing stale, yet it was ` +
      "told to reload").toHaveCount(0);
  });

  test("an unbuilt web dist (webBundle: null) is never reported as stale", async ({ page, loomDaemon }) => {
    // The daemon degrades to null rather than throwing when no dist is found. "Unknown" must resolve to
    // NO notice — never to a reload prompt the user cannot act on.
    await serveBundle(page, null);
    await page.goto(loomDaemon.baseURL + "/");
    await expect(page.getByTestId("atlas-shell")).toBeVisible(); // the shell rendered (the only one since card acbb6df6)
    expect(await ownBundle(page), "the tab did not load a production bundle").toMatch(/^index-.*\.js$/);
    await expect(notice(page), "a null served bundle (an unbuilt dist) was treated as a DIFFERENT build " +
      "and the tab was told to reload").toHaveCount(0);
  });
});
