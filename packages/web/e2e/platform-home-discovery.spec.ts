// GET /api/platform/home discovery route (card 8d82be67). MissionControl.tsx (reads it with
// `retry:false` because it used to 404 in the shipping edition), Platform.tsx, Projects.tsx and
// Skills.tsx all probe it, via the SAME shared `["platformHome"]` query key, purely to read its
// absence as their "is this a dev install" edition signal. A 404 made Chromium log a console.error on
// every one of those pages, on every non-LOOM_DEV install — PERMANENTLY, not just at boot, since the
// platform-tier dev home never seeds there at all. The fix makes the route always 200, with
// `project: null` standing in for "no dev home" (the exact value every consumer already treats
// identically to the old 404). This spec proves:
//   1. a walk over every real consumer logs no error attributable to this route, on the LOOM_DEV=0
//      fixture (the shipping edition) — the card's own zero-console-error DoD line.
//   2. a negative control: the SAME detector, pointed at a page that still gets the OLD 404 shape
//      (simulated — the real route can no longer produce one), DOES catch it. Without this, a
//      detector that could never fire would "pass" by construction.
//   3. MissionControl's own consumption of the response (`platformHome.data?.project?.id`, used to
//      exclude the platform-tier home from the "N inactive projects" strip) behaves the SAME whether
//      the route returns `project: null` (shipping) or a real project (dev) — the two branches the
//      type change (`Project` → `Project | null`) now has to keep distinguishing correctly.
import { expect, test, type Page } from "./fixtures/daemon";

const PLATFORM_HOME_PATH = "/api/platform/home";

function collectResponseAndConsoleErrors(page: Page): { errors: string[] } {
  const errors: string[] = [];
  page.on("console", (msg) => { if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`); });
  // Chromium's own "Failed to load resource: 404" console error names no URL — the failing response
  // itself is what carries the path, so it's recorded here directly rather than relying on that text.
  page.on("response", (res) => {
    if (res.status() >= 400) errors.push(`http ${res.status()}: ${new URL(res.url()).pathname}`);
  });
  return { errors };
}

// Every real consumer of the shared `["platformHome"]` query (Skills.tsx is mounted only inside Actors
// at `?tab=skills`, never at its own route).
const CONSUMER_ROUTES = ["/", "/platform", "/projects"];

test.describe("GET /api/platform/home discovery (card 8d82be67)", () => {
  test("a page walk over every real consumer logs no error from this route, in the shipping edition", async ({ page, loomDaemon }) => {
    const { errors } = collectResponseAndConsoleErrors(page);
    for (const route of CONSUMER_ROUTES) {
      await page.goto(loomDaemon.baseURL + route);
      await page.waitForLoadState("networkidle");
    }
    // Skills.tsx mounts only once its tab is selected inside Actors — a separate navigation so its own
    // `platformHome` probe is actually exercised (the shared query-key cache would otherwise mask a
    // real second fetch by one of the other three routes already having warmed it). Plain goto, not
    // `gotoActorsReady`: that helper waits for `/api/agents`, which only the Profiles tab fetches — the
    // Skills tab never does, so waiting on it here would hang for no reason.
    await page.goto(`${loomDaemon.baseURL}/actors?tab=skills`);
    await page.waitForLoadState("networkidle");

    const fromThisRoute = errors.filter((e) => e.includes(PLATFORM_HOME_PATH));
    expect(fromThisRoute,
      `console/response noise attributed to ${PLATFORM_HOME_PATH}:\n${JSON.stringify(fromThisRoute)}`)
      .toEqual([]);
  });

  // Negative control for the assertion above — proves the detector is actually capable of catching the
  // regression it's guarding against, not merely incapable of ever firing. The real route can no longer
  // produce a 404, so this simulates the OLD shape via a client-side route mock (never touching the
  // daemon) and confirms the SAME detector catches it.
  test("negative control — the same detector DOES catch a simulated 404 from this route", async ({ page, loomDaemon }) => {
    await page.route(`**${PLATFORM_HOME_PATH}`, (route) => route.fulfill({
      status: 404, contentType: "application/json",
      body: JSON.stringify({ error: "simulated — negative control, card 8d82be67" }),
    }));
    const { errors } = collectResponseAndConsoleErrors(page);
    await page.goto(loomDaemon.baseURL + "/platform");
    await page.waitForLoadState("networkidle");

    const fromThisRoute = errors.filter((e) => e.includes(PLATFORM_HOME_PATH));
    expect(fromThisRoute.length,
      "the detector should have caught the simulated 404 but didn't — it cannot be trusted").toBeGreaterThan(0);
  });

  // MissionControl parity — the SAME exclusion logic (`reservedProjectIds` → archivedOnlyProjects, see
  // lib/fleet.ts) exercised under BOTH values the response's `project` field can now take, with a real
  // archived-only project as the thing being excluded-or-not, so this is a genuine before/after contrast
  // rather than a render-only smoke check.
  test("MissionControl excludes the platform-tier home from inactive projects only when one actually exists — unchanged in both editions", async ({ page, loomDaemon }) => {
    const seeded = await loomDaemon.seedLiveSession({ role: "manager" });
    // Archive THIS session only (never the worker-shared `archiveSeededSessions()`, which sweeps every
    // session tracked so far on this shared daemon and could reach into a sibling spec's still-live
    // fixture) — zero live sessions left under this project → "inactive".
    await fetch(`${loomDaemon.baseURL}/internal/test/seed`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ archiveSessions: [seeded.sessionId] }),
    });

    // Scoped to <main> (App.tsx) — the sidebar's own project switcher can independently show this
    // SAME freshly-seeded project's name as the active-project selector, which would otherwise collide
    // with the inactive-strip's card under a page-wide text locator.
    const main = page.locator("main");
    const inactiveToggle = main.getByRole("button", { name: /inactive project/i });
    const projectCard = main.getByText(seeded.projectName, { exact: true });

    // Shipping edition (no mock — the real daemon's real 200+project:null response): an ordinary
    // archived-only project is NOT reserved, so it shows in the inactive strip as before this card.
    await page.goto(loomDaemon.baseURL + "/");
    await expect(inactiveToggle).toBeVisible();
    await inactiveToggle.click();
    await expect(projectCard).toBeVisible();

    // Dev edition (mocked 200 + a REAL project — this project itself, standing in for a genuine
    // platform-tier home): MissionControl.tsx only ever reads `.project?.id`, so reusing this project's
    // own id is enough to exercise the "a real project came back" branch without needing the actual
    // reserved Loom Platform home. The SAME project must now be excluded.
    await page.route(`**${PLATFORM_HOME_PATH}`, (route) => route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ project: { id: seeded.projectId, name: seeded.projectName, reserved: true }, agents: [], liveSessions: [] }),
    }));
    await page.goto(loomDaemon.baseURL + "/");
    // Either the toggle itself is gone (zero OTHER inactive projects on this shared worker daemon) or it
    // is present and, once opened, no longer lists this project — assert whichever applies rather than
    // assuming one.
    if (await inactiveToggle.count() > 0) {
      await inactiveToggle.click();
      await expect(projectCard).toHaveCount(0);
    } else {
      await expect(projectCard).toHaveCount(0);
    }
  });
});
