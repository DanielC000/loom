// The owner's 2026-11-11 Atlas tidy (card 291cc8aa, intake 361516a4), one test per item:
//   1. "from the agent card on a project Agent Tab i want you to remove the "gen 487 · 103 turns 23%
//      context" from the cards." The Launch Bay card on the project's Agents tab draws no vitals strip.
//   2. "left menu Bar ... right next to "Projects" I want you to add a small icon that allows users to
//      add a new project." A `+` beside the tree's Projects heading opens the existing guided setup
//      wizard, the same one the Platform node launches.
//   4. "make inbox and gates pages own menu points under Workspace." Inbox and Gates rows in the tree's
//      Workspace group open the Workspace node's own tabs and read as landed there.
//
// ⛔ NO REAL SPAWN. Live sessions come from `seedLiveSession` (a DB row, no pty). The wizard is only
// opened and closed here, never applied: setup-wizard.spec.ts owns the apply path.
//
// Presence-first everywhere (card 625d791c): every absence is paired with a presence on the same
// element or its neighbour, so a page that is still loading cannot satisfy it.
import { expect, test, type Page } from "./fixtures/daemon";
import { openNodeTab } from "./helpers/nodeTabs";

// lib/activeProject.tsx owns this key. Hardcoded: the e2e tsconfig covers `e2e/` only.
const PROJECT_KEY = "loom.projectId";

async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([key, id]) => {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, id); } catch { /* storage unavailable */ }
  }, [PROJECT_KEY, projectId] as const);
}

const uniq = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test.describe("Atlas nav tidy (card 291cc8aa)", () => {
  test("item 1: an Agents-tab card for a LIVE agent carries no gen · turns · context strip", async ({ page, loomDaemon }) => {
    test.setTimeout(90_000);
    const project = await loomDaemon.createProject(uniq("navtidy-agents"));
    // A measured context reading is what the removed strip used to draw on the right, so seed one: a
    // card that dropped the strip only because it had nothing to say would pass without it.
    const live = await loomDaemon.seedLiveSession({
      project, agentName: uniq("Lantern"), model: "claude-opus-4-8", ctxInputTokens: 46_000,
    });
    await pinProject(page, project.id);
    await page.goto(loomDaemon.baseURL + "/project");
    await openNodeTab(page, "agents");

    const card = page.getByTestId(`atlas-agent-card-${live.agentId}`);
    // Presence first: the card is there and knows its agent is live (the status pill the strip sat under).
    await expect(card).toBeVisible();
    await expect(card.getByText(live.agentName, { exact: true })).toBeVisible();
    await expect(card.getByText(/^live$/i)).toBeVisible();
    // The strip itself, by its own old test id and by what it printed.
    await expect(card.getByTestId(`atlas-agent-vitals-${live.agentId}`)).toHaveCount(0);
    await expect(card).not.toContainText(/% context/);
    await expect(card).not.toContainText(/\bgen \d+/);
    await expect(card).not.toContainText(/\d+ turns?\b/);
  });

  test("item 2: the Projects heading's + opens the guided setup wizard and closes back to the tree", async ({ page, loomDaemon }) => {
    test.setTimeout(90_000);
    const project = await loomDaemon.createProject(uniq("navtidy-newproj"));
    await pinProject(page, project.id);
    await page.goto(loomDaemon.baseURL + "/home");

    const tree = page.getByTestId("atlas-tree");
    const plus = tree.getByTestId("atlas-new-project");
    await expect(plus).toBeVisible();
    await expect(plus).toHaveAccessibleName("New project");
    await expect(plus).toHaveAttribute("title", "New project");
    // The SAME control the project rows teach: identical class, and the same drawn box size as the
    // row `+` beside the pinned project, measured rather than assumed.
    const rowPlus = tree.getByTestId(`atlas-project-quickspawn-${project.id}-open`);
    await expect(rowPlus).toBeVisible();
    await expect(plus).toHaveClass(/\bloom-atlas-plus\b/);
    const [a, b] = [await plus.boundingBox(), await rowPlus.boundingBox()];
    expect(a && b, "could not measure the two + controls").toBeTruthy();
    expect(Math.round(a!.width)).toBe(Math.round(b!.width));
    expect(Math.round(a!.height)).toBe(Math.round(b!.height));
    // ...and it stands in the same column as the row `+` under it.
    expect(Math.abs((a!.x + a!.width) - (b!.x + b!.width)), "the heading + is not aligned with the row +").toBeLessThanOrEqual(1);

    const wizard = page.getByRole("dialog", { name: "Set up a new project" });
    await expect(wizard).toHaveCount(0);
    await plus.click();
    await expect(wizard).toBeVisible();
    // The existing flow, not a new one: its empty-project path is on the first screen.
    await expect(wizard.getByRole("button", { name: /Start with an empty project/ })).toBeVisible();
    // Nothing navigated: the + opens an overlay over the page you were on.
    await expect(page).toHaveURL(/\/home$/);
    await wizard.getByRole("button", { name: "Close setup" }).click();
    await expect(wizard).toHaveCount(0);
    await expect(plus).toBeVisible();
  });

  test("item 2 at phone width: the + is in the drawer and the wizard opens over the page", async ({ page, loomDaemon }) => {
    test.setTimeout(90_000);
    const project = await loomDaemon.createProject(uniq("navtidy-phone"));
    await pinProject(page, project.id);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(loomDaemon.baseURL + "/home");

    const toggle = page.getByTestId("atlas-tree-toggle");
    await expect(toggle).toBeVisible();
    await toggle.click();
    const plus = page.getByTestId("atlas-new-project");
    await expect(plus).toBeVisible();
    await plus.click();
    const wizard = page.getByRole("dialog", { name: "Set up a new project" });
    await expect(wizard).toBeVisible();
    // Portalled out of the translated drawer: it covers the viewport rather than the drawer's box.
    const box = await wizard.boundingBox();
    expect(box && box.width, "the wizard is clipped to the drawer").toBeGreaterThanOrEqual(380);
    await wizard.getByRole("button", { name: "Close setup" }).click();
    await expect(wizard).toHaveCount(0);
  });

  test("item 4: Inbox and Gates are Workspace rows that open their tabs and read as landed there", async ({ page, loomDaemon }) => {
    test.setTimeout(90_000);
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: uniq("Harbor") });
    // One waiting request, so the Inbox row has a figure to agree with the tab about.
    await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: mgr.projectId, type: "decision",
      title: uniq("Pick a release window"), options: ["Tuesday", "Thursday"],
    });
    await pinProject(page, mgr.projectId);
    await page.goto(loomDaemon.baseURL + "/home");

    const tree = page.getByTestId("atlas-tree");
    const home = tree.getByTestId("atlas-home-workspace");
    const inbox = tree.getByTestId("atlas-workspace-tab-inbox");
    const gates = tree.getByTestId("atlas-workspace-tab-gates");

    // The Workspace group, in order: Home, Terminals, Inbox, Gates, Platform.
    const tier = await tree.locator("ul.loom-atlas-nodes").first().locator("> li a.loom-atlas-node")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")));
    expect(tier).toEqual([
      "atlas-home-workspace", "atlas-home-workspace-terminals",
      "atlas-workspace-tab-inbox", "atlas-workspace-tab-gates", "atlas-node-/platform",
    ]);
    await expect(inbox).toHaveAttribute("href", "/home?tab=inbox");
    await expect(gates).toHaveAttribute("href", "/home?tab=gates");

    // On Overview, Home is the landed row and neither new row is.
    await expect(home).toHaveClass(/is-active/);
    await expect(inbox).not.toHaveClass(/is-active/);

    // Inbox: the click opens the node's own Inbox tab, the row reads landed, Home does not.
    await inbox.click();
    await expect(page).toHaveURL(/\/home\?tab=inbox$/);
    await expect(page.getByTestId("atlas-tab-inbox")).toHaveAttribute("aria-selected", "true");
    await expect(inbox).toHaveClass(/is-active/);
    await expect(inbox).toHaveAttribute("aria-current", "page");
    await expect(home).not.toHaveClass(/is-active/);
    await expect(home).not.toHaveAttribute("aria-current", "page");
    await expect(tree.locator("a.loom-atlas-node.is-active")).toHaveCount(1);
    // The row's figure is the tab's own figure: the same population, read off the same cache.
    const tabCount = (await page.getByTestId("atlas-tab-inbox").locator(".loom-atlas-tabcount").textContent())?.trim();
    expect(Number(tabCount), "the Inbox tab shows no count for the seeded request").toBeGreaterThan(0);
    await expect(inbox.locator(".loom-atlas-nodebadge")).toHaveText(tabCount!);

    // Gates: same, and the tabs stay on the Workspace node.
    await gates.click();
    await expect(page).toHaveURL(/\/home\?tab=gates$/);
    await expect(page.getByTestId("atlas-tab-gates")).toHaveAttribute("aria-selected", "true");
    await expect(gates).toHaveClass(/is-active/);
    await expect(inbox).not.toHaveClass(/is-active/);
    await expect(home).not.toHaveClass(/is-active/);
    await expect(tree.locator("a.loom-atlas-node.is-active")).toHaveCount(1);

    // Any OTHER Workspace tab still marks Home, as it always has.
    await openNodeTab(page, "usage");
    await expect(page).toHaveURL(/\/home\?tab=usage/);
    await expect(home).toHaveClass(/is-active/);
    await expect(gates).not.toHaveClass(/is-active/);
  });

  test("item 4 at phone width: the drawer carries Inbox and Gates and closes on navigating", async ({ page, loomDaemon }) => {
    test.setTimeout(90_000);
    const project = await loomDaemon.createProject(uniq("navtidy-phone-tabs"));
    await pinProject(page, project.id);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(loomDaemon.baseURL + "/home");

    const toggle = page.getByTestId("atlas-tree-toggle");
    await toggle.click();
    const gates = page.getByTestId("atlas-workspace-tab-gates");
    await expect(page.getByTestId("atlas-workspace-tab-inbox")).toBeVisible();
    await expect(gates).toBeVisible();
    await gates.click();
    await expect(page).toHaveURL(/\/home\?tab=gates$/);
    await expect(gates, "the drawer stayed open over the page it navigated to").toBeHidden();
  });
});
