// Same-named tree rows read differently, and `auto` terminal tiles stay readable — card eb516fba
// (Atlas audit B-22 and B-23). Record: docs/decisions/eb516fba-atlas-tree-rows-and-terminal-tiles.md
//
// WHAT EACH LEG MEASURES:
//   1. B-22 — two live workers of one agent name ("Dev") get DIFFERENT row labels in the tree, each
//      carrying its own card's title; a uniquely named sibling is left exactly as it was (the control).
//   2. B-23 — with Columns on Auto, a manager row whose panes are pinned at 120 columns draws ONE tile
//      per row at 1440 (two would scale the text to ~7.7px), while an 80-column row at the same width
//      still draws two side by side (the control: the default is unchanged).
//   3. Card 41a933d4 — at 390px, in both shells, an Auto tile fits its grid and the page does not
//      scroll sideways (the tile floor is clamped to the container).
//
// ⛔ NO REAL CLAUDE IS EVER SPAWNED: every session is a seeded row with a CANNED pty, so the panes really
// receive the daemon's geometry frame and nothing else.
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";
import { openNodeTab } from "./helpers/nodeTabs";

// Hardcoded rather than imported: the e2e tsconfig covers `e2e/` only (tsconfig.e2e.json).
const PROJECT_KEY = "loom.projectId";

const uniq = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([projectKey, id]) => {
    try {
      if (localStorage.getItem(projectKey) === null) localStorage.setItem(projectKey, id);
    } catch { /* storage unavailable — the assertions will say so */ }
  }, [PROJECT_KEY, projectId] as const);
}

/** A manager and its workers in ONE project, every pane pinned at `cols`. */
async function seedRow(loomDaemon: LoomDaemon, prefix: string, cols: number, workers: { agentName: string; task?: string }[]) {
  const project = await loomDaemon.createProject(uniq(prefix));
  const geometry = { cols, rows: 24 };
  const mgr = await loomDaemon.seedLiveSession({
    project, id: uniq(`${prefix}m`), role: "manager", agentName: "Lead",
    ptyGeometry: geometry, ptyBytes: `${prefix.toUpperCase()}-MANAGER\r\n`,
  });
  const kids = [];
  for (const [i, w] of workers.entries()) {
    kids.push(await loomDaemon.seedLiveSession({
      project, id: uniq(`${prefix}w${i}`), role: "worker", agentName: w.agentName, parentSessionId: mgr.sessionId,
      ...(w.task ? { task: { title: w.task } } : {}),
      ptyGeometry: geometry, ptyBytes: `${prefix.toUpperCase()}-WORKER-${i}\r\n`,
    }));
  }
  return { project, mgr, kids };
}

test.describe("Atlas — tree rows that tell sessions apart, tiles that stay readable", () => {
  test("two workers of one agent name read differently in the tree; a unique name is untouched", async ({ page, loomDaemon }) => {
    const f = await seedRow(loomDaemon, "ebsfx", 80, [
      { agentName: "Dev", task: "fix(daemon): stop double-charging on retried webhooks" },
      { agentName: "Dev", task: "feat(web): remember onboarding wizard steps" },
      { agentName: "QA Tester", task: "test(web): cover the wizard" },
    ]);
    const [devA, devB, qa] = f.kids;
    await pinProject(page, f.project.id);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${loomDaemon.baseURL}/session/${devA!.sessionId}`);

    const label = (id: string) => page.getByTestId(`atlas-session-${id}`).locator(".loom-atlas-lbl");
    // FIXTURE IDENTITY: both Dev rows are this spec's own sessions, under its own project's branch.
    await expect(label(devA!.sessionId)).toBeAttached();
    await expect(label(devB!.sessionId)).toBeAttached();

    // THE CLAIM. On a reverted build both read exactly "Dev".
    await expect(label(devA!.sessionId)).toHaveText("Dev · stop double-charging on retried webhooks");
    await expect(label(devB!.sessionId)).toHaveText("Dev · remember onboarding wizard steps");
    // The CONTROL: the unique name gets no suffix even though it, too, holds a titled card.
    await expect(label(qa!.sessionId)).toHaveText("QA Tester");
    // The suffix is part of the link's accessible name, not only of what is drawn.
    await expect(page.getByRole("link", { name: /Dev · remember onboarding wizard steps/ })).toHaveCount(1);
  });

  test("Auto draws one tile per row for a 120-column pinned grid, two for 80 columns", async ({ page, loomDaemon }) => {
    const wide = await seedRow(loomDaemon, "ebwide", 120, [{ agentName: "Wide Dev" }]);
    const narrow = await seedRow(loomDaemon, "ebnarrow", 80, [{ agentName: "Narrow Dev" }]);
    await page.setViewportSize({ width: 1440, height: 900 });

    /** How many distinct rows the row's tiles occupy, once each pane has had its geometry frame. */
    const rowsOfTiles = (rowKey: string) => page.getByTestId(`sessions-grid-${rowKey}`).evaluate((grid) =>
      new Set([...grid.children].map((t) => Math.round(t.getBoundingClientRect().top))).size);

    // The 120-column project's own Sessions tab.
    await pinProject(page, wide.project.id);
    await page.goto(`${loomDaemon.baseURL}/terminals`);
    await openNodeTab(page, "sessions");
    const panel = page.getByTestId("atlas-tabpanel-sessions");
    await expect(panel.getByTestId("sessions-project-locked")).toHaveText(wide.project.name);
    await expect(panel.getByTestId("sessions-columns")).toHaveValue("auto");
    await expect(panel.locator(".xterm-rows")).toHaveCount(2);
    // THE CLAIM: two tiles, stacked. On a reverted build both share one row (and render ~7.7px text).
    await expect.poll(() => rowsOfTiles(wide.mgr.sessionId), { message: "a 120-column row still draws two-up" }).toBe(2);
    // …and the text in them is at least the readable floor.
    const fonts = await panel.locator(".xterm-rows").evaluateAll((els) => els.map((e) => parseFloat(getComputedStyle(e).fontSize)));
    for (const px of fonts) expect(px, `a 120-column tile rendered at ${px}px`).toBeGreaterThanOrEqual(10);

    // THE CONTROL: the 80-column project at the same width keeps its two tiles side by side.
    await page.evaluate(([key, id]) => localStorage.setItem(key, id), [PROJECT_KEY, narrow.project.id] as const);
    await page.goto(`${loomDaemon.baseURL}/terminals`);
    await openNodeTab(page, "sessions");
    await expect(panel.getByTestId("sessions-project-locked")).toHaveText(narrow.project.name);
    await expect(panel.locator(".xterm-rows")).toHaveCount(2);
    await expect.poll(() => rowsOfTiles(narrow.mgr.sessionId), { message: "the default 80 columns stopped drawing two-up" }).toBe(1);
  });

  // Card 41a933d4: at phone width an `auto` tile takes the row instead of pushing the page sideways. On the
  // god-eye Terminals node, whose content column clips — so the document stays 390 and only the tile's own
  // box (560px in a 350px grid, before the fix) shows it; both are measured. The long project name is the
  // fixture for the Project filter, which also widened the page. (A classic-shell leg was deleted with
  // that shell by card acbb6df6.)
  test("at 390px no Auto tile, and nothing else, overflows sideways", async ({ page, loomDaemon }) => {
    const f = await seedRow(loomDaemon, "ovf41-atlas-a-long-customer-onboarding-and-billing-reconciliation-project", 80, [{ agentName: "Phone Dev" }]);
    await pinProject(page, f.project.id);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${loomDaemon.baseURL}/workspace-terminals`);

    // FIXTURE IDENTITY: this spec's own row, with both of its panes attached.
    const grid = page.getByTestId(`sessions-grid-${f.mgr.sessionId}`);
    await expect(grid.locator(".xterm-rows")).toHaveCount(2);

    // THE CLAIM, tile side: each tile fits inside its grid.
    const overhang = () => grid.evaluate((g) => {
      const right = g.getBoundingClientRect().right;
      return Math.max(...[...g.children].map((t) => Math.round(t.getBoundingClientRect().right - right)));
    });
    await expect.poll(overhang, { message: "an Auto tile is wider than its grid" }).toBeLessThanOrEqual(0);
    // …and the document as a whole does not scroll sideways.
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(sideways, "the page scrolls sideways at 390px").toBeLessThanOrEqual(0);
  });
});
