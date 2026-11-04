// The Atlas Workspace TERMINALS node — card b439c2dc, owner intake verbatim: "add a terminals page
// with a terminals page like the one on the current ui. In the left sidebar place it between home and
// Platform."
// Record: docs/decisions/b439c2dc-atlas-workspace-terminals-node.md
//
// The card's claims, and what each leg measures them against:
//   1. SIDEBAR POSITION. The row exists, points at the node's own address, and sits BETWEEN Home and
//      Platform. Measured as an ordered equality over the workspace tier's rendered anchors, because
//      "it is in the sidebar" is satisfied by a row in the wrong place.
//   2. It lists every RUNNING session across EVERY project — and only those. Measured against seeded
//      rows differing in exactly one field from a listable one (an exited session, a companion), so
//      a filter that dropped everything and one that dropped nothing both fail. Then the project
//      filter narrows it, and widening restores the full list.
//   3. The SELECTED session's terminal attaches, and only it. Measured on the mounted pane's
//      REPLAYED BYTES — each seeded session carries its own sentinel — so a mount bound to the wrong
//      row is observable as a byte mismatch no amount of chrome can satisfy. Nothing at rest; a
//      second row MOVES the mount rather than adding to it.
//   4. DETACH ON LEAVE. Measured on the real WebSocket, collected via `page.on("websocket")` and
//      asserted CLOSED after navigating off the node — a DOM absence alone cannot tell a released
//      socket from a leaked one behind an unmounted node. The re-visit then mounts nothing, which is
//      the xterm side of the same release.
//   5. SWITCH OFF: the classic rail still carries exactly ONE Terminals entry, at `/terminals`, and
//      this node's address is not in it at all.
//
// Presence-first throughout (card 625d791c): a leading `toHaveCount(0)` is also satisfied by a page
// that is merely still loading, so every pair asserts what must BE there before what must not.
//
// READING THE RENDER: xterm.js paints to a <canvas> Playwright cannot read text from. Terminal.tsx
// runs with `screenReaderMode: true`, which keeps a visually-hidden, always-in-sync
// `.xterm-accessibility-tree` mirroring the real buffer — the same legitimate xterm feature
// terminal-canned-pty.spec.ts and atlas-workspace-sessions.spec.ts read from. Nothing is monkeypatched.
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";

// lib/atlasUi.ts owns this key and the "1" = on encoding. Hardcoded rather than imported: the e2e
// tsconfig covers `e2e/` only (tsconfig.e2e.json).
const ATLAS_KEY = "loom.atlasUi";

/** The node's own address — Atlas-only, declared once in src/nav.tsx's ATLAS_HOMES. */
const NODE = "/workspace-terminals";

/**
 * The workspace tier, in the order card b439c2dc's owner intake asks for.
 *
 * ⭐ Deliberately duplicated from atlas-tree-hierarchy.spec.ts rather than shared: that spec asserts
 * the tier is EXACTLY this (an equality that fails on anything creeping in), and this one asserts the
 * Terminals row's own placement WITHIN it. Two specs asserting one order from one constant would make
 * a single wrong edit pass both.
 */
const WORKSPACE_TIER = ["/home", NODE, "/platform"];

// Only ever seeded ON. Off IS the default (an empty storage key), and addInitScript re-runs on EVERY
// navigation — so a "seed off" script would silently re-clear the key mid-test.
async function seedAtlasOn(page: Page) {
  await page.addInitScript((key) => {
    try { localStorage.setItem(key, "1"); } catch { /* storage unavailable — assertions will say so */ }
  }, ATLAS_KEY);
}

const uniq = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** The pinned grid for every seeded pty here — small, so a replayed sentinel lands on row 0. */
const GEOMETRY = { cols: 60, rows: 8 };

/**
 * The fleet this spec asserts against.
 *
 * TWO projects, named so that the one seeded SECOND sorts FIRST — the list is project-major by name,
 * and seeding them in sorted order would let arrival order pass for the real rule.
 *
 * Each listable session gets a distinct 8-char `id` prefix (the UI renders `id.slice(0, 8)`, and the
 * fixture's default mint makes every seeded row read "e2e-live") AND a distinct `ptyBytes` sentinel,
 * which is what makes "the right session's terminal mounted" measurable rather than assumed.
 *
 * The two rows that must NOT be listed differ from a listable one in exactly one field: `exited` in
 * `processState`, and the companion in `role` (`assistant` IS the companion role — lib/sessions.ts
 * COMPANION_ROLE — and it is otherwise a perfectly listable live session).
 */
async function seedFleet(loomDaemon: LoomDaemon) {
  const zulu = await loomDaemon.createProject(uniq("atwt-zulu"));
  const alpha = await loomDaemon.createProject(uniq("atwt-alpha"));

  const alphaMgr = await loomDaemon.seedLiveSession({
    project: alpha, id: uniq("wtmgra"), role: "manager", agentName: "Alpha Lead",
    ptyGeometry: GEOMETRY, ptyBytes: "ALPHA-MANAGER-PTY\r\n",
  });
  const alphaWorker = await loomDaemon.seedLiveSession({
    project: alpha, id: uniq("wtwrka"), role: "worker", agentName: "Alpha Dev",
    parentSessionId: alphaMgr.sessionId,
    ptyGeometry: GEOMETRY, ptyBytes: "ALPHA-WORKER-PTY\r\n",
  });
  const zuluWorker = await loomDaemon.seedLiveSession({
    project: zulu, id: uniq("wtwrkz"), role: "worker", agentName: "Zulu Dev",
    ptyGeometry: GEOMETRY, ptyBytes: "ZULU-WORKER-PTY\r\n",
  });
  const exited = await loomDaemon.seedLiveSession({
    project: alpha, id: uniq("wtdead"), role: "worker", agentName: "Alpha Ghost",
    processState: "exited",
  });
  const companion = await loomDaemon.seedLiveSession({
    project: alpha, id: uniq("wtcomp"), role: "assistant", agentName: "Alpha Companion",
  });

  return { alpha, zulu, alphaMgr, alphaWorker, zuluWorker, exited, companion };
}

const node = (page: Page) => page.getByTestId("atlas-terminals-node");
const card = (page: Page) => page.getByTestId("atlas-terminals-card");
const rows = (page: Page) => card(page).locator("[data-atlas-wsession]");
const terminals = (page: Page) => card(page).getByTestId("atlas-terminals-terminal");
/** The mounted pane's real rendered buffer, via xterm's own accessibility tree. */
const paneText = (page: Page) => terminals(page).locator(".xterm-accessibility-tree > div");

/**
 * Every `/ws/term/<id>` socket this page has opened, newest last, with their live closed state.
 *
 * ⚠️ Registered BEFORE the first `goto`: `page.on("websocket")` only reports sockets opened after it
 * is attached, so collecting after navigation silently returns an empty list — and an empty list
 * makes every "it closed" assertion below pass for the wrong reason. The leg that uses it therefore
 * asserts a socket was OPENED first.
 */
function collectTermSockets(page: Page) {
  const opened: { url: string; isClosed: () => boolean }[] = [];
  page.on("websocket", (ws) => {
    if (ws.url().includes("/ws/term/")) opened.push({ url: ws.url(), isClosed: () => ws.isClosed() });
  });
  return {
    /** The sockets opened for ONE session id — a reconnect attempt would add another. */
    for: (sessionId: string) => opened.filter((w) => w.url.includes(`/ws/term/${sessionId}`)),
    all: () => opened,
  };
}

test.describe("Atlas Workspace Terminals node", () => {
  test("sits between Home and Platform in the sidebar and opens its own node", async ({ page, loomDaemon }) => {
    await loomDaemon.createProject(uniq("atwt-pos"));
    await seedAtlasOn(page);
    await page.goto(`${loomDaemon.baseURL}/home`);

    const tree = page.getByTestId("atlas-tree");
    await expect(tree).toBeVisible();

    // PRESENCE FIRST: the row exists and points at the node's own address, so the ORDER read below
    // is a measurement of a rendered row rather than of an empty collector.
    const row = page.getByTestId("atlas-home-workspace-terminals");
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("href", NODE);
    await expect(row).toHaveText(/Terminals/);

    // ⭐ THE PLACEMENT CLAIM. An ordered equality over the workspace tier's own anchors: a Terminals
    // row that drifted above Home or below Platform satisfies every presence check above and is
    // still the wrong sidebar, which is precisely what the owner specified.
    const tierRoutes = await tree.locator("ul.loom-atlas-nodes").first()
      .locator("> li a.loom-atlas-node")
      .evaluateAll((els) => els.map((el) => new URL((el as HTMLAnchorElement).href).pathname));
    expect(tierRoutes, "the workspace tier is not Home → Terminals → Platform").toEqual(WORKSPACE_TIER);

    // It NAVIGATES, and lands on the node itself rather than AtlasShell's unmounted-address fallback
    // — the failure a declared-but-unrouted ATLAS_HOMES row would produce.
    await row.click();
    await expect(page).toHaveURL(loomDaemon.baseURL + NODE);
    await expect(node(page)).toBeVisible();
    await expect(page.getByTestId("atlas-empty"),
      "the Terminals address fell through to AtlasShell's catch-all, so it is not mounted").toHaveCount(0);
    // The frame names the node, so the heading and the row agree about where the reader is.
    await expect(row).toHaveClass(/is-active/);
  });

  test("lists every running session across projects and only those, and the project filter narrows it", async ({ page, loomDaemon }) => {
    const f = await seedFleet(loomDaemon);
    await seedAtlasOn(page);
    await page.goto(loomDaemon.baseURL + NODE);

    // PRESENCE FIRST: the card and its three real rows, before any absence claim below.
    await expect(card(page)).toBeVisible();
    await expect(rows(page)).toHaveCount(3);
    for (const s of [f.alphaMgr, f.alphaWorker, f.zuluWorker]) {
      await expect(page.getByTestId(`atlas-terminals-row-${s.sessionId}`)).toBeVisible();
    }

    // ...and only those. An exited session and a companion are each absent, so the filter is doing
    // real work in both directions rather than passing on an empty or an unfiltered list.
    await expect(page.getByTestId(`atlas-terminals-row-${f.exited.sessionId}`)).toHaveCount(0);
    await expect(page.getByTestId(`atlas-terminals-row-${f.companion.sessionId}`)).toHaveCount(0);

    // The head count is the rendered row count, not a separately-derived figure that could drift.
    await expect(card(page).getByTestId("atlas-terminals-count")).toHaveText("3");

    // ORDER: project-major by NAME. `alpha` was seeded SECOND, so arrival order would put zulu's row
    // first — this only passes if the name decides it. Within alpha, the manager leads its worker.
    await expect(rows(page).nth(0)).toHaveAttribute("data-atlas-wsession", f.alphaMgr.sessionId);
    await expect(rows(page).nth(1)).toHaveAttribute("data-atlas-wsession", f.alphaWorker.sessionId);
    await expect(rows(page).nth(2)).toHaveAttribute("data-atlas-wsession", f.zuluWorker.sessionId);

    // Each row names its project — this node is the app's only cross-project terminal LIST, so a row
    // that did not would leave "and where" unanswered.
    await expect(rows(page).nth(0)).toContainText(f.alpha.name);
    await expect(rows(page).nth(2)).toContainText(f.zulu.name);

    // The footer states both halves of the scope, derived from the same rows.
    await expect(card(page)).toContainText("3 running sessions across 2 projects.");

    // THE FILTER — the control the classic god-eye page has and the Workspace node's deck card has no
    // width for. Narrowing to zulu must drop BOTH of alpha's rows and keep zulu's: a filter that
    // dropped everything, or nothing, fails on one half or the other.
    const filter = card(page).getByTestId("atlas-terminals-filter");
    await expect(filter).toBeVisible();
    await filter.selectOption(f.zulu.name);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).nth(0)).toHaveAttribute("data-atlas-wsession", f.zuluWorker.sessionId);
    await expect(card(page).getByTestId("atlas-terminals-count")).toHaveText("1");
    await expect(page.getByTestId(`atlas-terminals-row-${f.alphaMgr.sessionId}`)).toHaveCount(0);

    // ⭐ The TREE ROW's metric stays the UNFILTERED fleet while the page is narrowed. A rail metric
    // describes the workspace, and one that followed a filter set on the page it leads to would
    // misreport the fleet to the reader who opened the rail to find out what else is running.
    await expect(page.getByTestId("atlas-home-workspace-terminals"),
      "the tree's Terminals metric followed the page's project filter").toContainText("3 live");

    // ...and widening restores the whole fleet, so the narrowing above was the filter and not a
    // collapse the page could not come back from.
    await filter.selectOption("");
    await expect(rows(page)).toHaveCount(3);
    await expect(page.getByTestId(`atlas-terminals-row-${f.alphaMgr.sessionId}`)).toBeVisible();
  });

  test("mounts no terminal at rest, attaches the SELECTED session's, and moves it rather than adding a second", async ({ page, loomDaemon }) => {
    const f = await seedFleet(loomDaemon);
    await seedAtlasOn(page);
    await page.goto(loomDaemon.baseURL + NODE);

    // AT REST: the rows are there (presence first) and NOTHING is mounted. A live-terminal page is
    // heavy (CLAUDE.md), so this is the claim that makes the node safe to leave open.
    await expect(rows(page)).toHaveCount(3);
    await expect(terminals(page)).toHaveCount(0);
    // ...and the seat stands where the terminal will land, so "nothing at rest" is a stated shape
    // rather than an unexplained empty column (card b439c2dc: at 1440 the node drew a ~310px panel
    // over ~600px of nothing before this existed).
    await expect(card(page).getByTestId("atlas-terminals-seat")).toBeVisible();
    const mgrToggle = page.getByTestId(`atlas-terminals-expand-${f.alphaMgr.sessionId}`);
    const workerToggle = page.getByTestId(`atlas-terminals-expand-${f.zuluWorker.sessionId}`);
    await expect(mgrToggle).toHaveAttribute("aria-expanded", "false");

    // SELECT ONE. The observable is the pane's REPLAYED BYTES, not merely a region appearing: the
    // manager's own sentinel proves the attach is bound to the row that was clicked.
    await mgrToggle.click();
    await expect(terminals(page)).toHaveCount(1);
    await expect(paneText(page).filter({ hasText: "ALPHA-MANAGER-PTY" })).toBeVisible();
    await expect(mgrToggle).toHaveAttribute("aria-expanded", "true");
    // The row carries the landed mark, so the pane below the scroll track has a label.
    await expect(page.getByTestId(`atlas-terminals-row-${f.alphaMgr.sessionId}`)).toHaveClass(/is-expanded/);
    // And NO second pane rode in with it — the whole point of reusing the single-mount list.
    await expect(paneText(page).filter({ hasText: "ZULU-WORKER-PTY" })).toHaveCount(0);
    // The seat is VACATED, never drawn beside the pane it is a stand-in for: it marks the terminal's
    // own position, so leaving it up would push the real one down the page it was reserving.
    await expect(card(page).getByTestId("atlas-terminals-seat"),
      "the reserved seat is still drawn while a terminal is mounted in it").toHaveCount(0);

    // SWITCH SESSIONS. Clicking a DIFFERENT row must not add a second mount — still exactly one
    // region, now replaying the OTHER session's bytes, with the first row released. The byte change
    // is what tells a moved mount apart from a second one rendering in the same place.
    await workerToggle.click();
    await expect(terminals(page)).toHaveCount(1);
    await expect(paneText(page).filter({ hasText: "ZULU-WORKER-PTY" })).toBeVisible();
    await expect(paneText(page).filter({ hasText: "ALPHA-MANAGER-PTY" })).toHaveCount(0);
    await expect(mgrToggle).toHaveAttribute("aria-expanded", "false");
    await expect(workerToggle).toHaveAttribute("aria-expanded", "true");

    // RELEASE IT. A re-click on the open row gives the mount up entirely, so the node can return to
    // costing nothing without the reader navigating away.
    await workerToggle.click();
    await expect(rows(page)).toHaveCount(3);
    await expect(terminals(page)).toHaveCount(0);
    await expect(workerToggle).toHaveAttribute("aria-expanded", "false");
    // ...and the seat comes back, so the released state is the SAME page the reader arrived at
    // rather than a quietly different one with a hole in it.
    await expect(card(page).getByTestId("atlas-terminals-seat")).toBeVisible();
  });

  test("the seat is this node's alone: the Workspace node's own Sessions card is unchanged", async ({ page, loomDaemon }) => {
    // The seat is an OPTIONAL prop on the shared SessionTerminalList (card b439c2dc), added so a
    // whole-page mount can explain its own largest area. The two DECK mounts must be untouched by
    // it — on a band card a reserved terminal seat is furniture the deck has no room for.
    const f = await seedFleet(loomDaemon);
    await seedAtlasOn(page);
    await page.goto(`${loomDaemon.baseURL}/home`);

    // PRESENCE FIRST: the Workspace node's own card really rendered, and still mounts nothing at
    // rest — so the absence below is measured on a live surface, not on a page that failed to load.
    const deckCard = page.getByTestId("atlas-sessions-card");
    await expect(deckCard).toBeVisible();
    await expect(deckCard.locator("[data-atlas-wsession]")).toHaveCount(3);
    await expect(deckCard.getByTestId("atlas-sessions-terminal")).toHaveCount(0);
    await expect(deckCard.getByTestId("atlas-terminals-seat"),
      "the Terminals node's reserved seat leaked onto the Workspace node's Sessions card").toHaveCount(0);

    // ...and that card still attaches exactly as it did, so the shared component's own contract is
    // intact rather than merely un-decorated.
    await page.getByTestId(`atlas-session-expand-${f.zuluWorker.sessionId}`).click();
    await expect(deckCard.getByTestId("atlas-sessions-terminal")).toHaveCount(1);
    await expect(deckCard.locator(".xterm-accessibility-tree > div").filter({ hasText: "ZULU-WORKER-PTY" }))
      .toBeVisible();
  });

  test("navigating off the node detaches the socket and leaves nothing mounted on return", async ({ page, loomDaemon }) => {
    const f = await seedFleet(loomDaemon);
    // ⚠️ BEFORE the first goto — see collectTermSockets' own note. A collector attached after
    // navigation reports nothing, and nothing makes every close assertion below vacuous.
    const sockets = collectTermSockets(page);
    await seedAtlasOn(page);
    await page.goto(loomDaemon.baseURL + NODE);

    await expect(rows(page)).toHaveCount(3);
    expect(sockets.all(), "a terminal socket was opened before any row was selected").toHaveLength(0);

    await page.getByTestId(`atlas-terminals-expand-${f.alphaWorker.sessionId}`).click();
    await expect(terminals(page)).toHaveCount(1);
    await expect(paneText(page).filter({ hasText: "ALPHA-WORKER-PTY" })).toBeVisible();

    // POSITIVE CONTROL on the collector, before trusting any "it closed" claim from it: a socket for
    // THIS session really was opened, and is OPEN. Without this, a broken selector or a renamed ws
    // path would make the closure poll below pass against an empty list.
    const attached = sockets.for(f.alphaWorker.sessionId);
    expect(attached, "no /ws/term socket was opened for the selected session").not.toHaveLength(0);
    expect(attached.some((w) => !w.isClosed()),
      "the selected session's terminal socket is already closed while its pane is rendered").toBe(true);

    // LEAVE. Navigating to a sibling node unmounts the page, which is the only thing that releases
    // the attach — so every socket this node opened must end up CLOSED. Polled rather than read
    // once: the close handshake is asynchronous and a single read would race it.
    await page.getByTestId("atlas-node-/platform").click();
    await expect(page).toHaveURL(`${loomDaemon.baseURL}/platform`);
    await expect(card(page), "the Terminals card is still mounted after navigating away").toHaveCount(0);
    await expect
      .poll(() => sockets.for(f.alphaWorker.sessionId).every((w) => w.isClosed()),
        { message: "a /ws/term socket was left OPEN after navigating off the Terminals node" })
      .toBe(true);

    // ...and the xterm side of the same release: coming back mounts NOTHING. The expansion did not
    // survive, which it could only do if the component had never been unmounted.
    await page.getByTestId("atlas-home-workspace-terminals").click();
    await expect(rows(page)).toHaveCount(3);
    await expect(terminals(page),
      "returning to the node re-mounted a terminal nobody asked for").toHaveCount(0);
  });

  test("switch OFF: the classic rail keeps exactly one Terminals entry, at /terminals", async ({ page, loomDaemon }) => {
    await seedFleet(loomDaemon);
    // No seedAtlasOn — off is the default.
    await page.goto(`${loomDaemon.baseURL}/`);

    // Presence first: the classic rail really rendered, so the readings below are measurements and
    // not a page that failed to load.
    const rail = page.locator(".loom-rail");
    await expect(rail).toBeVisible();
    const railRoutes = await rail.locator("a.loom-rail-item, a.loom-rail-statrow")
      .evaluateAll((els) => els.map((el) => new URL((el as HTMLAnchorElement).href).pathname));
    expect(railRoutes, "the classic rail lost its own Terminals destination").toContain("/terminals");
    // ⭐ EXACTLY ONE. The node is an ATLAS_HOMES row precisely so the classic rail does not gain a
    // SECOND Terminals entry for a user who never opted in; a NAV_PAGES row would read as two.
    expect(railRoutes.filter((r) => r === "/terminals"),
      "the classic rail has more than one Terminals entry").toHaveLength(1);
    expect(railRoutes, "the Atlas-only Terminals node leaked into the classic rail").not.toContain(NODE);

    // And nothing of this node exists in the classic document at all.
    await expect(node(page)).toHaveCount(0);
    await expect(card(page)).toHaveCount(0);
  });
});
