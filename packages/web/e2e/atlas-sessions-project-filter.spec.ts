// The Atlas Sessions tab is LOCKED to its own project node — card eb516fba (Atlas audit I-04).
// Records: docs/decisions/eb516fba-atlas-tree-rows-and-terminal-tiles.md (this card) and
// docs/decisions/d72994d7-sessions-project-filter-option.md (the filter's option derivation, which the
// god-eye mounts still use).
//
// THE DEFECT. The project node's Sessions tab carried its own "Project" picker, so a reader on the
// Fire Studio node could point the grid at another project's sessions while every other part of the
// node still said Fire Studio. Card d72994d7 had already fixed the picker's LABEL for a quiet project;
// the audit's finding is that inside a project node there should be no picker at all. The bar now
// names the node's project as plain text, and only the god-eye mounts (the workspace Terminals node,
// the classic /terminals page) keep the picker.
//
// WHAT EACH LEG MEASURES:
//   1. THE CLAIM — on a project node's Sessions tab the bar names THIS project and offers no project
//      select at all, and the grid is filtered to it (a quiet project reads "No running sessions.").
//   2. THE CONTROL — the workspace Terminals node still offers the picker with its "All (N)" entry, so
//      leg 1's absence is the lock and not a bar that lost its filter everywhere.
//
// ⛔ NO REAL CLAUDE IS EVER SPAWNED: `createProject` is the whole fixture.
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";
import { openNodeTab } from "./helpers/nodeTabs";

// lib/activeProject.tsx owns the project key. Hardcoded rather than imported: the e2e tsconfig covers
// `e2e/` only (tsconfig.e2e.json).
const PROJECT_KEY = "loom.projectId";

/** The project node's Sessions tab address — src/nav.tsx's PROJECT_NODE_TABS `sessions` row. */
const SESSIONS_PATH = "/terminals";
/** The workspace Terminals node — src/nav.tsx's ATLAS_HOMES `workspace-terminals` row. */
const WORKSPACE_TERMINALS_PATH = "/workspace-terminals";

const uniq = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// Writes only while the key is still absent, so a reload never re-pins.
async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([key, id]) => {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, id); } catch { /* storage unavailable */ }
  }, [PROJECT_KEY, projectId] as const);
}

const panel = (page: Page) => page.getByTestId("atlas-tabpanel-sessions");
/** The project FILTER: the one select carrying the standing "All (" entry (the Columns picker has none). */
const projectFilterIn = (scope: ReturnType<Page["getByTestId"]>) => scope.locator("select").filter({ hasText: "All (" });

async function gotoSessionsTab(page: Page, loomDaemon: LoomDaemon, projectId: string) {
  await pinProject(page, projectId);
  await page.goto(loomDaemon.baseURL + SESSIONS_PATH);
  await openNodeTab(page, "sessions");
  await expect(panel(page)).toBeVisible();
}

test.describe("Atlas Sessions tab — locked to its own project node", () => {
  test("a project node's Sessions tab names its project and offers no project picker", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(uniq("sesslock"));
    await gotoSessionsTab(page, loomDaemon, project.id);

    // FIXTURE IDENTITY: the node is this spec's project (its own name, unique per run, on the bar).
    const locked = panel(page).getByTestId("sessions-project-locked");
    await expect(locked).toHaveText(project.name);
    // THE CLAIM: no project select at all inside the node. On a reverted build this reads 1.
    await expect(projectFilterIn(panel(page)), "the project node still offers a project picker").toHaveCount(0);
    // …and the grid really is this project's: it is quiet, so it says so rather than showing others.
    await expect(panel(page)).toContainText("No running sessions.");
  });

  test("the workspace Terminals node keeps the picker (the lock is per project node only)", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(uniq("sesslock"));
    await pinProject(page, project.id);
    await page.goto(loomDaemon.baseURL + WORKSPACE_TERMINALS_PATH);
    const node = page.getByTestId("atlas-terminals-node");
    await expect(node).toBeVisible();
    const filter = projectFilterIn(node);
    await expect(filter, "the god-eye node lost its project picker").toHaveCount(1);
    await expect(node.getByTestId("sessions-project-locked")).toHaveCount(0);
    // The god-eye mount starts unfiltered ("All"), as it always has.
    await expect(filter).toHaveValue("");
  });
});
