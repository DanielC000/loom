// The Atlas Workspace TERMINALS node — card b439c2dc gave it an address; card 17420720 decided what
// it draws, on the owner's own verdict of the first answer: "atlas terminals page sucks. it should be
// terminal cards in grid like in the old ui."
// Record: docs/decisions/17420720-atlas-terminals-is-the-classic-grid.md
//
// The card's claims, and what each leg measures them against:
//   1. SIDEBAR POSITION. The row exists, points at the node's own address, and sits BETWEEN Home and
//      Platform. Measured as an ordered equality over the workspace tier's rendered anchors, because
//      "it is in the sidebar" is satisfied by a row in the wrong place.
//   2. ⭐ IT IS THE CLASSIC TILED GRID. Measured GEOMETRICALLY — two session cards whose rendered
//      boxes share a TOP EDGE and differ in X — which is the owner's literal ask ("cards in grid")
//      and is what a track count alone does not prove: a grid can resolve two tracks and still stack
//      its cards if something upstream puts one per row.
//   3. It lists every RUNNING session across EVERY project, and only those; the project filter
//      narrows it. Measured against seeded rows differing in exactly one field from a listable one
//      (an exited session, a companion), so a filter that dropped everything and one that dropped
//      nothing both fail.
//   4. THE COLUMNS PICKER CHANGES THE COLUMN COUNT, and the choice survives a reload. Read off
//      COMPUTED STYLE — the resolved track count — never the `data-columns` attribute the control
//      itself writes, which would only prove the control wrote what it was told.
//   5. THE SHELLS LANE, end to end: the classic spawn modal → a real `POST /api/terminals` → the tile
//      → a command TYPED into it whose OUTPUT is read back → Kill/Confirm → the tile is gone.
//   6. SINGLE MOUNT: no session's terminal is ever mounted twice on this page. Measured as one pane
//      per seeded session id, which is the claim that survives the move to a grid (the grid mounts N
//      DISTINCT sessions by design; what it must never do is mount one session twice).
//   7. DETACH ON LEAVE. Measured on the real WebSockets, collected via `page.on("websocket")` and
//      asserted CLOSED after navigating off — a DOM absence alone cannot tell a released socket from
//      one leaked behind an unmounted node.
//   8. SWITCH OFF: the classic rail still carries exactly ONE Terminals entry, at `/terminals`, this
//      node's address is not in it, and that page still has NO columns picker — the god-eye contract
//      card ac0cfe91 set, which this card had to leave intact while giving the Atlas node one.
//
// Presence-first throughout (card 625d791c): a leading `toHaveCount(0)` is also satisfied by a page
// that is merely still loading, so every pair asserts what must BE there before what must not.
//
// READING THE RENDER: xterm.js paints to a <canvas> Playwright cannot read text from. Terminal.tsx
// runs with `screenReaderMode: true`, which keeps a visually-hidden, always-in-sync
// `.xterm-accessibility-tree` mirroring the real buffer — the same legitimate xterm feature
// terminal-canned-pty.spec.ts and atlas-sessions-layout.spec.ts read from. Nothing is monkeypatched.
//
// ⛔ NO REAL CLAUDE IS EVER SPAWNED — every session is seeded through the fixture's own test-only
// insert path (`seedLiveSession`), which never enters the daemon's spawn path, and nothing clicked
// here reaches `startSession`. The REAL host shells leg 5 spawns are a different, benign thing: they
// log `[pty] spawnShell`, which the fixture's narrowed no-spawn guard deliberately lets through.
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

/**
 * Clear THIS page's own stored grid layout before it loads.
 *
 * The node persists the reader's column choice under `loom.sessionsLayout.workspace`
 * (pages/WorkspaceTerminals.tsx), and the e2e browser context is per-worker — so leg 4, which SETS a
 * column count, would otherwise leave every later leg rendering at that count instead of `auto`.
 * Removing rather than writing "auto": absent IS the default, and writing one would make these legs
 * measure the seed instead of the app's own fallback.
 *
 * ⚠️ ONCE PER CONTEXT, guarded by a sessionStorage marker — `addInitScript` re-runs on EVERY
 * navigation, so an unconditional remove would wipe the key again on the very reload leg 4 uses to
 * prove the choice persisted, and that leg would be measuring this helper instead of the app. (It
 * did: the leg went red on `toHaveValue("1")` until this guard existed.) `sessionStorage` is the
 * right marker — per tab, so each test's own fresh context still gets its one clean removal.
 */
async function clearStoredLayout(page: Page) {
  await page.addInitScript(() => {
    try {
      if (sessionStorage.getItem("loom.e2e.layoutCleared") !== null) return;
      localStorage.removeItem("loom.sessionsLayout.workspace");
      sessionStorage.setItem("loom.e2e.layoutCleared", "1");
    } catch { /* storage unavailable — the legs' own assertions will say so */ }
  });
}

const uniq = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** The pinned grid for every seeded pty here — small, so a replayed sentinel lands on row 0. */
const GEOMETRY = { cols: 60, rows: 8 };

/**
 * The fleet this spec asserts against: ONE manager row of three (a manager plus two of its workers)
 * in one project, plus a second project's lone worker.
 *
 * The manager row is what leg 2 measures side-by-side-ness on — three tiles in ONE grid container,
 * so "two cards share a top edge" is a claim about a real row rather than about two separate rows
 * that happen to be adjacent. The two rows that must NOT be listed differ from a listable one in
 * exactly one field: `exited` in `processState`, and the companion in `role` (`assistant` IS the
 * companion role — lib/sessions.ts COMPANION_ROLE — otherwise a perfectly listable live session).
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
  const alphaWorkerB = await loomDaemon.seedLiveSession({
    project: alpha, id: uniq("wtwrkb"), role: "worker", agentName: "Alpha QA",
    parentSessionId: alphaMgr.sessionId,
    ptyGeometry: GEOMETRY, ptyBytes: "ALPHA-QA-PTY\r\n",
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

  return {
    alpha, zulu, alphaMgr, alphaWorker, alphaWorkerB, zuluWorker, exited, companion,
    managerRowKey: alphaMgr.sessionId,
  };
}

const node = (page: Page) => page.getByTestId("atlas-terminals-node");
const bar = (page: Page) => node(page).getByTestId("sessions-bar");
const columnsSelect = (page: Page) => node(page).getByTestId("sessions-columns");
const grid = (page: Page, rowKey: string) => node(page).getByTestId(`sessions-grid-${rowKey}`);
/** Every session card on the node, as the 8-char short ids the shared card header prints. */
async function tileShortIds(page: Page): Promise<string[]> {
  const texts = await node(page).getByTestId("tile-identity").allTextContents();
  return texts.map((t) => t.split(" · ").pop()!.trim());
}
/** How many TRACKS a row's grid resolved to — the real layout fact, not the attribute we wrote. */
function trackCount(page: Page, rowKey: string): Promise<number> {
  return grid(page, rowKey)
    .evaluate((el) => getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/).filter(Boolean).length);
}

/**
 * Every `/ws/term/<id>` socket this page has opened, newest last, with their live closed state.
 *
 * ⚠️ Registered BEFORE the first `goto`: `page.on("websocket")` only reports sockets opened after it
 * is attached, so collecting after navigation silently returns an empty list — and an empty list
 * makes every "it closed" assertion below pass for the wrong reason. The leg that uses it therefore
 * asserts sockets were OPENED first.
 */
function collectTermSockets(page: Page) {
  const opened: { url: string; isClosed: () => boolean }[] = [];
  page.on("websocket", (ws) => {
    if (ws.url().includes("/ws/term/")) opened.push({ url: ws.url(), isClosed: () => ws.isClosed() });
  });
  return {
    for: (sessionId: string) => opened.filter((w) => w.url.includes(`/ws/term/${sessionId}`)),
    all: () => opened,
  };
}

test.describe("Atlas Workspace Terminals node", () => {
  /**
   * Projects this file spawned a shell into THROUGH THE UI.
   *
   * ⚠️ A UI spawn is not in `loomDaemon.spawnShell`'s tracker, so the auto-isolation fixture's
   * `killSpawnedShells` cannot reap it — and a leaked shell is a real host pty that outlives the
   * run. The sweep below is bounded to these project names (each `uniq`-stamped), never a blanket
   * kill of every shell on the shared worker daemon, which could reach a sibling spec's.
   */
  const uiSpawnProjects: { baseURL: string; projectName: string }[] = [];

  test.beforeEach(async ({ page }) => {
    await seedAtlasOn(page);
    await clearStoredLayout(page);
  });

  test.afterEach(async () => {
    const pending = uiSpawnProjects.splice(0); // clear as we sweep — DELETE is idempotent
    for (const { baseURL, projectName } of pending) {
      try {
        const res = await fetch(`${baseURL}/api/terminals`);
        const shells = (await res.json()) as { id: string; label: string; alive: boolean }[];
        for (const s of shells) {
          if (s.alive && s.label.startsWith(projectName)) {
            await fetch(`${baseURL}/api/terminals/${s.id}`, { method: "DELETE" });
          }
        }
      } catch { /* best-effort, same posture as the fixture's own killSpawnedShells */ }
    }
  });

  test("sits between Home and Platform in the sidebar and opens its own node", async ({ page, loomDaemon }) => {
    await loomDaemon.createProject(uniq("atwt-pos"));
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
    await expect(row).toHaveClass(/is-active/);
  });

  test("renders the classic tiled grid: two session cards side by side in one row", async ({ page, loomDaemon }) => {
    const f = await seedFleet(loomDaemon);
    // Wide enough that `auto` (a 560px tile floor, lib/terminalLayout.ts AUTO_GRID_TEMPLATE) resolves
    // to at least two tracks in the Atlas content column — this leg is about the grid, not about what
    // a narrow column does to it, and asserting side-by-side at a width that cannot fit two would be
    // measuring the viewport.
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(loomDaemon.baseURL + NODE);

    // PRESENCE FIRST: the node mounted and the manager row's own grid is on the page.
    await expect(node(page)).toBeVisible();
    await expect(grid(page, f.managerRowKey)).toBeVisible();

    // The manager row holds its manager plus its two workers — three cards in ONE grid container, so
    // the geometry below is read across a real row rather than across two unrelated sections.
    const cards = grid(page, f.managerRowKey).getByTestId("tile-identity");
    await expect(cards).toHaveCount(3);

    // ⭐ THE OWNER'S ACTUAL ASK, measured as geometry. Two cards SHARE A TOP EDGE and differ in X.
    // A resolved track count alone does not prove this — a container can report two tracks and still
    // place one card per row — and "it is a grid" is exactly the claim that was wrong before.
    const boxes = await grid(page, f.managerRowKey).locator("> *").evaluateAll(
      (els) => els.map((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) }; }));
    expect(boxes.length, "the manager row drew no cards").toBeGreaterThanOrEqual(2);
    expect(boxes[1]!.y, "the first two session cards are stacked, not side by side").toBe(boxes[0]!.y);
    expect(boxes[1]!.x, "the second card does not sit to the RIGHT of the first").toBeGreaterThan(boxes[0]!.x);
    // ...and each is a real card, not a sliver: the shared card cannot render below its own floor.
    expect(boxes[0]!.w, "the first card is narrower than the grid's own tile floor").toBeGreaterThanOrEqual(320);

    // The resolved track count agrees with the geometry — stated as well as implied, because leg 4
    // moves this number and needs a baseline that was read, not assumed.
    expect(await trackCount(page, f.managerRowKey)).toBeGreaterThanOrEqual(2);

    // Each card is a LIVE terminal, bound to its own session: the manager's replayed sentinel proves
    // the attach rather than merely that a card frame drew.
    await expect(node(page).locator(".xterm-accessibility-tree > div").filter({ hasText: "ALPHA-MANAGER-PTY" }))
      .toBeVisible();
    await expect(node(page).locator(".xterm-accessibility-tree > div").filter({ hasText: "ALPHA-QA-PTY" }))
      .toBeVisible();
  });

  test("lists every running session across projects and only those, and the project filter narrows it", async ({ page, loomDaemon }) => {
    const f = await seedFleet(loomDaemon);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(loomDaemon.baseURL + NODE);

    // PRESENCE FIRST: four real cards, before any absence claim below.
    await expect(node(page)).toBeVisible();
    await expect.poll(async () => (await tileShortIds(page)).length).toBe(4);
    const shown = await tileShortIds(page);
    for (const s of [f.alphaMgr, f.alphaWorker, f.alphaWorkerB, f.zuluWorker]) {
      expect(shown, `${s.sessionId} is missing from the grid`).toContain(s.sessionId.slice(0, 8));
    }
    // ...and only those. An exited session and a companion are each absent, so the population rule is
    // doing real work in both directions rather than passing on an empty or an unfiltered list.
    expect(shown).not.toContain(f.exited.sessionId.slice(0, 8));
    expect(shown).not.toContain(f.companion.sessionId.slice(0, 8));

    // THE FILTER — the control the classic god-eye page has always had, and which this node inherits
    // by mounting that page. Narrowing to zulu must drop ALL of alpha's cards and keep zulu's: a
    // filter that dropped everything, or nothing, fails on one half or the other.
    await expect(bar(page)).toBeVisible();
    await bar(page).locator("select").first().selectOption(f.zulu.name);
    await expect.poll(async () => (await tileShortIds(page)).length).toBe(1);
    expect(await tileShortIds(page)).toEqual([f.zuluWorker.sessionId.slice(0, 8)]);

    // ⭐ The TREE ROW's metric stays the UNFILTERED fleet while the page is narrowed. A rail metric
    // describes the workspace, and one that followed a filter set on the page it leads to would
    // misreport the fleet to the reader who opened the rail to find out what else is running.
    await expect(page.getByTestId("atlas-home-workspace-terminals"),
      "the tree's Terminals metric followed the page's project filter").toContainText("4 live");

    // ...and widening restores the whole fleet, so the narrowing was the filter and not a collapse
    // the page could not come back from.
    await bar(page).locator("select").first().selectOption("");
    await expect.poll(async () => (await tileShortIds(page)).length).toBe(4);
  });

  test("the columns picker changes the resolved column count, and the choice survives a reload", async ({ page, loomDaemon }) => {
    const f = await seedFleet(loomDaemon);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(loomDaemon.baseURL + NODE);

    // PRESENCE FIRST — and this is itself a claim: the picker exists HERE. It is gated on a layout
    // slot (pages/Terminals.tsx `layoutScope`), and this node is the one god-eye mount that has one.
    await expect(bar(page)).toBeVisible();
    await expect(columnsSelect(page)).toBeVisible();
    const atAuto = await trackCount(page, f.managerRowKey);
    expect(atAuto, "the default `auto` grid resolved to fewer than two tracks at 1600px").toBeGreaterThanOrEqual(2);

    // ⭐ READ OFF COMPUTED STYLE, never `data-columns`. The attribute is what the control WROTE; the
    // resolved track count is what the browser DREW, and only the second can fail when the choice
    // reaches state but never reaches the grid.
    await columnsSelect(page).selectOption("3");
    await expect.poll(() => trackCount(page, f.managerRowKey),
      { message: "choosing 3 columns did not change the resolved track count" }).toBe(3);
    await columnsSelect(page).selectOption("1");
    await expect.poll(() => trackCount(page, f.managerRowKey),
      { message: "choosing 1 column did not change the resolved track count" }).toBe(1);
    // TWO distinct values, and neither is the default — so this cannot pass on a grid that ignored
    // the control and happened to sit where it started.
    expect(atAuto).not.toBe(1);

    // The card count is UNCHANGED by a column change: this renderer is the heavy one, so "mounts no
    // more than before" is asserted rather than assumed.
    expect(await tileShortIds(page)).toHaveLength(4);

    // IT PERSISTS. The node writes its own slot (`loom.sessionsLayout.workspace`), so a reader lays
    // this page out once. Re-navigating re-reads it rather than falling back to `auto`.
    await page.goto(`${loomDaemon.baseURL}/home`);
    await page.goto(loomDaemon.baseURL + NODE);
    await expect(columnsSelect(page)).toHaveValue("1");
    await expect.poll(() => trackCount(page, f.managerRowKey),
      { message: "the stored column choice was not re-read on return" }).toBe(1);
  });

  test("single mount: no session's terminal is mounted twice on the page", async ({ page, loomDaemon }) => {
    // The grid mounts N DISTINCT sessions by design — that is what a god-eye page IS. The rule that
    // survives the move from the single-column list is narrower and still load-bearing: one session,
    // one pane. A duplicate would be a second live `/ws/term` attach to the same pty, which is both
    // wasted and a source of interleaved stdin.
    const f = await seedFleet(loomDaemon);
    const sockets = collectTermSockets(page);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(loomDaemon.baseURL + NODE);

    await expect.poll(async () => (await tileShortIds(page)).length).toBe(4);
    const shown = await tileShortIds(page);
    // Measured as "no duplicates in the rendered set", which is the DOM half...
    expect(new Set(shown).size, `a session is rendered more than once: ${shown.join(", ")}`).toBe(shown.length);

    // ...and as "exactly one socket per session", which is the half that matters. A second card for
    // one session could be missed by a short-id comparison; a second attach cannot.
    for (const s of [f.alphaMgr, f.alphaWorker, f.alphaWorkerB, f.zuluWorker]) {
      await expect.poll(() => sockets.for(s.sessionId).length,
        { message: `${s.sessionId} opened more (or fewer) than one /ws/term socket` }).toBe(1);
    }
  });

  test("the shells lane: spawn through the classic modal, attach, run a command, then kill", async ({ page, loomDaemon }) => {
    // A real host shell's own startup (pwsh's banner / bash's rc files) plus a round-trip through the
    // pty is slower than a seeded, canned pane. Raised over the config's 30s default because the
    // margin is the part that has to hold on a loaded ubuntu CI runner, where a cold first browser
    // context can land in the same test.
    test.setTimeout(60_000);

    // ⚠️ This project is NOT the one the modal will pre-select. The e2e worker daemon is SHARED across
    // spec files and the auto-isolation fixture archives SESSIONS, not projects — so by now earlier
    // legs' projects are still listed and `SpawnShellModal` prefills `projects.data[0]`, whichever
    // that is. This leg therefore DRIVES the picker rather than trusting the prefill, which is the
    // better test anyway: it makes "the shell landed in the project I chose" an observable. (Measured
    // before it did: the spawn went into a previous leg's project and the leg read its label back.)
    const project = await loomDaemon.createProject(uniq("atwt-shell"));
    // Registered BEFORE the spawn, so the afterEach sweep covers a failure at ANY point below.
    uiSpawnProjects.push({ baseURL: loomDaemon.baseURL, projectName: project.name });
    await page.goto(loomDaemon.baseURL + NODE);

    // PRESENCE FIRST: the lane and its spawn control, and no shell yet. The lane is the classic
    // ShellsSection, mounted here by mounting the classic page — same copy, same control.
    await expect(node(page).getByRole("button", { name: "+ Shell" })).toBeVisible();
    await expect(node(page).getByText(/No shells\. Open one in a project's repo/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Open shell" })).toHaveCount(0);

    // ── SPAWN, through the REUSED classic modal ────────────────────────────────────────────────
    await node(page).getByRole("button", { name: "+ Shell" }).click();
    await expect(page.getByText("Open a shell", { exact: true })).toBeVisible();
    // Its executable field PREFILLS from the daemon's own detected default shell, which is what keeps
    // this leg cross-platform: nothing here names pwsh or bash.
    await expect(page.getByPlaceholder("pwsh / bash / …")).not.toHaveValue("");

    // The modal's project `<select>` carries no testid — it renders into the classic page too, which
    // this card had to leave byte-identical — so it is addressed as the modal's own, with that premise
    // ASSERTED: the page behind it has a project filter of its own, and a selector that reached the
    // wrong one would silently drive the filter instead.
    const modalProject = page.locator("select").filter({ hasText: project.name });
    await expect(modalProject, "the spawn modal's project picker was not uniquely resolvable").toHaveCount(1);
    await modalProject.selectOption({ label: project.name });

    await page.getByRole("button", { name: "Open shell" }).click();
    // The modal closes itself on success (after invalidating `["terminals"]`), so its disappearance is
    // the first observable that the POST actually landed.
    await expect(page.getByRole("button", { name: "Open shell" })).toHaveCount(0);

    // ── THE TILE ──────────────────────────────────────────────────────────────────────────────
    // The classic ShellTile: its own "shell" pill and label, a hard Kill (never a graceful Stop), no
    // turn Composer — a shell is not a turn-based DB Session.
    const shellTile = node(page).getByText(new RegExp(`${project.name} · shell · `));
    await expect(shellTile).toBeVisible();
    await expect(node(page).getByText(/No shells\. Open one in a project's repo/)).toHaveCount(0);
    await expect(node(page).getByRole("button", { name: "Kill" })).toBeVisible();

    // Record the id for the sweep BEFORE anything below can fail and strand a live host pty.
    const label = (await shellTile.textContent()) ?? "";
    const shortId = label.split(" · ").pop()!.trim();
    expect(shortId, "the shell tile printed no short id").toMatch(/^[0-9a-f]{8}$/);

    // ── ATTACH, and read a typed command's OUTPUT back ────────────────────────────────────────
    // ⭐ THE COUNT IS THE POINT, not the presence. Typing `echo <nonce>` puts the nonce in the buffer
    // TWICE: once where the pty echoed the keystrokes, once where the shell's output landed. ONE
    // occurrence means the keystrokes reached the pty and nothing ran them; TWO means it executed. A
    // `toContainText(nonce)` would pass on the echo alone — i.e. on a pane receiving nothing back.
    const nonce = `LOOMSHELL-${Date.now()}`;
    await node(page).locator(".xterm-helper-textarea").first().focus();
    await page.keyboard.type(`echo ${nonce}`);
    await page.keyboard.press("Enter");
    await expect
      .poll(async () => (await node(page).locator(".xterm-accessibility-tree > div").allTextContents())
        .filter((l) => l.includes(nonce)).length,
        { message: "the typed command never produced output in the shell's pane", timeout: 30_000 })
      .toBeGreaterThanOrEqual(2);

    // ── KILL ──────────────────────────────────────────────────────────────────────────────────
    // Through the tile's own two-step confirm: `DELETE /api/terminals/:id` for THIS shell's own id.
    // Nothing here names a process, an image or a port.
    await node(page).getByRole("button", { name: "Kill" }).click();
    await expect(page.getByText("kill shell?")).toBeVisible();
    await page.getByRole("button", { name: "Confirm" }).click();

    // THE OBSERVABLE: the tile is gone and the lane is back to its empty state — a real kill, not
    // chrome that merely stopped drawing.
    await expect(node(page).getByText(new RegExp(`shell · ${shortId}`))).toHaveCount(0);
    await expect(node(page).getByText(/No shells\. Open one in a project's repo/)).toBeVisible();
  });

  test("navigating off the node detaches every socket and leaves nothing mounted on return", async ({ page, loomDaemon }) => {
    const f = await seedFleet(loomDaemon);
    // ⚠️ BEFORE the first goto — see collectTermSockets' own note. A collector attached after
    // navigation reports nothing, and nothing makes every close assertion below vacuous.
    const sockets = collectTermSockets(page);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(loomDaemon.baseURL + NODE);
    await expect.poll(async () => (await tileShortIds(page)).length).toBe(4);

    // POSITIVE CONTROL on the collector, before trusting any "it closed" claim from it: sockets
    // really were opened, and at least one is OPEN. Without this, a broken selector or a renamed ws
    // path would make the closure poll below pass against an empty list.
    const attached = sockets.for(f.alphaWorker.sessionId);
    expect(attached, "no /ws/term socket was opened for a rendered card").not.toHaveLength(0);
    expect(attached.some((w) => !w.isClosed()),
      "the card's terminal socket is already closed while its pane is rendered").toBe(true);

    // LEAVE. Navigating to a sibling node unmounts the page, which is the only thing that releases the
    // attaches — so EVERY socket this node opened must end up CLOSED. Polled rather than read once:
    // the close handshake is asynchronous and a single read would race it.
    await page.getByTestId("atlas-node-/platform").click();
    await expect(page).toHaveURL(`${loomDaemon.baseURL}/platform`);
    await expect(node(page), "the Terminals node is still mounted after navigating away").toHaveCount(0);
    await expect
      .poll(() => sockets.all().every((w) => w.isClosed()),
        { message: "a /ws/term socket was left OPEN after navigating off the Terminals node" })
      .toBe(true);

    // ...and coming back re-attaches exactly one socket per session rather than accumulating: the
    // xterm side of the same release.
    await page.getByTestId("atlas-home-workspace-terminals").click();
    await expect.poll(async () => (await tileShortIds(page)).length).toBe(4);
    await expect.poll(() => sockets.for(f.alphaWorker.sessionId).filter((w) => !w.isClosed()).length,
      { message: "returning to the node left more than one live socket for one session" }).toBe(1);
  });
});
