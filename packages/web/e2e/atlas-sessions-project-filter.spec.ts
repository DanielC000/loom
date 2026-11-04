// The Atlas Sessions tab's project filter names the project it is actually filtering to — card
// d72994d7, found by the f3b18f27 worker and out of its scope.
// Record: docs/decisions/d72994d7-sessions-project-filter-option.md
//
// THE DEFECT. pages/Terminals.tsx derived the filter's options from the LIVE sessions alone, so a
// scoped project with none of its own was never among them — and a `<select value="X">` whose options
// contain no `X` does not render empty, it renders its FIRST option. That first option is the page's
// standing "All (N)" entry, so the tab read as unfiltered over a grid that was in fact filtered to the
// project, and the filter's label and its own value said different things.
//
// WHAT EACH LEG MEASURES:
//   1. THE CLAIM ITSELF — a scoped project with zero live sessions shows ITS OWN NAME selected, the
//      option really is in the list, and the selected label is not the "All (N)" entry.
//   2. THE ROUND TRIP — widening to All and coming back. Pre-fix there was no option to come back TO,
//      so this is the dead end the scoped hold exists to prevent, and it exercises the control for
//      real (an observable before/after on both halves) rather than merely rendering it.
//
// ⭐ ASSERTION ORDER IS LOAD-BEARING. Every leg's own precondition — the tab panel is this project's,
// and its grid is empty — is true on the PRE-FIX build too: the filter STATE was always correct, only
// the rendered option list was short. A precondition gated on anything the fix ADDS would make the
// negative control prove "the new code is absent", which `git diff` already says. The first real
// assertion is therefore the defect's own value comparison, which prints "All (…)" against the
// project's name on a reverted build.
//
// ⛔ NO REAL CLAUDE IS EVER SPAWNED: these legs need a project with NO live sessions, so nothing is
// seeded into the grid at all — `createProject` is the whole fixture.
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";
import { openNodeTab } from "./helpers/nodeTabs";

// lib/atlasUi.ts owns the switch key and the "1" = on encoding; lib/activeProject.tsx owns the project
// one. Hardcoded rather than imported, as in atlas-sessions-quick-start.spec.ts: the e2e tsconfig
// covers `e2e/` only (tsconfig.e2e.json), the same reason fixtures/daemon.ts hardcodes its own keys.
const ATLAS_KEY = "loom.atlasUi";
const PROJECT_KEY = "loom.projectId";

/** The project node's Sessions tab address — src/nav.tsx's PROJECT_NODE_TABS `sessions` row. */
const SESSIONS_PATH = "/terminals";

const uniq = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// Only ever seeded ON. Off IS the default (an empty storage key), and addInitScript re-runs on EVERY
// navigation — so a "seed off" script would silently re-clear the key mid-test.
async function seedAtlasOn(page: Page) {
  await page.addInitScript((key) => {
    try { localStorage.setItem(key, "1"); } catch { /* storage unavailable — assertions will say so */ }
  }, ATLAS_KEY);
}

// Writes only while the key is still absent, for the same reason as above: an unconditional write
// would re-pin on a reload, and that leg would be measuring this helper instead of the app.
async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([key, id]) => {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, id); } catch { /* storage unavailable */ }
  }, [PROJECT_KEY, projectId] as const);
}

const panel = (page: Page) => page.getByTestId("atlas-tabpanel-sessions");

/**
 * The page's project FILTER. Several selects can be on this page at once (the Columns picker, the
 * quick-start's agent picker, and every OTHER project tab's own — AtlasShell parks a visited tab body
 * with `hidden` rather than unmounting it), so this is scoped to the Sessions panel AND picked out by
 * the standing "All (" entry only this control has — the same discriminator sessions-terminals.spec.ts
 * uses on the classic page, for the same reason.
 */
const projectFilter = (page: Page) => panel(page).locator("select").filter({ hasText: "All (" });

/** The visible text of whichever option the browser currently has selected — what the reader SEES. */
function selectedOptionText(page: Page): Promise<string> {
  return projectFilter(page).evaluate((el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent ?? "");
}

/**
 * Land on the project node's Sessions tab with the switch on and the project pinned, then assert the
 * precondition both legs share. Re-selecting the tab THROUGH the node tab row (rather than trusting
 * the address alone) is what keeps this working if the tab ever folds into the row's More menu.
 */
async function gotoQuietSessionsTab(page: Page, loomDaemon: LoomDaemon, projectId: string) {
  await seedAtlasOn(page);
  await pinProject(page, projectId);
  await page.goto(loomDaemon.baseURL + SESSIONS_PATH);
  await openNodeTab(page, "sessions");
  // FIXTURE IDENTITY + the shared precondition, and BOTH halves hold on a reverted build (see header):
  // the node really is scoped to the project this spec seeded, and that project is genuinely quiet —
  // which is the only state in which the defect can show at all.
  await expect(panel(page)).toBeVisible();
  await expect(panel(page)).toContainText("No running sessions.");
  await expect(projectFilter(page)).toBeVisible();
}

test.describe("Atlas Sessions tab — the project filter names what it filters to", () => {
  test("a scoped project with zero live sessions shows its own name selected, not All", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(uniq("sessfilter"));
    await gotoQuietSessionsTab(page, loomDaemon, project.id);

    // THE DEFECT, asserted first. On a reverted build this prints the project's name as expected
    // against a received "" — the select having fallen back to its first option.
    await expect(projectFilter(page)).toHaveValue(project.name);
    // …and what the reader actually reads is that name, not the entry that claims the page is unscoped.
    expect(await selectedOptionText(page)).toBe(project.name);
    expect(await selectedOptionText(page)).not.toContain("All (");

    // The option is genuinely IN the list — so the value above is a real match rather than a browser
    // quirk, and the count pins it at one (the live set and the scoped hold must not double up).
    await expect(projectFilter(page).locator("option", { hasText: project.name })).toHaveCount(1);
    // The "All" entry is still offered, and still honestly reports this project's own zero.
    await expect(projectFilter(page).locator("option", { hasText: "All (" })).toHaveCount(1);
  });

  test("widening the filter to All and coming back to the quiet project is not a dead end", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(uniq("sessfilter"));
    await gotoQuietSessionsTab(page, loomDaemon, project.id);
    await expect(projectFilter(page)).toHaveValue(project.name);

    // WIDEN — a real interaction with an observable change on both halves, value and visible label.
    await projectFilter(page).selectOption("");
    await expect(projectFilter(page)).toHaveValue("");
    expect(await selectedOptionText(page)).toContain("All (");

    // …and BACK, which is the half the scoped hold exists for: once the reader is no longer selecting
    // it, a quiet project is the ONE option the live set can never re-derive. Pre-fix this option did
    // not exist at all, so the select call itself fails rather than merely asserting wrong.
    await projectFilter(page).selectOption(project.name);
    await expect(projectFilter(page)).toHaveValue(project.name);
    expect(await selectedOptionText(page)).toBe(project.name);
    // The grid is back to this project's own (empty) view — so the round trip moved the real filter,
    // not just the control's own label.
    await expect(panel(page)).toContainText("No running sessions.");
  });
});
