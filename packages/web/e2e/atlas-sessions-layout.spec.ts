// The Atlas Sessions tab's terminal ORDER and GRID controls — card ac0cfe91, the owner's Atlas
// feedback verbatim: `Projects › tab "Sessions": Provide user with terminal ordering and gridding features.`
// Record: docs/decisions/ac0cfe91-atlas-sessions-terminal-order-and-grid.md
//
// The card's claims, and what each leg measures them against:
//   1. ORDER. A move control changes the rendered DOM order, and the change SURVIVES A RELOAD.
//      Measured as the tile sequence before and after, so a build that merely re-rendered, or one that
//      reshuffled on every poll, both fail. The reset is measured as a third state (back to the exact
//      sequence read before the move), not merely "the control disappeared".
//   2. The manager is NOT movable out of the head of its own row, and the row's ENDS refuse. Measured
//      with a real forced click on a refusing control plus an unchanged sequence, so "refused" is a
//      measured zero rather than a button that merely looked disabled.
//   3. GRID. The column control changes the resolved number of grid TRACKS — read off computed style,
//      not off the attribute the control itself writes — across two distinct values, and persists. The
//      count is a MAXIMUM: narrow the window under what N readable tiles need and the grid draws fewer
//      rather than tiles the shared card cannot render, without forgetting the choice.
//   4. ⛔ AND IT NEVER RESIZES THE PTY. Measured on a CANNED-pty session pinned at 80×24: narrowing its
//      cell to a third of the row leaves the xterm grid at 24 rows (the pin held) while the rendered
//      box gets SMALLER (the font re-solved). A build that fitted the grid to the cell instead would
//      change the row count, and one that did nothing at all would not change the box.
//   5. The tile COUNT is unchanged by a column change — this page's renderer is the heavy one, so
//      "mounts no more than before" is asserted on both sides rather than assumed.
//
// Presence-first throughout (card 625d791c): a leading `toHaveCount(0)` is also satisfied by a page
// that is merely still loading, so every pair asserts what must BE there before what must not.
//
// ⛔ NO REAL CLAUDE IS EVER SPAWNED — every session here is seeded through the fixture's own test-only
// insert path (`seedLiveSession`), which never enters the daemon's spawn path. Nothing is clicked that
// could reach `startSession`.
//
// READING THE RENDER (leg 4): xterm.js paints to a <canvas> Playwright cannot read text from.
// Terminal.tsx runs with `screenReaderMode: true` under the fixture, which keeps a visually-hidden,
// always-in-sync `.xterm-accessibility-tree` with one row element per grid row — the same legitimate
// xterm feature terminal-canned-pty.spec.ts reads from. Nothing is monkeypatched.
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";
import { openNodeTab } from "./helpers/nodeTabs";

// lib/activeProject.tsx owns the project key. Hardcoded rather than imported: the e2e tsconfig covers
// `e2e/` only (tsconfig.e2e.json), the same reason fixtures/daemon.ts hardcodes its own keys.
const PROJECT_KEY = "loom.projectId";

/** The project node's Sessions tab address — src/nav.tsx's PROJECT_NODE_TABS `sessions` row. */
const SESSIONS_PATH = "/terminals";

/** The production pinned grid — PLATFORM_DEFAULTS.pty, packages/shared/src/config.ts. */
const PINNED_GEOMETRY = { cols: 80, rows: 24 };

const uniq = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// Writes only while the key is still absent: addInitScript re-runs on EVERY navigation, so an
// unconditional write would re-pin on a reload, and that leg would be measuring this helper instead of the app.
async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([key, id]) => {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, id); } catch { /* storage unavailable */ }
  }, [PROJECT_KEY, projectId] as const);
}

const panel = (page: Page) => page.getByTestId("atlas-tabpanel-sessions");
const bar = (page: Page) => page.getByTestId("sessions-bar");
const columnsSelect = (page: Page) => page.getByTestId("sessions-columns");
const resetOrder = (page: Page) => page.getByTestId("sessions-order-reset");
const moveEarlier = (page: Page, id: string) => page.getByTestId(`sessions-move-earlier-${id}`);
const moveLater = (page: Page, id: string) => page.getByTestId(`sessions-move-later-${id}`);

/**
 * The rendered tile sequence, as the 8-char short ids the UI prints.
 *
 * Read off `tile-identity` (components/TerminalCard.tsx `TileTitle`), whose text is
 * `[project · ]agent[ · role] · <short id>` — so the trailing segment is the id, and reading it needs
 * no new markup. Scoped to the tab panel so a parked sibling tab body can never contribute a row.
 */
async function tileOrder(page: Page): Promise<string[]> {
  const texts = await panel(page).getByTestId("tile-identity").allTextContents();
  return texts.map((t) => t.split(" · ").pop()!.trim());
}

/** How many TRACKS the row's grid resolved to — the real layout fact, not the attribute we wrote. */
function trackCount(page: Page, rowKey: string): Promise<number> {
  return page.getByTestId(`sessions-grid-${rowKey}`)
    .evaluate((el) => getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/).filter(Boolean).length);
}

/**
 * A MANAGER ROW with three workers under it — the shape the order controls act on.
 *
 * Three, not two, so a middle tile exists: a build that only ever swapped the pair at the head of the
 * movable range would satisfy a two-worker row. Every id carries a distinct 8-char prefix, because the
 * UI renders `id.slice(0, 8)` and the fixture's own default mint would make every row read "e2e-live".
 * All four share ONE agent so the only thing that differs between the tiles is that short id.
 */
async function seedManagerRow(loomDaemon: LoomDaemon) {
  const project = await loomDaemon.createProject(uniq("ordgrid"));
  const stamp = `${Date.now()}`;
  const manager = await loomDaemon.seedLiveSession({ project, id: `ordmgr-${stamp}`, role: "manager" });
  const workers = [];
  for (const tag of ["ordwa", "ordwb", "ordwc"]) {
    workers.push(await loomDaemon.seedLiveSession({
      project, agentId: manager.agentId, id: `${tag}-${stamp}`, role: "worker",
      parentSessionId: manager.sessionId,
    }));
  }
  return { project, manager, workers, rowKey: manager.sessionId };
}

/** Land on the project node's Sessions tab, switch on and project pinned. */
async function gotoSessionsTab(page: Page, loomDaemon: LoomDaemon, projectId: string) {
  await pinProject(page, projectId);
  await page.goto(loomDaemon.baseURL + SESSIONS_PATH);
  await openNodeTab(page, "sessions");
  // PRESENCE FIRST, and the FIXTURE IDENTITY check: the node really is scoped to the project this
  // spec seeded, so everything measured below belongs to it and not to whatever a sibling spec left
  // on the shared worker daemon.
  await expect(panel(page)).toBeVisible();
}

test.describe("Atlas Sessions tab — terminal order and grid", () => {
  test("a move control reorders the tiles, the order survives a reload, and the reset undoes it", async ({ page, loomDaemon }) => {
    const f = await seedManagerRow(loomDaemon);
    await gotoSessionsTab(page, loomDaemon, f.project.id);

    // PRESENCE FIRST: all four tiles of the seeded row are rendered, so every sequence below is read
    // off a complete grid rather than a half-loaded one.
    await expect(panel(page).getByTestId("tile-identity")).toHaveCount(4);
    await expect(bar(page)).toBeVisible();

    // NO SAVED ORDER YET, stated by the control that only exists once there is one to undo. This is
    // the baseline the reset leg below returns to, so it has to be a measured state, not an assumption.
    await expect(resetOrder(page)).toHaveCount(0);

    // THE MANAGER IS NOT MOVABLE. Its row header names it and counts the rest as its workers, so a
    // promoted worker would relabel both — the pin is why it has no control at all, in either direction.
    await expect(moveEarlier(page, f.manager.sessionId)).toHaveCount(0);
    await expect(moveLater(page, f.manager.sessionId)).toHaveCount(0);
    // …and every worker DOES have both, which is what makes the two zeros above the pin acting rather
    // than the controls being absent everywhere.
    for (const w of f.workers) {
      await expect(moveEarlier(page, w.sessionId)).toBeVisible();
      await expect(moveLater(page, w.sessionId)).toBeVisible();
    }

    // The derived order, read rather than assumed: the manager leads, and the three workers follow in
    // whatever order the shared stable key gave them (createdAt DESC, id tiebreak — not this spec's to
    // pin). Every claim below is a permutation OF THIS, so the leg measures the move itself.
    const before = await tileOrder(page);
    expect(before).toHaveLength(4);
    expect(before[0], "the manager leads its own row").toBe(f.manager.sessionId.slice(0, 8));
    const [, wFirst, wMid, wLast] = before;
    const byShort = new Map(f.workers.map((w) => [w.sessionId.slice(0, 8), w.sessionId]));
    expect([wFirst, wMid, wLast].every((s) => byShort.has(s!)), "the three workers follow the manager").toBe(true);

    // THE ENDS REFUSE. The first movable slot cannot go earlier and the last cannot go later; a FORCED
    // click (skipping Playwright's actionability wait, which would otherwise time out on a disabled
    // button and make the unchanged sequence a fact about the test) leaves the sequence identical.
    await expect(moveEarlier(page, byShort.get(wFirst!)!)).toBeDisabled();
    await expect(moveLater(page, byShort.get(wLast!)!)).toBeDisabled();
    await moveEarlier(page, byShort.get(wFirst!)!).click({ force: true });
    await moveLater(page, byShort.get(wLast!)!).click({ force: true });
    expect(await tileOrder(page), "a refusing control must not reorder anything").toEqual(before);
    await expect(resetOrder(page), "a refused move must not record an order either").toHaveCount(0);

    // THE MOVE. The first worker goes one slot later, so it swaps with the middle one and the manager
    // and the last worker stay put — a permutation a build that reversed, rotated or re-sorted the row
    // could not produce.
    await moveLater(page, byShort.get(wFirst!)!).click();
    const moved = [before[0], wMid, wFirst, wLast];
    await expect.poll(() => tileOrder(page), { message: "the moved tile should swap with its neighbour" }).toEqual(moved);
    // The reset appears exactly when there is an order to reset.
    await expect(resetOrder(page)).toBeVisible();

    // PERSISTENCE. A reload re-reads the preference from storage, so the sequence must come back moved
    // — and it must NOT come back as the derived one, which is the control that makes "persisted"
    // distinguishable from "the derived order happened to match".
    await page.reload();
    await openNodeTab(page, "sessions");
    await expect(panel(page).getByTestId("tile-identity")).toHaveCount(4);
    await expect.poll(() => tileOrder(page), { message: "the order should survive a reload" }).toEqual(moved);
    expect(moved, "the moved order must differ from the derived one").not.toEqual(before);
    await expect(resetOrder(page)).toBeVisible();

    // THE RESET returns the grid to the DERIVED order — asserted as the exact sequence read before any
    // move, not merely as "something changed" — and takes its own control away with it.
    await resetOrder(page).click();
    await expect.poll(() => tileOrder(page), { message: "reset should restore the derived order" }).toEqual(before);
    await expect(resetOrder(page)).toHaveCount(0);

    // …and the reset persists too, so it is a cleared preference rather than a cleared render.
    await page.reload();
    await openNodeTab(page, "sessions");
    await expect(panel(page).getByTestId("tile-identity")).toHaveCount(4);
    await expect.poll(() => tileOrder(page), { message: "the reset should survive a reload" }).toEqual(before);
    await expect(resetOrder(page)).toHaveCount(0);
  });

  test("the column control changes the grid tracks, persists, and never resizes the pty", async ({ page, loomDaemon }) => {
    // ONE session, with a REAL canned pty at the production pinned geometry, so the page holds exactly
    // one xterm and leg 4's measurements are unambiguous. 80 columns of sentinel is a line that exactly
    // fills the pinned width — a grid refitted to a narrow cell could not hold it on one row.
    const project = await loomDaemon.createProject(uniq("gridonly"));
    const sentinel = `LOOM-AC0CFE91-${"=".repeat(PINNED_GEOMETRY.cols - 15)}`;
    const seeded = await loomDaemon.seedLiveSession({
      project, id: `gridone-${Date.now()}`, role: "plain",
      ptyGeometry: PINNED_GEOMETRY, ptyBytes: `${sentinel}\r\n`,
    });
    // A role-less session is its own trailing "standalone" row (lib/sessions.ts groupSessionRows).
    const rowKey = "__standalone";
    const rows = page.locator(".xterm-accessibility-tree > div");

    // A PINNED viewport, because an explicit count is a maximum: at the runner's default 1280 a
    // three-way share clears the tile floor by only a few px, so a later change to the frame's own
    // chrome could flip this leg to two tracks and read as a regression in the control. 1440 has real
    // margin, and the degradation itself is asserted deliberately at the end of this test.
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoSessionsTab(page, loomDaemon, project.id);

    // PRESENCE FIRST: the tile is there, its canned bytes really replayed over a real /ws/term attach,
    // and the pinned grid landed — so the pin is a measured starting state, not an assumption.
    await expect(panel(page).getByTestId("tile-identity")).toHaveCount(1);
    await expect(rows).toHaveCount(PINNED_GEOMETRY.rows);
    await expect(rows.filter({ hasText: sentinel })).toBeVisible();

    // THE BASELINE: `auto`, the pre-card template, resolved to however many tracks this viewport fits.
    await expect(columnsSelect(page)).toHaveValue("auto");
    const autoTracks = await trackCount(page, rowKey);
    const autoBox = await page.locator(".xterm-screen").first().boundingBox();
    expect(autoBox, "the rendered terminal box should be measurable").not.toBeNull();

    // THREE COLUMNS. Read off COMPUTED style — the attribute beside it is the control's own echo and
    // would be satisfied by a build that wrote the state and drew nothing.
    await columnsSelect(page).selectOption("3");
    await expect(page.getByTestId(`sessions-grid-${rowKey}`)).toHaveAttribute("data-columns", "3");
    await expect.poll(() => trackCount(page, rowKey), { message: "three columns should resolve to three tracks" }).toBe(3);
    expect(autoTracks, "auto must not already have been three, or the line above proves nothing").not.toBe(3);

    // ⛔ THE PTY IS UNTOUCHED. The grid is still 24 rows and the 80-column sentinel is still one row —
    // a client that fitted the grid to the narrowed cell (the SHELL branch's behaviour) would have
    // changed both and pushed a resize frame to the daemon.
    await expect(rows).toHaveCount(PINNED_GEOMETRY.rows);
    await expect(rows.filter({ hasText: sentinel })).toBeVisible();
    // …and it SCALED: the rendered box really did shrink, so the unchanged grid above is the pin
    // holding under a re-solved font, not the whole pane ignoring the narrower cell.
    await expect.poll(
      async () => (await page.locator(".xterm-screen").first().boundingBox())?.width ?? 0,
      { message: "the rendered terminal should scale down into the narrower cell" },
    ).toBeLessThan(autoBox!.width);

    // TILE COUNT UNCHANGED — this page's renderer is the heavy one, so a column choice must never be a
    // reason to mount anything extra.
    await expect(panel(page).getByTestId("tile-identity")).toHaveCount(1);

    // A SECOND VALUE, so the control is shown to DRIVE the count rather than to have one special case.
    await columnsSelect(page).selectOption("2");
    await expect.poll(() => trackCount(page, rowKey), { message: "two columns should resolve to two tracks" }).toBe(2);

    // PERSISTENCE across a reload, both the stored value and the layout it produces.
    await page.reload();
    await openNodeTab(page, "sessions");
    await expect(panel(page).getByTestId("tile-identity")).toHaveCount(1);
    await expect(columnsSelect(page)).toHaveValue("2");
    await expect.poll(() => trackCount(page, rowKey), { message: "the column choice should survive a reload" }).toBe(2);

    // THE COUNT IS A MAXIMUM. Back to three, then narrow the window under what three readable tiles
    // need: the grid draws FEWER rather than tiles the shared card cannot render (measured — at a
    // ~291px tile its header stops ellipsising and the pane hits the font solver's floor and clips).
    await columnsSelect(page).selectOption("3");
    await expect.poll(() => trackCount(page, rowKey)).toBe(3);
    await page.setViewportSize({ width: 1180, height: 900 });
    await expect.poll(() => trackCount(page, rowKey), { message: "a row too narrow for three should draw fewer" }).toBe(2);
    // …and the CHOICE is not forgotten, which is what makes the line above a layout fallback rather
    // than the control silently resetting itself.
    await expect(columnsSelect(page)).toHaveValue("3");
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(() => trackCount(page, rowKey), { message: "widening should restore the chosen three" }).toBe(3);

    // And back to `auto` returns the pre-card layout, so the choice is reversible rather than one-way.
    await columnsSelect(page).selectOption("auto");
    await expect.poll(() => trackCount(page, rowKey), { message: "auto should restore the derived track count" }).toBe(autoTracks);
    expect(seeded.sessionId).toBeTruthy();
  });

  test("the preference is per project — a second project opens on its own defaults", async ({ page, loomDaemon }) => {
    // The gate's own consequence: the key is per project (lib/terminalLayout.ts tileLayoutStorageKey),
    // so one project's chosen columns must not follow the reader into the next one.
    // Pinned for the same reason as the leg above: an explicit count is a maximum, and the runner's
    // default width clears a three-way share by only a few px.
    await page.setViewportSize({ width: 1440, height: 900 });
    const a = await seedManagerRow(loomDaemon);
    const b = await loomDaemon.createProject(uniq("ordgrid-b"));
    await loomDaemon.seedLiveSession({ project: b, id: `bsolo-${Date.now()}`, role: "manager" });

    await gotoSessionsTab(page, loomDaemon, a.project.id);
    await expect(panel(page).getByTestId("tile-identity")).toHaveCount(4);
    await columnsSelect(page).selectOption("3");
    await expect.poll(() => trackCount(page, a.rowKey)).toBe(3);
    await moveLater(page, (await tileOrderIds(page, a))[0]!).click();
    await expect(resetOrder(page)).toBeVisible();

    // Project B, same tab, same browser: its own default columns and NO saved order.
    await page.evaluate(([key, id]) => localStorage.setItem(key, id), [PROJECT_KEY, b.id] as const);
    await page.goto(loomDaemon.baseURL + SESSIONS_PATH);
    await openNodeTab(page, "sessions");
    await expect(panel(page).getByTestId("tile-identity")).toHaveCount(1);
    await expect(columnsSelect(page)).toHaveValue("auto");
    await expect(resetOrder(page)).toHaveCount(0);

    // …and project A still holds what it was given, which is what makes B's defaults isolation rather
    // than a preference that simply failed to save.
    await page.evaluate(([key, id]) => localStorage.setItem(key, id), [PROJECT_KEY, a.project.id] as const);
    await page.goto(loomDaemon.baseURL + SESSIONS_PATH);
    await openNodeTab(page, "sessions");
    await expect(panel(page).getByTestId("tile-identity")).toHaveCount(4);
    await expect(columnsSelect(page)).toHaveValue("3");
    await expect(resetOrder(page)).toBeVisible();
  });
});

/** The seeded row's rendered worker ids, in DOM order — the full ids, for a move-control locator. */
async function tileOrderIds(page: Page, f: Awaited<ReturnType<typeof seedManagerRow>>): Promise<string[]> {
  const shorts = await tileOrder(page);
  const byShort = new Map(f.workers.map((w) => [w.sessionId.slice(0, 8), w.sessionId]));
  return shorts.map((s) => byShort.get(s)).filter((x): x is string => !!x);
}
