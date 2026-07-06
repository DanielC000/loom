// Queued-messages "ledger bar" — the terminal region holds a FIXED height across every queue state
// (feat(web): Direction B queue redesign, owner-approved 2026-07-06). This LOCKS the core promise: on a
// HUG numeric-height tile, when a message queues while the session is busy the queue renders as a
// constant-height ledger bar that GROWS THE CARD — it must NOT shrink the terminal (the old behavior this
// replaces: the SessionQueue strip stole space and the terminal font/grid shrank, then failed to restore
// on drain — the owner-observed Platform bug). Here we assert the terminal pane height is unchanged when
// the bar appears, unchanged when the drawer expands, and unchanged when the queue drains.
//
// Drives the REAL render hop hermetically — no daemon change, no real claude spawn:
//   • Seed the End-User Platform "Operator session" as a CANNED-pty HUG tile (the shipping
//     PlatformSessionTile, height 480, subPanels.queue — the IDENTICAL component the LOOM_DEV-gated 440px
//     Platform grid mounts, reachable here at LOOM_DEV=0). A TALL pinned grid (80×40) in a wide/short tile
//     makes the terminal HEIGHT-bound, so the pane's rendered height tracks the budget directly — the
//     property the (non-)shrink is visible through.
//   • Force a HELD queue entry with TWO POST /input calls: the first delivers immediately and arms the
//     canned session busy (reconcile() SKIPS canned entries, so busy never self-clears); the second lands
//     while busy and is HELD in the FIFO — exactly the "Send while busy" queue the owner hit.
//   • Expand the ledger bar (the drawer reveals the ✕ control), then remove the held entry to DRAIN it —
//     asserting the pane's offsetHeight never moves across bar-appears / drawer-opens / queue-drains.
import { expect, test } from "./fixtures/daemon";

const rowsLocator = (page: import("@playwright/test").Page) => page.locator(".xterm-accessibility-tree > div");

// The single live terminal pane's own box height — the element applyFontSize (Terminal.tsx) sizes to the
// rendered grid. In HEIGHT-bound HUG mode this tracks the height budget; under Direction B that budget is
// invariant to the queue (TerminalCard excludes the ledger from the budget and grows the card instead), so
// this height must stay put as the queue appears, expands, and drains.
const paneHeight = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const xterm = document.querySelector(".xterm");
    return xterm ? (xterm.parentElement as HTMLElement).offsetHeight : null;
  });

test("a HUG tile's terminal height stays fixed when the queue ledger appears, expands, and drains", async ({ page, loomDaemon }) => {
  // Resolve the reserved Platform home + its operator agent exactly as EndUserPlatformView does.
  const home = await (await fetch(`${loomDaemon.baseURL}/api/setup/home`)).json();
  const profiles = await (await fetch(`${loomDaemon.baseURL}/api/profiles`)).json();
  const roleOf = (a: { profileId?: string | null }) =>
    profiles.find((p: { id: string; role: string }) => p.id === a.profileId)?.role ?? null;
  const operator = home.agents.find((a: { profileId?: string | null }) => roleOf(a) === "setup")
    ?? home.agents.find((a: { name: string }) => a.name === "Platform");
  expect(operator, "the reserved Platform home should seed an operator agent").toBeTruthy();

  // Seed the operator session as a CANNED-pty tile: a tall 80×40 grid + a couple of lines to render.
  const seeded = await loomDaemon.seedLiveSession({
    project: { id: home.project.id, name: home.project.name },
    agentId: operator.id,
    role: "setup",
    ptyGeometry: { cols: 80, rows: 40 },
    ptyBytes: "LOOM-QUEUE-LEDGER\r\nthe terminal never moves when the queue fills\r\n",
  });

  await page.goto(`${loomDaemon.baseURL}/platform`);

  // The operator tile mounts with a REAL canned terminal: the pinned 40-row grid renders.
  await expect(page.getByText("Operator session", { exact: false }).first()).toBeVisible();
  await expect(rowsLocator(page)).toHaveCount(40);
  await expect(rowsLocator(page).filter({ hasText: "LOOM-QUEUE-LEDGER" })).toBeVisible();

  // Let the height-budget measure + font scale settle, then capture the AT-REST pane height.
  await page.waitForTimeout(700);
  let beforeH = 0;
  await expect
    .poll(async () => (beforeH = (await paneHeight(page)) ?? 0), { timeout: 5000 })
    .toBeGreaterThan(0);

  // Force a HELD queue entry: first input delivers + arms busy; second is held while busy.
  const send = (text: string) =>
    fetch(`${loomDaemon.baseURL}/api/sessions/${seeded.sessionId}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  expect((await (await send("first turn — delivers and arms busy")).json()).delivered).toBe(true);
  const held1 = await (await send("first queued — the next-up ledger peek")).json();
  expect(held1.delivered).toBe(false); // held in the FIFO, not delivered

  // The ledger bar appears (SessionQueue polls every 3s). Direction B: the terminal must NOT shrink — the
  // bar grows the card instead. Assert the pane height is unchanged from at-rest.
  const bar = page.getByTestId("queue-ledger-bar");
  await expect(page.getByText(/Queued \(1\)/)).toBeVisible({ timeout: 8000 });
  await expect
    .poll(async () => (await paneHeight(page)) ?? 0, { timeout: 5000 })
    .toBeGreaterThanOrEqual(beforeH - 2);
  expect(Math.abs(((await paneHeight(page)) ?? 0) - beforeH), "terminal height unchanged when the ledger bar appears").toBeLessThanOrEqual(2);
  const barH1 = (await bar.boundingBox())?.height ?? 0;
  expect(barH1, "the ledger bar has a real height").toBeGreaterThan(0);

  // (b) CONSTANT-HEIGHT LEDGER — a card with 1 queued and a card with several queued look identical at
  // rest. Queue a second held entry and assert the collapsed bar's height did not change with backlog depth.
  const held2 = await (await send("second queued — deeper backlog, same bar height")).json();
  expect(held2.delivered).toBe(false);
  await expect(page.getByText(/Queued \(2\)/)).toBeVisible({ timeout: 8000 });
  const barH2 = (await bar.boundingBox())?.height ?? 0;
  expect(Math.abs(barH2 - barH1), "ledger bar height is constant across 1 vs 2 queued").toBeLessThanOrEqual(1);
  // The terminal still has not moved at the deeper backlog.
  expect(Math.abs(((await paneHeight(page)) ?? 0) - beforeH), "terminal height unchanged at a deeper backlog").toBeLessThanOrEqual(2);

  // (c) EXPAND → a BOUNDED, internally-scrollable drawer with the per-entry controls; the terminal must
  // still not move (the drawer grows the card). NOTE the height-bound canned grid (80×40 pinned to the
  // budget) drives xterm's applyFontSize into a cosmetic ±1px font settle, so the below-terminal chrome
  // jitters 1px — real WIDTH-bound production tiles (120 cols scaled to tile width) don't. We force past
  // that 1px actionability jitter; the height assertions (±2) are what verify the Direction B invariant.
  await bar.click({ force: true });
  const drawer = page.getByTestId("queue-drawer");
  await expect(drawer).toBeVisible();
  await expect(page.getByTitle("Remove from queue").first()).toBeVisible();
  // Bounded + scrollable: the drawer caps its height and scrolls internally rather than growing unbounded.
  const overflowY = await drawer.evaluate((el) => getComputedStyle(el).overflowY);
  expect(overflowY, "the drawer scrolls internally").toBe("auto");
  // (d) the human entries carry their reorder / edit / delete affordances.
  await expect(page.getByTitle("Move up").first()).toBeVisible();
  await expect(page.getByTitle("Edit this queued message").first()).toBeVisible();
  await expect(page.getByTitle("Remove from queue")).toHaveCount(2);
  expect(Math.abs(((await paneHeight(page)) ?? 0) - beforeH), "terminal height unchanged when the drawer expands").toBeLessThanOrEqual(2);

  // (d) DELETE works: remove one entry → the live count drops to (1); the terminal has still not moved.
  await page.getByTitle("Remove from queue").first().click({ force: true });
  await expect(page.getByText(/Queued \(1\)/)).toBeVisible({ timeout: 8000 });
  expect(Math.abs(((await paneHeight(page)) ?? 0) - beforeH), "terminal height unchanged after a delete").toBeLessThanOrEqual(2);

  // DRAIN the rest: the bar vanishes and the terminal is STILL at its at-rest height (it never gave up
  // space in the first place).
  await page.getByTitle("Remove from queue").first().click({ force: true });
  await expect(page.getByText(/Queued/)).toHaveCount(0);
  await expect
    .poll(async () => (await paneHeight(page)) ?? 0, { timeout: 5000 })
    .toBeGreaterThanOrEqual(beforeH - 2);
  expect(Math.abs(((await paneHeight(page)) ?? 0) - beforeH), "terminal height unchanged after the queue drains").toBeLessThanOrEqual(2);
});
