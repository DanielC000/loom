// HUG-tile font RE-GROW on queue drain (fix(web): a shrunk terminal must restore when a queued-message
// strip drains). REGRESSION for the owner-observed Platform bug: on a HUG numeric-height tile, sending a
// message while the session is busy queues it → the SessionQueue strip appears and the terminal font/grid
// SHRINKS to make room; when the queue DRAINS the strip vanishes but the terminal font DID NOT restore —
// it stayed shrunk until an unrelated re-render forced a re-measure (Terminal.tsx's applyFontSize only
// re-fired on the pane's OWN ResizeObserver, which latched at the shrunk grid height on a grow-back).
//
// This drives the REAL render hop hermetically — no daemon change, no real claude spawn:
//   • Seed the End-User Platform "Operator session" as a CANNED-pty HUG tile (the shipping
//     PlatformSessionTile, height 480, subPanels.queue — the IDENTICAL component the LOOM_DEV-gated 440px
//     Platform grid mounts, reachable here at LOOM_DEV=0). A TALL pinned grid (80×40) in a wide/short tile
//     makes the terminal HEIGHT-bound, so the pane's rendered height tracks the budget directly — the
//     property the shrink/regrow is visible through.
//   • Force a HELD queue entry with TWO POST /input calls: the first delivers immediately and arms the
//     canned session busy (reconcile() SKIPS canned entries, so busy never self-clears); the second lands
//     while busy and is HELD in the FIFO — exactly the "Send while busy" queue the owner hit.
//   • Remove the held entry (the ✕ control) to DRAIN the strip, and assert the pane's offsetHeight returns
//     to its pre-queue value.
//
// SCOPE NOTE — this is a behavior LOCK on the restore, not a fix-discriminating repro. With a CANNED pty
// the incidental restore path (TerminalCard rewrites the pane's inline height to the regrown budget, which
// fires Terminal.tsx's ResizeObserver(el) → applyFontSize) already re-grows the font, so this spec passes
// both with and without the fix in THIS harness. The fix makes grow-back EXPLICIT — applyFontSize is driven
// directly off the heightBudget prop change, not left to rely on that ResizeObserver(el) side effect firing
// (a dropped/coalesced RO delivery on the drain frame in the live app is the owner-observed latch). This
// spec guarantees the restore stays green as that mechanism evolves.
import { expect, test } from "./fixtures/daemon";

const rowsLocator = (page: import("@playwright/test").Page) => page.locator(".xterm-accessibility-tree > div");

// The single live terminal pane's own box height — the element applyFontSize (Terminal.tsx) sizes to the
// rendered grid. In HEIGHT-bound HUG mode this tracks the height budget, so it shrinks when the queue strip
// steals space and must grow back when it drains.
const paneHeight = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const xterm = document.querySelector(".xterm");
    return xterm ? (xterm.parentElement as HTMLElement).offsetHeight : null;
  });

test("a HUG tile's terminal font restores after a queued-message strip drains", async ({ page, loomDaemon }) => {
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
    ptyBytes: "LOOM-HUG-REGROW\r\nqueue-drain restores the font\r\n",
  });

  await page.goto(`${loomDaemon.baseURL}/platform`);

  // The operator tile mounts with a REAL canned terminal: the pinned 40-row grid renders.
  await expect(page.getByText("Operator session", { exact: false }).first()).toBeVisible();
  await expect(rowsLocator(page)).toHaveCount(40);
  await expect(rowsLocator(page).filter({ hasText: "LOOM-HUG-REGROW" })).toBeVisible();

  // Let the height-budget measure + font scale settle, then capture the pre-queue pane height.
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
  const held = await (await send("queued while busy — this is the strip")).json();
  expect(held.delivered).toBe(false); // held in the FIFO, not delivered

  // The queue strip appears (SessionQueue polls every 3s) and the terminal SHRINKS to make room.
  await expect(page.getByText(/Queued \(1\)/)).toBeVisible({ timeout: 8000 });
  let shrunkH = beforeH;
  await expect
    .poll(async () => (shrunkH = (await paneHeight(page)) ?? 0), { timeout: 5000 })
    .toBeLessThan(beforeH);

  // DRAIN: remove the held entry. The strip vanishes and the terminal must re-grow to fill the reclaimed
  // space — the whole point of the fix. Pre-fix the pane stayed pinned at `shrunkH`.
  await page.getByTitle("Remove from queue").click();
  await expect(page.getByText(/Queued/)).toHaveCount(0);

  await expect
    .poll(async () => (await paneHeight(page)) ?? 0, { timeout: 5000 })
    .toBeGreaterThanOrEqual(beforeH - 2);

  // The restore is exact (integer grid height), not just "grew a bit past shrunk".
  const afterH = (await paneHeight(page)) ?? 0;
  expect(Math.abs(afterH - beforeH)).toBeLessThanOrEqual(2);
});
