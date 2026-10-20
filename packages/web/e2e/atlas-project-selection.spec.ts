// Atlas project selection (card e47df20a, Atlas build plan P1-4 —
// docs/plans/atlas-ui/03-decomposition.md row P1-4).
//
// The card's claim: selecting a project node in the tree sets ActiveProjectProvider's active
// project — the SAME context the rail chip writes and every `scoped` page reads — so a page you
// already have open re-scopes exactly as it did under the chip. Two claims, each measured against
// the page's OWN project-scoped data rather than against "the frame re-rendered":
//   1. SWITCH ON. With /board open on project A's only card, clicking project B's tree row replaces
//      it with project B's only card, moves the tree's open branch and the breadcrumb with it, and
//      leaves the URL alone — selecting a project re-scopes, it does not navigate.
//   2. SWITCH OFF. The rail chip still switches projects the old way, with no Atlas frame mounted.
//
// Both polarities are asserted on BOTH sides of the click (A present + B absent, then B present +
// A absent), so neither direction can pass vacuously: a sentinel that never rendered at all would
// satisfy a one-sided "the other project's card is gone" check by itself. Within each pair the
// PRESENCE assertion comes FIRST, because that is the one that retries until the board's data has
// actually landed — a leading `toHaveCount(0)` is satisfied by a page that is still loading, since
// a quiet DOM is not a ready one (card 625d791c).
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";

// lib/atlasUi.ts owns this key and the "1" = on encoding; lib/activeProject.tsx owns the project
// one. Hardcoded rather than imported: the e2e tsconfig covers `e2e/` only (tsconfig.e2e.json), so
// a spec cannot pull a `src/` module in — the same reason fixtures/daemon.ts hardcodes its own.
const ATLAS_KEY = "loom.atlasUi";
const PROJECT_KEY = "loom.projectId";

// Only ever seeded ON. Off IS the default (an empty storage key), and addInitScript re-runs on EVERY
// navigation — so a "seed off" script would silently re-clear the key mid-test (measured on P1-0).
async function seedAtlasOn(page: Page) {
  await page.addInitScript((key) => {
    try { localStorage.setItem(key, "1"); } catch { /* storage unavailable — assertions will say so */ }
  }, ATLAS_KEY);
}

// Pins the STARTING project, once — it writes only when the key is still absent. addInitScript
// re-runs on every navigation, `reload()` included, so an unconditional write would re-pin the
// starting project on the reload leg below and that leg would be measuring this helper's own
// behaviour instead of whether the app persisted the tree's selection. (The same mechanism, in its
// other polarity, is why the Atlas switch is only ever seeded ON — measured on P1-0.)
async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([key, id]) => {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, id); } catch { /* storage unavailable */ }
  }, [PROJECT_KEY, projectId] as const);
}

const uniq = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// Names go into regexes below, and `createProject` hands back whatever the daemon stored rather
// than what was asked for — so escape rather than assume the stored form is metacharacter-free.
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Two projects, each holding exactly ONE board card whose title only that project has. The card
 * title is the sentinel: it comes from the page's own project-scoped read, so it can only be
 * satisfied by the board genuinely re-scoping, never by the shell redrawing around it.
 *
 * ⚠️ The project names deliberately share no stem with the card titles, nor with each other beyond
 * a common prefix. Playwright's `getByText`/`hasText` matching is substring + case-insensitive, and
 * it has hijacked a locator on this suite before when a project's name contained the string the
 * spec was really looking for (card 921e06b0).
 */
async function seedTwoProjects(loomDaemon: LoomDaemon) {
  const first = await loomDaemon.createProject(uniq("atlassel-alpha"));
  const second = await loomDaemon.createProject(uniq("atlassel-bravo"));
  const firstCard = uniq("sentinel-ONE");
  const secondCard = uniq("sentinel-TWO");
  await loomDaemon.createTask(first.id, { title: firstCard, columnKey: "inbox" });
  await loomDaemon.createTask(second.id, { title: secondCard, columnKey: "inbox" });
  return { first, second, firstCard, secondCard };
}

test.describe("Atlas project selection (card e47df20a)", () => {
  test("switch ON: selecting a project node re-scopes the page already open", async ({ page, loomDaemon }) => {
    const { first, second, firstCard, secondCard } = await seedTwoProjects(loomDaemon);
    // A live session on the SECOND project only, so the project row's live marker has both
    // polarities to be measured against on one screen rather than an unfalsifiable single reading.
    await loomDaemon.seedLiveSession({ project: second, role: "manager", agentName: "AtlasSelMgr" });

    await seedAtlasOn(page);
    await pinProject(page, first.id);
    await page.goto(loomDaemon.baseURL + "/board");

    const tree = page.getByTestId("atlas-tree");
    await expect(tree).toBeVisible();
    // Rows are addressed by a REGEX, not an exact string: a project with a live session contributes
    // its count to the row's accessible name ("<project> 1"), exactly as the rail chip's own
    // dropdown rows do — so an exact match would resolve for one project and not the other for a
    // reason that has nothing to do with selection.
    const row = (name: string) => tree.getByRole("button", { name: new RegExp(escapeRe(name)) });
    // `atlas-project-node` marks the OPEN row only, so this locator IS "the project you are under".
    const openProject = page.getByTestId("atlas-project-node");
    const crumbs = page.getByTestId("atlas-breadcrumb");
    const card = (title: string) => page.getByText(title, { exact: true });

    // ── BEFORE: the board is on the first project, and the frame agrees ──
    await expect(card(firstCard)).toBeVisible();
    await expect(card(secondCard)).toHaveCount(0);
    await expect(openProject).toContainText(first.name);
    await expect(crumbs).toContainText(first.name);
    // Exactly one branch is open — a second open row would mean the tree had its own idea of scope.
    await expect(tree.locator("button.loom-atlas-node.is-branch.is-open")).toHaveCount(1);

    // The live marker sits on the project that HAS the live session, and only there.
    await expect(row(second.name).getByTitle(/1 live session/)).toBeVisible();
    await expect(row(first.name).getByTitle(/live session/)).toHaveCount(0);

    // ── THE CLICK: the control this card adds, exercised ──
    const urlBefore = page.url();
    await row(second.name).click();

    // ── AFTER: the same open page, re-scoped ──
    await expect(card(secondCard)).toBeVisible();
    await expect(card(firstCard)).toHaveCount(0);
    await expect(openProject).toContainText(second.name);
    await expect(crumbs).toContainText(second.name);
    await expect(tree.locator("button.loom-atlas-node.is-branch.is-open")).toHaveCount(1);
    await expect(row(second.name)).toHaveAttribute("aria-current", "true");
    await expect(row(first.name)).not.toHaveAttribute("aria-current", "true");

    // Selection RE-SCOPES; it does not navigate. (A tree row that changed the address would make
    // the project node a destination, which is P2-1's job, not this card's.)
    expect(page.url(), "selecting a project changed the address").toBe(urlBefore);

    // And it wrote the one store ActiveProjectProvider persists to — the same key the rail chip
    // writes, not an Atlas-only copy that would be lost on reload or disagree with the classic UI.
    expect(await page.evaluate((k) => localStorage.getItem(k), PROJECT_KEY)).toBe(second.id);

    // Which a reload proves, rather than inferring it from the key: the selection survives, so the
    // scoped page comes back on the project the tree was left on.
    await page.reload();
    await expect(card(secondCard)).toBeVisible();
    await expect(card(firstCard)).toHaveCount(0);
    await expect(openProject).toContainText(second.name);
  });

  test("switch OFF: the rail chip still switches projects the old way", async ({ page, loomDaemon }) => {
    const { first, second, firstCard, secondCard } = await seedTwoProjects(loomDaemon);

    await pinProject(page, first.id);
    await page.goto(loomDaemon.baseURL + "/board");

    // The classic shell, and provably not the Atlas one — otherwise this test could pass while
    // measuring the very frame it exists to prove was left alone.
    await expect(page.locator(".loom-rail")).toBeVisible();
    await expect(page.getByTestId("atlas-tree")).toHaveCount(0);

    const card = (title: string) => page.getByText(title, { exact: true });
    await expect(card(firstCard)).toBeVisible();
    await expect(card(secondCard)).toHaveCount(0);

    // The chip, unchanged: trigger → listbox → option, the flow project-picker.spec.ts pins. Located
    // by its own class rather than by role+name, so what is asserted untouched is unmistakably the
    // old rail control and never, say, a same-named option inside the menu it opens.
    const chip = page.locator("button.loom-rail-proj");
    await expect(chip).toContainText(first.name);
    await chip.click();

    const menu = page.getByRole("listbox");
    await expect(menu).toBeVisible();
    await menu.getByRole("option", { name: new RegExp(escapeRe(second.name)) }).click();
    await expect(menu).toHaveCount(0);

    await expect(card(secondCard)).toBeVisible();
    await expect(card(firstCard)).toHaveCount(0);
    await expect(chip).toContainText(second.name);
  });
});
