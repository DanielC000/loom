// The Atlas home nodes — the Workspace root and the project node (card fd99b2d7, Atlas build plan
// P2-1: docs/plans/atlas-ui/03-decomposition.md row P2-1).
//
// The card's claims, and how each is measured against SEEDED data rather than against "something
// rendered":
//   1. The node's readout shows REAL values. The sentinel is the project's own open-card count,
//      derived from cards this spec seeded into named lanes — a figure that can only be right if
//      the readout actually read the board, and that no chrome rendering can satisfy by accident.
//      🔴 Card 269f46ef moved that readout: the project node's KPI deck is gone (with the board
//      embed and the band) and a BRIEFING LINE carries its figures. The sentinel is the same
//      derivation, read off `atlas-brief-cards`.
//   2. The WHOLE board — all 7 default lanes and a seeded card inside the lane it was seeded into —
//      is on the node's Board TAB. It used to be embedded in the Overview under a standing owner
//      directive (card c6bdf358); the owner then instructed "Remove Board." on card 269f46ef, so
//      this leg asserts BOTH halves: no board on the home tab, and the whole board one tab over.
//   3. Each KPI pop-over opens AND closes, asserted on both sides of each action, so neither a
//      pop-over that never opened nor one that never closes can pass. Workspace node only now; the
//      project node's briefing pop-overs get the same treatment in atlas-project-overview.spec.ts.
//   4. BOTH nodes have exactly ONE home tab — card 44f725fe unified the project node's Overview and
//      Deck, card 4a0ad464 the Workspace node's. Each gets its own leg (same shape, different
//      content): the Deck tab is gone, no tab-row KPI strip exists, and a legacy `?tab=deck` lands
//      on Overview in place, with nothing dropped.
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

// The six tiles the WORKSPACE node declares, by the `key` its testid is built from
// (components/atlasHome.tsx › KpiDeck). Listed here because the pop-over leg must exercise EVERY
// one of them — a loop over whatever happens to be on screen would silently shrink with the deck.
// (The project node declared six of its own until card 269f46ef removed its deck; its readings are
// a briefing line now, exercised in atlas-project-overview.spec.ts.)
const WORKSPACE_KPIS = ["projects", "live", "needs", "gates", "plan", "merged"];

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
  test("switch ON: the project node's briefing line reads the real board, and the board itself is on its own tab", async ({ page, loomDaemon }) => {
    const seeded = await seedProjectWithBoard(loomDaemon);
    await seedAtlasOn(page);
    await pinProject(page, seeded.project.id);
    await page.goto(loomDaemon.baseURL + "/project");

    // The frame landed on the node: the heading and the deepest crumb are the PROJECT's own name,
    // not the tree row's "Home" label and not a generic "Workspace".
    await expect(page.locator(".loom-atlas-nodehead h1")).toHaveText(new RegExp(escapeRe(seeded.project.name)));
    await expect(page.getByTestId("atlas-breadcrumb")).toContainText(seeded.project.name);

    // ── (1) THE SENTINEL, unchanged in substance and re-pointed at the reading that carries it
    //        since card 269f46ef. The board reading says 3 — the three non-terminal cards this spec
    //        seeded — and not 4, which is what a readout that merely counted the board's rows would
    //        say. `toHaveText` retries, so this is also the settle: the figure cannot be read until
    //        the board query has actually landed.
    const boardReading = page.getByTestId("atlas-brief-cards");
    await expect(boardReading.locator(".loom-ovbrief-n")).toHaveText(String(seeded.open));
    await expect(boardReading.locator(".loom-ovbrief-v em")).toHaveText(new RegExp(`${seeded.inReview} review`));
    // …and the lane strip states the same board a second way, per lane, so the reading above cannot
    // be a hardcoded figure: the Review lane's chip carries the count the sub-line just claimed.
    await expect(page.getByTestId("atlas-overview-lane-review")).toContainText(String(seeded.inReview));

    // ── (2) THE DECK AND THE EMBED ARE BOTH GONE FROM THIS TAB (card 269f46ef — the owner's own
    //        instruction, "Remove Board." plus the direction-C pick). Presence first: the node's new
    //        primary surface is on screen, so these zeros are a loaded page's real shape.
    await expect(page.getByTestId("atlas-overview-roster")).toBeVisible();
    await expect(page.getByTestId("atlas-kpi-deck")).toHaveCount(0);
    await expect(page.getByTestId("atlas-kpi-strip")).toHaveCount(0);
    await expect(page.getByTestId("atlas-board-embed")).toHaveCount(0);
    await expect(page.getByTestId("atlas-dashboard-band")).toHaveCount(0);
    await expect(lanes(page), "no board grid is mounted on the home tab at all").toHaveCount(0);

    // ── (3) THE WHOLE BOARD IS STILL THERE, on the node's Board tab — the claim this leg always
    //        made, now asserted where it lives. All 7 default lanes and a seeded card inside the
    //        lane it was seeded into, so this is the real board with its real grouping; it is also
    //        the positive control for the `lanes(page) === 0` above.
    await page.goto(loomDaemon.baseURL + "/board");
    await expect(page.getByText(seeded.inboxCard, { exact: true })).toBeVisible();
    await expect(lanes(page)).toHaveCount(7);
    await expect(page.locator(".loom-grid").filter({ hasText: "Inbox" })
      .getByText(seeded.inboxCard, { exact: true })).toBeVisible();

    // ── (4) THE AGENTS PANEL IS GONE from the home tab, and its placeholder has not come back in
    //        its place. P2-1 put a placeholder here so the owner could tell "not built yet" from
    //        "deliberately dropped"; card c6160c7d filled it with the real roster, and card
    //        269f46ef removed the panel on the owner's instruction — the roster rows themselves are
    //        unchanged on the Agents tab, which `atlas-agents.spec.ts` asserts.
    await page.goto(loomDaemon.baseURL + "/project");
    await expect(page.getByTestId("atlas-overview-roster")).toBeVisible();
    await expect(page.getByTestId("atlas-band-agents")).toHaveCount(0);
    await expect(page.getByTestId("atlas-slot-agents")).toHaveCount(0);
  });

  // ⚠️ ONE LEVEL NOW, NOT TWO (card 269f46ef): the project node's deck is gone, so this loop runs
  // on the Workspace node alone. The project node's own readings are a briefing line whose
  // pop-overs are opened and closed by the same before/after pairs in
  // `atlas-project-overview.spec.ts` — the claim moved with the rendering, it was not dropped.
  test("switch ON: every KPI pop-over opens and closes on the Workspace node", async ({ page, loomDaemon }) => {
    // 6 tiles × (open + assert + close + assert) is past the 30s default.
    test.setTimeout(180_000);
    const seeded = await seedProjectWithBoard(loomDaemon);
    await seedAtlasOn(page);
    await pinProject(page, seeded.project.id);

    for (const [path, keys] of [["/home", WORKSPACE_KPIS]] as const) {
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

  // ⭐ CARD 4a0ad464's part C, the WORKSPACE half of the unification card 44f725fe did for the project
  // node. RED on the pre-card build: a `Deck` tab was rendered, it was selectable, and `?tab=deck`
  // resolved to it rather than falling back. Deliberately NOT folded back into a loop over both
  // nodes — the shapes are the same now, but the two nodes' CONTENT is not, and a shared loop would
  // stop checking either one for what it actually is (the same reason card 44f725fe split it).
  test("switch ON: the Workspace node has ONE home tab, and a legacy ?tab=deck lands on it", async ({ page, loomDaemon }) => {
    const seeded = await seedProjectWithBoard(loomDaemon);
    await seedAtlasOn(page);
    await pinProject(page, seeded.project.id);
    await page.setViewportSize({ width: 1440, height: 1000 });

    const path = "/home";
    await page.goto(loomDaemon.baseURL + path);

    // Overview is the node's only home tab, and the full-size deck is its readout.
    await expect(page.getByTestId("atlas-tab-overview")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("atlas-kpi-deck")).toBeVisible();
    // The Deck tab is GONE — asserted AFTER a locator that must be present, so a page that merely
    // has not rendered its tab row yet cannot satisfy it. The row holds every tab at this width
    // (card 4a0ad464 removed the KPI strip that used to push some into the menu), so there is no
    // More menu hiding it; pinned explicitly, because a tab folded into a closed menu is absent
    // from the DOM too.
    await expect(page.getByTestId("atlas-node-tabs-more"),
      "the workspace tab row overflowed, so 'the Deck tab is absent' no longer means it was removed")
      .toHaveCount(0);
    await expect(page.getByTestId("atlas-tab-deck")).toHaveCount(0);
    // ...and the tab-row chips went with it (part A of the same card).
    await expect(page.getByTestId("atlas-kpi-strip")).toHaveCount(0);

    // A bookmarked or pasted `?tab=deck` is an unrecognised home tab now, and the node resolves it
    // to Overview rather than rendering a blank body. NO LEGACY_REDIRECTS row does this — the
    // address does not move, which is exactly how it stays invisible to the classic shell.
    await page.goto(loomDaemon.baseURL + path + "?tab=deck");
    await expect(page.getByTestId("atlas-tab-overview")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("atlas-kpi-deck")).toBeVisible();
    await expect(page, "the node redirected instead of resolving the unknown tab in place")
      .toHaveURL(new RegExp(`${path}\\?tab=deck$`));

    // ⭐ NOTHING WAS DROPPED (the D1 rule). The retired Deck tab's one unique line — its open-card
    // total across every project — is on the unified tab, under the grid.
    await expect(page.getByTestId("atlas-grid-foot")).toContainText("open card");
    await expect(page.getByTestId(`atlas-project-card-${seeded.project.id}`)).toBeVisible();
    // ...as is the band, and the fleet-controls bar the Deck tab never had.
    await expect(page.getByTestId("atlas-dashboard-band")).toBeVisible();
    await expect(page.getByTestId("atlas-fleet-controls-bar")).toBeVisible();
  });

  test("switch ON: the project node has ONE home tab, and a legacy ?tab=deck lands on it", async ({ page, loomDaemon }) => {
    const seeded = await seedProjectWithBoard(loomDaemon);
    await seedAtlasOn(page);
    await pinProject(page, seeded.project.id);
    await page.goto(loomDaemon.baseURL + "/project");
    await expect(page.getByTestId("atlas-project-name")).toHaveText(seeded.project.name);

    // Overview is the node's only home tab. Its readout was the full-size deck until card 269f46ef
    // replaced the whole composition; the briefing line plus the roster identify the tab now.
    await expect(page.getByTestId("atlas-tab-overview")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("atlas-overview-brief")).toBeVisible();
    // The Deck tab is GONE — asserted AFTER a locator that must be present, so a page that merely
    // has not rendered its tab row yet cannot satisfy it. The row holds every tab at this width
    // (card 44f725fe took one off a row that already fit ten), so there is no More menu hiding it;
    // pinned explicitly, because a tab folded into a closed menu is absent from the DOM too.
    await expect(page.getByTestId("atlas-node-tabs-more"),
      "the project tab row overflowed, so 'the Deck tab is absent' no longer means it was removed")
      .toHaveCount(0);
    await expect(page.getByTestId("atlas-tab-deck")).toHaveCount(0);

    // A bookmarked or pasted `?tab=deck` is an unrecognised home tab now, and the node resolves it
    // to Overview rather than rendering a blank body — the briefing line and the roster are
    // showing, and the compact strip (which the Deck tab used to own) is not.
    //
    // ⚠️ The board is no longer part of this assertion, because it is no longer part of this tab
    // (card 269f46ef). That is a real reduction in what this leg witnesses: it used to prove the
    // fallback landed on a tab with the WHOLE board on it. The fallback itself — `projectNodeTabAt`
    // resolving an unrecognised key to `PROJECT_NODE_TABS[0]` — is what the leg is for, and it is
    // still asserted by `aria-selected` plus the two surfaces only the Overview renders.
    await page.goto(loomDaemon.baseURL + "/project?tab=deck");
    await expect(page.getByTestId("atlas-tab-overview")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("atlas-overview-brief")).toBeVisible();
    await expect(page.getByTestId("atlas-overview-roster")).toBeVisible();
    await expect(page.getByTestId("atlas-kpi-strip")).toHaveCount(0);
    await expect(lanes(page)).toHaveCount(0);
  });

  test("switch ON: both home nodes are reachable from the tree, and the workspace grid names the project", async ({ page, loomDaemon }) => {
    const seeded = await seedProjectWithBoard(loomDaemon);
    await seedAtlasOn(page);
    await pinProject(page, seeded.project.id);
    await page.goto(loomDaemon.baseURL + "/home");

    const tree = page.getByTestId("atlas-tree");
    await expect(tree.getByTestId("atlas-home-workspace")).toBeVisible();
    // ⛔ THE PROJECT TIER HAS NO `Home` ROW (card 4a0ad464) — its node is reached by the project row
    // itself, which is asserted below. The absence is checked AFTER a row that must be present, so a
    // tree that merely has not rendered cannot satisfy it.
    await expect(tree.getByTestId("atlas-home-project")).toHaveCount(0);
    // The workspace home is the landed node.
    await expect(tree.getByTestId("atlas-home-workspace")).toHaveClass(/is-active/);
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

    // ⭐ And the project ROW is what carries the landed mark now (card 4a0ad464): it is the node's
    // only address in the tree, so it is also the only row that can say "you are here".
    await expect(tree.getByTestId("atlas-project-node")).toHaveAttribute("aria-current", "true");
    await expect(tree.getByTestId("atlas-home-project")).toHaveCount(0);
  });
});
