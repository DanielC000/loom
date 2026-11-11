// The pages card acbb6df6 deleted with the classic shell — Mission Control (`/`), Projects (`/projects`)
// and the classic project Overview (`/overview`) — leave no dead end behind (cards 5afd71bd, acbb6df6).
// Design records: docs/decisions/5afd71bd-atlas-retire-mission-control-and-projects.md and
// docs/decisions/acbb6df6-atlas-only-web-ui.md.
//
// Three claims. That each address REDIRECTS to its node is atlas-legacy-redirects.spec.ts's walk (the rows
// are LEGACY_REDIRECTS now); this file holds what that walk cannot see:
//   1. NONE IS IN THE TREE — not a node row, and not an escape-hatch entry (the hatch is deleted).
//   2. NO DEAD LINK POINTS AT ONE. The re-pointed exits are asserted on their real `href`s, and the Pulse
//      band's retired exit is asserted ABSENT beside a sibling band that kept its link.
//   3. THE ⌘K PALETTE OFFERS NONE OF THEM, beside a surviving row that proves the collector reads rows.
//
// Every absence claim carries a positive control on the same collector at the same moment: an empty or
// mis-typed locator returns zero exactly like a true absence does.
import { expect, test, type Page } from "./fixtures/daemon";

// lib/activeProject.tsx owns this key; hardcoded because the e2e tsconfig covers `e2e/` only.
const PROJECT_KEY = "loom.projectId";

// The deleted pages and the names they went by. Literal on purpose: the pages, their nav rows and every
// label source are deleted, so the only place these names still exist is the history this checks against.
const DELETED = [
  { from: "/", label: "Mission Control" },
  { from: "/projects", label: "Projects" },
  { from: "/overview", label: "Overview" },
] as const;

async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([key, id]) => {
    try { localStorage.setItem(key, id); } catch { /* storage unavailable */ }
  }, [PROJECT_KEY, projectId] as const);
}

/**
 * The palette's own PAGE rows, opened with the real accelerator — each as its label alone. A row is a
 * `role="option"` carrying its kind and label as `data-kind` / `data-label` (card bafbca40).
 */
async function paletteRows(page: Page): Promise<string[]> {
  await page.keyboard.press("Control+k");
  const field = page.getByPlaceholder(/^Jump to/);
  await expect(field, "the Command Palette did not open").toBeVisible();
  const rows = await page.getByRole("option").evaluateAll((els) =>
    els.filter((el) => el.getAttribute("data-kind") === "page")
      .map((el) => el.getAttribute("data-label") ?? ""));
  await page.keyboard.press("Escape");
  await expect(field, "the Command Palette did not close").toHaveCount(0);
  return rows;
}

test.describe("deleted destinations leave no dead end (cards 5afd71bd, acbb6df6)", () => {
  test("none is in the tree, no exit links to one, and the palette offers none", async ({ page, loomDaemon }) => {
    test.setTimeout(120_000);
    const project = await loomDaemon.createProject(`atlas-deleted-${Date.now()}`);
    const sentinel = `Atlas deleted-destinations card ${Date.now()}`;
    await loomDaemon.createTask(project.id, { title: sentinel, columnKey: "inbox", priority: "p1" });
    await pinProject(page, project.id);

    // FIXTURE IDENTITY: the frame really is scoped to the project this spec created.
    await page.goto(loomDaemon.baseURL + "/board");
    await expect(page.getByTestId("atlas-shell")).toBeVisible();
    await expect(page.locator("main").getByText(sentinel, { exact: true }),
      "the Board node is not showing this spec's own corpus").toBeVisible();

    // ── CLAIM 1: not in the tree. ──
    for (const d of DELETED) {
      await expect(page.getByTestId(`atlas-node-${d.from}`), `${d.from} is still an Atlas tree row`).toHaveCount(0);
      await expect(page.getByTestId(`atlas-unhomed-${d.from}`),
        `${d.from} is still a "not yet re-homed" escape-hatch entry`).toHaveCount(0);
    }
    await expect(page.getByTestId("atlas-unhomed"), "the escape-hatch disclosure is still mounted").toHaveCount(0);
    // POSITIVE CONTROLS on those absences: the SAME tree-node collector sees the rows that stayed, on two
    // different tiers, so a tree that failed to render at all cannot satisfy the zeros above.
    await expect(page.getByTestId("atlas-node-/platform"),
      "positive control: the tree-node collector cannot see the Platform node either").toHaveCount(1);
    await expect(page.getByTestId("atlas-home-workspace"),
      "positive control: the tree-node collector cannot see the Workspace home row either").toHaveCount(1);

    // ── CLAIM 2: no dead link points at a deleted address. ──
    await page.goto(loomDaemon.baseURL + "/home");
    await expect(page.getByTestId("atlas-band-pulse")).toBeVisible();
    const newProject = page.locator("main").getByRole("link", { name: /^New project/ });
    await expect(newProject, "the Workspace node lost its New project exit").toHaveCount(1);
    await expect(newProject, "the New project exit points at the deleted Projects page")
      .toHaveAttribute("href", "/platform");
    // The Pulse band's own exit is GONE (it is the deepest view of that feed), with the Gates band beside
    // it as the control: the same collector DOES find a band exit that survived.
    await expect(page.getByTestId("atlas-band-pulse").getByRole("link"),
      "the Pulse band still carries an exit link").toHaveCount(0);
    await expect(page.getByTestId("atlas-band-gates").getByRole("link"),
      "positive control: the band-exit collector finds no link on the Gates band either").toHaveCount(1);
    // No link anywhere on the node targets a deleted address, with a surviving exit as the control.
    const hrefs = await page.locator("main a[href]").evaluateAll((els) =>
      els.map((el) => new URL((el as HTMLAnchorElement).href).pathname));
    expect(hrefs, "positive control: the href collector did not read the New project exit").toContain("/platform");
    for (const d of DELETED) {
      expect(hrefs.filter((h) => h === d.from), `a link in the Workspace node body still targets ${d.from}`).toEqual([]);
    }

    await page.goto(loomDaemon.baseURL + "/agents");
    await expect(page.getByTestId("atlas-agents-define"), "the Agents node lost its all-projects exit").toHaveCount(1);
    await expect(page.getByTestId("atlas-agents-define"),
      "the Agents node's exit points at the deleted Projects page").toHaveAttribute("href", "/home");

    // EXERCISED, not merely read: New project really reaches the surface that absorbed project creation,
    // and that surface really offers it.
    await page.goto(loomDaemon.baseURL + "/home");
    await page.locator("main").getByRole("link", { name: /^New project/ }).click();
    await expect(page, "New project did not navigate to the Platform node").toHaveURL(/\/platform$/);
    await expect(page.getByRole("button", { name: /^Start guided setup/ }),
      "the Platform node offers no guided setup, so project creation has no home").toBeVisible();

    // ── CLAIM 3: the ⌘K palette offers none of them. ──
    const rows = await paletteRows(page);
    expect(rows.length, "the palette row collector found no page rows at all").toBeGreaterThan(5);
    expect(rows, "positive control: the palette row collector did not read the surviving Settings row")
      .toContain("Settings");
    for (const d of DELETED) {
      expect(rows, `⌘K still offers the deleted "${d.label}" destination`).not.toContain(d.label);
    }
  });
});
