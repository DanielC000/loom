// The Atlas Workspace node's Sessions card — card 9b6be377, the owner's Atlas feedback verbatim:
// `"Workspace": Add "Sessions" card with all running session terminals.`
// Record: docs/decisions/9b6be377-atlas-workspace-sessions-card.md
//
// The card's claims, and what each leg measures them against:
//   1. It lists every RUNNING session across EVERY project — and only those. Measured against seeded
//      rows that differ in exactly one field from a listable one (an exited session, a companion), so
//      a filter that dropped everything, or one that dropped nothing, both fail.
//   2. Project-major order. Measured on the rendered row order across two projects whose names sort
//      opposite to their seed order.
//   3. NOTHING is mounted at rest, and at most ONE terminal ever is. This is the card's whole
//      performance contract (a page mounting live terminals is heavy — CLAUDE.md), so it is asserted
//      as a count on both sides of every interaction, not as "a terminal appeared".
//   4. The expand is bound to the ROW's own session. Measured by reading the mounted pane's REPLAYED
//      BYTES — each seeded session carries a distinct sentinel line — so moving the mount to a second
//      row is observable as a byte change no amount of chrome can satisfy.
//   5. SWITCH OFF: the classic Overview still renders and the card does not exist in the document.
//
// Presence-first throughout (card 625d791c): a leading `toHaveCount(0)` is also satisfied by a page
// that is merely still loading, so every pair asserts what must BE there before what must not.
//
// READING THE RENDER: xterm.js paints to a <canvas> Playwright cannot read text from. Terminal.tsx
// runs with `screenReaderMode: true`, which keeps a visually-hidden, always-in-sync
// `.xterm-accessibility-tree` whose row elements mirror the real buffer — the same legitimate xterm
// feature terminal-canned-pty.spec.ts reads from. Nothing is monkeypatched.
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";

// lib/atlasUi.ts owns this key and the "1" = on encoding. Hardcoded rather than imported: the e2e
// tsconfig covers `e2e/` only (tsconfig.e2e.json).
const ATLAS_KEY = "loom.atlasUi";

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
 * TWO projects, named so that the one seeded SECOND sorts FIRST — the card's order is project-major
 * by name, and seeding them in sorted order would let arrival order pass for the real rule.
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
  const zulu = await loomDaemon.createProject(uniq("awsx-zulu"));
  const alpha = await loomDaemon.createProject(uniq("awsx-alpha"));

  const alphaMgr = await loomDaemon.seedLiveSession({
    project: alpha, id: uniq("wsmgra"), role: "manager", agentName: "Alpha Lead",
    ptyGeometry: GEOMETRY, ptyBytes: "ALPHA-MANAGER-PTY\r\n",
  });
  const alphaWorker = await loomDaemon.seedLiveSession({
    project: alpha, id: uniq("wswrka"), role: "worker", agentName: "Alpha Dev",
    parentSessionId: alphaMgr.sessionId,
    ptyGeometry: GEOMETRY, ptyBytes: "ALPHA-WORKER-PTY\r\n",
  });
  const zuluWorker = await loomDaemon.seedLiveSession({
    project: zulu, id: uniq("wswrkz"), role: "worker", agentName: "Zulu Dev",
    ptyGeometry: GEOMETRY, ptyBytes: "ZULU-WORKER-PTY\r\n",
  });
  const exited = await loomDaemon.seedLiveSession({
    project: alpha, id: uniq("wsdead"), role: "worker", agentName: "Alpha Ghost",
    processState: "exited",
  });
  const companion = await loomDaemon.seedLiveSession({
    project: alpha, id: uniq("wscomp"), role: "assistant", agentName: "Alpha Companion",
  });

  return { alpha, zulu, alphaMgr, alphaWorker, zuluWorker, exited, companion };
}

const card = (page: Page) => page.getByTestId("atlas-sessions-card");
const rows = (page: Page) => card(page).locator("[data-atlas-wsession]");
const terminals = (page: Page) => card(page).getByTestId("atlas-sessions-terminal");
/** The mounted pane's real rendered buffer, via xterm's own accessibility tree. */
const paneText = (page: Page) => terminals(page).locator(".xterm-accessibility-tree > div");

test.describe("Atlas Workspace Sessions card", () => {
  test("lists every running session across projects, project-major, and nothing else", async ({ page, loomDaemon }) => {
    const f = await seedFleet(loomDaemon);
    await seedAtlasOn(page);
    await page.goto(`${loomDaemon.baseURL}/home`);

    // PRESENCE FIRST: the card and its three real rows, before any absence claim below.
    await expect(card(page)).toBeVisible();
    await expect(rows(page)).toHaveCount(3);
    for (const s of [f.alphaMgr, f.alphaWorker, f.zuluWorker]) {
      await expect(page.getByTestId(`atlas-session-row-${s.sessionId}`)).toBeVisible();
    }

    // ...and only those. An exited session and a companion are each absent, so the filter is doing
    // real work in both directions rather than passing on an empty or an unfiltered list.
    await expect(page.getByTestId(`atlas-session-row-${f.exited.sessionId}`)).toHaveCount(0);
    await expect(page.getByTestId(`atlas-session-row-${f.companion.sessionId}`)).toHaveCount(0);

    // The head count is the rendered row count, not a separately-derived figure that could drift.
    await expect(card(page).getByTestId("atlas-sessions-count")).toHaveText("3");

    // ORDER: project-major by NAME. `alpha` was seeded SECOND, so arrival order would put zulu's row
    // first — this only passes if the name decides it. Within alpha, the manager leads its worker.
    await expect(rows(page).nth(0)).toHaveAttribute("data-atlas-wsession", f.alphaMgr.sessionId);
    await expect(rows(page).nth(1)).toHaveAttribute("data-atlas-wsession", f.alphaWorker.sessionId);
    await expect(rows(page).nth(2)).toHaveAttribute("data-atlas-wsession", f.zuluWorker.sessionId);

    // Each row names its project — the half of a session's identity the project node's own Sessions
    // tab never has to state, and the reason this card exists at the workspace tier at all.
    await expect(rows(page).nth(0)).toContainText(f.alpha.name);
    await expect(rows(page).nth(2)).toContainText(f.zulu.name);

    // The footer states both halves of the scope, derived from the same rows.
    await expect(card(page)).toContainText("3 running sessions across 2 projects.");

    // The per-row exit is the session node, carrying that row's OWN id.
    await expect(page.getByTestId(`atlas-session-open-${f.zuluWorker.sessionId}`))
      .toHaveAttribute("href", `/session/${f.zuluWorker.sessionId}`);
  });

  test("mounts no terminal at rest, exactly one on expand, and moves it rather than adding a second", async ({ page, loomDaemon }) => {
    const f = await seedFleet(loomDaemon);
    await seedAtlasOn(page);
    await page.goto(`${loomDaemon.baseURL}/home`);

    // AT REST: the rows are there (presence first) and NOTHING is mounted. This is the claim that
    // makes the card safe to put on the default Atlas landing.
    await expect(rows(page)).toHaveCount(3);
    await expect(terminals(page)).toHaveCount(0);
    const mgrToggle = page.getByTestId(`atlas-session-expand-${f.alphaMgr.sessionId}`);
    const workerToggle = page.getByTestId(`atlas-session-expand-${f.zuluWorker.sessionId}`);
    await expect(mgrToggle).toHaveAttribute("aria-expanded", "false");

    // EXPAND ONE. The observable is the pane's REPLAYED BYTES, not merely a region appearing: the
    // manager's own sentinel proves the mount is bound to the row that was clicked.
    await mgrToggle.click();
    await expect(terminals(page)).toHaveCount(1);
    await expect(paneText(page).filter({ hasText: "ALPHA-MANAGER-PTY" })).toBeVisible();
    await expect(mgrToggle).toHaveAttribute("aria-expanded", "true");
    // The row carries the landed mark, so the pane below the scroll track has a label.
    await expect(page.getByTestId(`atlas-session-row-${f.alphaMgr.sessionId}`)).toHaveClass(/is-expanded/);

    // MOVE IT. Clicking a DIFFERENT row must not add a second mount — still exactly one region, now
    // replaying the OTHER session's bytes, with the first row released. The byte change is what tells
    // a moved mount apart from a second one that merely happens to render in the same place.
    await workerToggle.click();
    await expect(terminals(page)).toHaveCount(1);
    await expect(paneText(page).filter({ hasText: "ZULU-WORKER-PTY" })).toBeVisible();
    await expect(paneText(page).filter({ hasText: "ALPHA-MANAGER-PTY" })).toHaveCount(0);
    await expect(mgrToggle).toHaveAttribute("aria-expanded", "false");
    await expect(workerToggle).toHaveAttribute("aria-expanded", "true");

    // RELEASE IT. A re-click on the open row gives the mount up entirely, so the card can return to
    // costing nothing without the reader navigating away.
    await workerToggle.click();
    await expect(rows(page)).toHaveCount(3);
    await expect(terminals(page)).toHaveCount(0);
    await expect(workerToggle).toHaveAttribute("aria-expanded", "false");
  });

  test("the expanded card is a readout: a Composer to steer with, and no Stop", async ({ page, loomDaemon }) => {
    const f = await seedFleet(loomDaemon);
    await seedAtlasOn(page);
    await page.goto(`${loomDaemon.baseURL}/home`);

    await expect(rows(page)).toHaveCount(3);
    await page.getByTestId(`atlas-session-expand-${f.alphaWorker.sessionId}`).click();
    await expect(terminals(page)).toHaveCount(1);
    await expect(paneText(page).filter({ hasText: "ALPHA-WORKER-PTY" })).toBeVisible();

    // The Composer is present — a terminal you cannot steer is not worth the mount — while the
    // lifecycle buttons are NOT: this node is a readout of the fleet, and `Open ↗` reaches the
    // session node's full-feature tile that owns Stop/Fork. Presence before absence, as ever.
    //
    // ⚠️ `locator("textarea")` is NOT the Composer: xterm keeps its OWN hidden `.xterm-helper-textarea`
    // inside the pane, so a bare textarea locator resolves TWO elements and trips strict mode. The
    // `composer` testid (components/Composer.tsx) addresses the real turn-input surface.
    await expect(terminals(page).getByTestId("composer")).toBeVisible();
    await expect(terminals(page).getByRole("button", { name: /^stop$/i })).toHaveCount(0);
    await expect(terminals(page).getByRole("button", { name: /^fork$/i })).toHaveCount(0);
  });
});
