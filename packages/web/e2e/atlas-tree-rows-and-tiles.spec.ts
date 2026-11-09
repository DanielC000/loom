// Same-named tree rows read differently, and `auto` terminal tiles stay readable — card eb516fba
// (Atlas audit B-22 and B-23). Record: docs/decisions/eb516fba-atlas-tree-rows-and-terminal-tiles.md
//
// WHAT EACH LEG MEASURES:
//   1. B-22 — two live workers of one agent name ("Dev") get DIFFERENT row labels in the tree, each
//      carrying its own card's title; a uniquely named sibling is left exactly as it was (the control).
//   2. B-23 — with Columns on Auto, a manager row whose panes are pinned at 120 columns draws ONE tile
//      per row at 1440 (two would scale the text to ~7.7px), while an 80-column row at the same width
//      still draws two side by side (the control: the default is unchanged).
//
// ⛔ NO REAL CLAUDE IS EVER SPAWNED: every session is a seeded row with a CANNED pty, so the panes really
// receive the daemon's geometry frame and nothing else.
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";
import { openNodeTab } from "./helpers/nodeTabs";

// Hardcoded rather than imported: the e2e tsconfig covers `e2e/` only (tsconfig.e2e.json).
const ATLAS_KEY = "loom.atlasUi";
const PROJECT_KEY = "loom.projectId";

const uniq = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function seedAtlas(page: Page, projectId: string) {
  await page.addInitScript(([atlasKey, projectKey, id]) => {
    try {
      localStorage.setItem(atlasKey, "1");
      if (localStorage.getItem(projectKey) === null) localStorage.setItem(projectKey, id);
    } catch { /* storage unavailable — the assertions will say so */ }
  }, [ATLAS_KEY, PROJECT_KEY, projectId] as const);
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
    await seedAtlas(page, f.project.id);
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
    await seedAtlas(page, wide.project.id);
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
});
