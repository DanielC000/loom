// The Atlas home nodes — the Workspace root and the project node (card fd99b2d7, Atlas build plan
// P2-1: docs/plans/atlas-ui/03-decomposition.md row P2-1).
//
// The card's claims, and how each is measured against SEEDED data rather than against "something
// rendered":
//   1. The KPI deck shows REAL values. The sentinel is the project's own open-card count, derived
//      from cards this spec seeded into named lanes — a figure that can only be right if the tile
//      actually read the board, and that no amount of chrome rendering can satisfy by accident.
//   2. The embedded board is the WHOLE board: all 7 default lanes and a seeded card inside the
//      lane it was seeded into. (Owner-ruled: this embed is the primary board surface — it is never
//      a summary. See ProjectHome.tsx's own note and card c6bdf358.)
//   3. Each KPI pop-over opens AND closes, asserted on both sides of each action, so neither a
//      pop-over that never opened nor one that never closes can pass.
//   4. Both tabs are reachable at BOTH levels, and the tab is in the URL (it is a real address).
//   5. SWITCH OFF: the classic Overview still renders, and nothing Atlas exists in the document.
//
// Presence-first everywhere (card 625d791c): a leading `toHaveCount(0)` is satisfied by a page that
// is merely still loading, because a quiet DOM is not a ready one — so every pair asserts what must
// BE there first, and only then what must not.
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";

// lib/atlasUi.ts owns this key and the "1" = on encoding; lib/activeProject.tsx owns the project
// one. Hardcoded rather than imported: the e2e tsconfig covers `e2e/` only (tsconfig.e2e.json).
const ATLAS_KEY = "loom.atlasUi";
const PROJECT_KEY = "loom.projectId";

// Only ever seeded ON. Off IS the default (an empty storage key), and addInitScript re-runs on EVERY
// navigation — so a "seed off" script would silently re-clear the key mid-test (measured on P1-0).
async function seedAtlasOn(page: Page) {
  await page.addInitScript((key) => {
    try { localStorage.setItem(key, "1"); } catch { /* storage unavailable — assertions will say so */ }
  }, ATLAS_KEY);
}

// Writes only while the key is still absent: addInitScript re-runs on every navigation, `reload()`
// included, so an unconditional write would re-pin on a reload and that leg would be measuring this
// helper instead of the app (measured on P1-4).
async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([key, id]) => {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, id); } catch { /* storage unavailable */ }
  }, [PROJECT_KEY, projectId] as const);
}

const uniq = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
// `createProject` returns what the DAEMON stored, not what was asked for, so escape rather than
// assume the stored form carries no regex metacharacter (card e47df20a).
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The six tiles each node declares, by the `key` its testid is built from (components/atlasHome.tsx
// › KpiDeck). Listed here because the pop-over leg must exercise EVERY one of them — a loop over
// whatever happens to be on screen would silently shrink with the deck.
const WORKSPACE_KPIS = ["projects", "live", "needs", "gates", "plan", "merged"];
const PROJECT_KPIS = ["needs", "fleet", "context", "gates", "cards", "merged"];

/**
 * A project whose board carries a KNOWN open-card count. Three cards in three different non-terminal
 * lanes plus one in the terminal lane: the terminal card is what makes "open cards" a real
 * derivation rather than a card count — a tile that simply counted rows would read 4, not 3.
 */
async function seedProjectWithBoard(loomDaemon: LoomDaemon) {
  const project = await loomDaemon.createProject(uniq("atlashome"));
  const inboxCard = uniq("home-sentinel-INBOX");
  const reviewCard = uniq("home-sentinel-REVIEW");
  await loomDaemon.createTask(project.id, { title: inboxCard, columnKey: "inbox" });
  await loomDaemon.createTask(project.id, { title: uniq("home-sentinel-TODO"), columnKey: "todo" });
  await loomDaemon.createTask(project.id, { title: reviewCard, columnKey: "review" });
  await loomDaemon.createTask(project.id, { title: uniq("home-sentinel-DONE"), columnKey: "done" });
  // 4 cards, 3 of them outside the terminal lane.
  return { project, inboxCard, reviewCard, open: 3, inReview: 1, total: 4 };
}

// A board lane is the `.loom-grid` wrapper inside `.loom-board-grid`. Scoped through the grid so the
// band panels above (which are Panels too) can never be counted as lanes (same idiom as board.spec.ts).
const lanes = (page: Page) => page.locator(".loom-board-grid > .loom-grid");

test.describe("Atlas home nodes (card fd99b2d7)", () => {
  test("switch ON: the project node's KPI deck reads the real board, and embeds the whole board", async ({ page, loomDaemon }) => {
    const seeded = await seedProjectWithBoard(loomDaemon);
    await seedAtlasOn(page);
    await pinProject(page, seeded.project.id);
    await page.goto(loomDaemon.baseURL + "/project");

    // The frame landed on the node: the heading and the deepest crumb are the PROJECT's own name,
    // not the tree row's "Home" label and not a generic "Workspace".
    await expect(page.locator(".loom-atlas-nodehead h1")).toHaveText(new RegExp(escapeRe(seeded.project.name)));
    await expect(page.getByTestId("atlas-breadcrumb")).toContainText(seeded.project.name);

    // ── (1) THE SENTINEL. The open-card tile reads 3 — the three non-terminal cards this spec
    //        seeded — and not 4, which is what a tile that merely counted the board's rows would
    //        say. `toHaveText` retries, so this is also the settle: the figure cannot be read until
    //        the board query has actually landed.
    const cards = page.getByTestId("atlas-kpi-cards");
    await expect(cards.locator(".loom-kpi-value")).toHaveText(String(seeded.open));
    await expect(cards.locator(".loom-kpi-sub")).toHaveText(new RegExp(`${seeded.inReview} in review`));
    // The deck is the FULL-SIZE one, not the Deck tab's compact strip — the distinction round 3's
    // own diagnosis turned on (card 939922ee: size is what made the page read as an overview).
    await expect(page.getByTestId("atlas-kpi-deck")).toBeVisible();
    await expect(page.getByTestId("atlas-kpi-strip")).toHaveCount(0);
    // Every declared tile is present, so a deck that quietly lost one cannot pass the pop-over loop
    // below by simply having fewer tiles to exercise.
    for (const key of PROJECT_KPIS) await expect(page.getByTestId(`atlas-kpi-${key}`)).toBeVisible();

    // ── (2) THE WHOLE BOARD, embedded. All 7 default lanes, and a seeded card inside the lane it
    //        was seeded into — so this is the real board with its real grouping, not a card list.
    const embed = page.getByTestId("atlas-board-embed");
    await expect(embed.getByText(seeded.inboxCard, { exact: true })).toBeVisible();
    await expect(lanes(page)).toHaveCount(7);
    await expect(embed.locator(".loom-grid").filter({ hasText: "Inbox" }).getByText(seeded.inboxCard, { exact: true })).toBeVisible();

    // ── The band's second column is REAL, not a declared slot. P2-1 put a placeholder here so the
    //        owner comparing Atlas against the live app could tell "not built yet" from
    //        "deliberately dropped"; card c6160c7d filled it, so the placeholder's absence is now
    //        the correct state and the panel's presence is what this row asserts. (The other
    //        placeholder, P2-3's fleet-controls bar, lives on the WORKSPACE node — asserted the
    //        same way in the workspace-node test below, now that card 7b893d54 has filled it.)
    await expect(page.getByTestId("atlas-band-agents")).toBeVisible();
    await expect(page.getByTestId("atlas-slot-agents")).toHaveCount(0);
  });

  test("switch ON: every KPI pop-over opens and closes, at both levels", async ({ page, loomDaemon }) => {
    // 12 tiles × (open + assert + close + assert), across two node loads, is past the 30s default.
    test.setTimeout(180_000);
    const seeded = await seedProjectWithBoard(loomDaemon);
    await seedAtlasOn(page);
    await pinProject(page, seeded.project.id);

    for (const [path, keys] of [["/project", PROJECT_KPIS], ["/home", WORKSPACE_KPIS]] as const) {
      await page.goto(loomDaemon.baseURL + path);
      await expect(page.getByTestId("atlas-kpi-deck")).toBeVisible();

      for (const key of keys) {
        const tile = page.getByTestId(`atlas-kpi-${key}`);
        const pop = page.getByTestId(`atlas-kpi-pop-${key}`);

        // BEFORE: the tile is there and its pop-over is not. Presence first — a bare "no pop-over"
        // on a page that had not finished loading would pass with nothing on screen at all.
        await expect(tile).toBeVisible();
        await expect(tile).toHaveAttribute("aria-expanded", "false");
        await expect(pop).toHaveCount(0);

        await tile.click();

        // AFTER: it opened, and the tile says so to a screen reader as well as to the eye.
        await expect(pop).toBeVisible();
        await expect(tile).toHaveAttribute("aria-expanded", "true");
        // Exactly one pop-over is open at a time — the deck is single-open, so clicking a second
        // tile must not leave two breakdowns stacked over the band.
        await expect(page.locator(".loom-kpi-pop")).toHaveCount(1);

        // CLOSE, via the affordance the pop-over actually offers.
        await page.getByTestId(`atlas-kpi-close-${key}`).click();
        await expect(pop).toHaveCount(0);
        await expect(tile).toHaveAttribute("aria-expanded", "false");
      }

      // Escape closes too — the keyboard path, not just the mouse one.
      const first = page.getByTestId(`atlas-kpi-${keys[0]}`);
      await first.click();
      await expect(page.getByTestId(`atlas-kpi-pop-${keys[0]}`)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId(`atlas-kpi-pop-${keys[0]}`)).toHaveCount(0);
    }
  });

  test("switch ON: both tabs are reachable at both levels, and the tab is a real address", async ({ page, loomDaemon }) => {
    const seeded = await seedProjectWithBoard(loomDaemon);
    await seedAtlasOn(page);
    await pinProject(page, seeded.project.id);

    for (const path of ["/project", "/home"]) {
      await page.goto(loomDaemon.baseURL + path);

      // Overview is the default landing — no `?tab=` needed, and the full deck is what shows.
      await expect(page.getByTestId("atlas-tab-overview")).toHaveAttribute("aria-selected", "true");
      await expect(page.getByTestId("atlas-kpi-deck")).toBeVisible();
      await expect(page.getByTestId("atlas-kpi-strip")).toHaveCount(0);

      await page.getByTestId("atlas-tab-deck").click();

      // The Deck tab swapped the readouts for the compact strip — presence of the strip first, and
      // only then the deck's absence, so a mid-render page cannot satisfy this pair.
      await expect(page.getByTestId("atlas-kpi-strip")).toBeVisible();
      await expect(page.getByTestId("atlas-kpi-deck")).toHaveCount(0);
      await expect(page.getByTestId("atlas-tab-deck")).toHaveAttribute("aria-selected", "true");
      await expect(page.getByTestId("atlas-tab-overview")).toHaveAttribute("aria-selected", "false");
      // It is an ADDRESS, not component state: the tab is in the URL, and the path did not move.
      await expect(page).toHaveURL(new RegExp(`${path}\\?tab=deck$`));

      // Which means a reload lands back on it rather than snapping to the default tab.
      await page.reload();
      await expect(page.getByTestId("atlas-tab-deck")).toHaveAttribute("aria-selected", "true");
      await expect(page.getByTestId("atlas-kpi-strip")).toBeVisible();

      await page.getByTestId("atlas-tab-overview").click();
      await expect(page.getByTestId("atlas-kpi-deck")).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
    }

    // The project Deck keeps the WHOLE board too — the board-first tab is the one place a trimmed
    // board would be most tempting, so it is asserted there as well as on Overview.
    await page.goto(loomDaemon.baseURL + "/project?tab=deck");
    await expect(page.getByTestId("atlas-board-embed").getByText(seeded.inboxCard, { exact: true })).toBeVisible();
    await expect(lanes(page)).toHaveCount(7);
  });

  test("switch ON: both home nodes are reachable from the tree, and the workspace grid names the project", async ({ page, loomDaemon }) => {
    const seeded = await seedProjectWithBoard(loomDaemon);
    await seedAtlasOn(page);
    await pinProject(page, seeded.project.id);
    await page.goto(loomDaemon.baseURL + "/home");

    const tree = page.getByTestId("atlas-tree");
    await expect(tree.getByTestId("atlas-home-workspace")).toBeVisible();
    await expect(tree.getByTestId("atlas-home-project")).toBeVisible();
    // The workspace home is the landed node, and only it.
    await expect(tree.getByTestId("atlas-home-workspace")).toHaveClass(/is-active/);
    await expect(tree.getByTestId("atlas-home-project")).not.toHaveClass(/is-active/);
    // The trail stops at the tier — "Workspace", not "Workspace / Home".
    await expect(page.locator(".loom-atlas-nodehead h1")).toHaveText("Workspace");

    // ── P2-1's LAST declared slot is now REAL. Same rule as the Agents panel on the project node:
    //        card 7b893d54 filled the fleet-controls placeholder, so the bar's presence AND the
    //        slot's absence are both the correct state. The pair is falsifiable in both directions —
    //        reverting that card restores a SlotPanel rendering exactly this test id, which is what
    //        the failure state actually looks like.
    await expect(page.getByTestId("atlas-fleet-controls-bar")).toBeVisible();
    await expect(page.getByTestId("atlas-slot-fleet-controls")).toHaveCount(0);

    // The grid is the workspace node's primary surface, and it carries this project's REAL board
    // figure — the same 3 the project node's own tile reads, from the same shared cache entry.
    const card = page.getByTestId(`atlas-project-card-${seeded.project.id}`);
    await expect(card).toBeVisible();
    await expect(card).toContainText(seeded.project.name);
    await expect(card).toContainText(`${seeded.open} open cards`);

    // Clicking a project card both SELECTS it and opens its node — one ActiveProjectProvider, so
    // the project node that opens is the one that was clicked.
    await card.click();
    await expect(page).toHaveURL(/\/project$/);
    await expect(page.locator(".loom-atlas-nodehead h1")).toHaveText(new RegExp(escapeRe(seeded.project.name)));

    // And the project home node in the tree is now the landed one.
    await expect(tree.getByTestId("atlas-home-project")).toHaveClass(/is-active/);
  });

  test("switch OFF: the classic Overview is untouched and nothing Atlas is mounted", async ({ page, loomDaemon }) => {
    const seeded = await seedProjectWithBoard(loomDaemon);
    // Deliberately NO seedAtlasOn — off is the default, and seeding it off would re-clear the key on
    // every navigation for a reason unrelated to the app (measured on P1-0).
    await pinProject(page, seeded.project.id);
    await page.goto(loomDaemon.baseURL + "/overview");

    // PRESENCE first: the classic shell and the classic Overview's own board embed are really here.
    await expect(page.locator(".loom-rail")).toBeVisible();
    await expect(page.getByText(seeded.inboxCard, { exact: true })).toBeVisible();
    await expect(lanes(page)).toHaveCount(7);

    // …and nothing this card built reached the shell a user who never opted in is looking at.
    await expect(page.getByTestId("atlas-shell")).toHaveCount(0);
    await expect(page.getByTestId("atlas-kpi-deck")).toHaveCount(0);
    await expect(page.getByTestId("atlas-node-tabs")).toHaveCount(0);
    await expect(page.locator(".loom-kpi, .loom-projcard, .loom-bandpanel")).toHaveCount(0);

    // The Atlas-only addresses are not mounted in the classic shell either (ATLAS_HOMES is the one
    // declaration in nav.tsx LegacyShell deliberately does not map — @decision fd99b2d7).
    await page.goto(loomDaemon.baseURL + "/project");
    await expect(page.locator(".loom-rail")).toBeVisible();
    await expect(page.getByTestId("atlas-kpi-deck")).toHaveCount(0);
    await expect(page.getByTestId("atlas-board-embed")).toHaveCount(0);
  });
});
