// Card 019d2e7a — a terminal pane must RE-ATTACH after its socket closes, and must SURVIVE a same-session
// respawn. Before this, a `/ws/term` close wrote "[connection closed]" and stopped there: after any daemon
// restart every open tile in the Overview cockpit (which embeds these panes) was dead until you navigated
// away and back, and a Stop→Resume left the pane frozen on the dead pty's last screen while keystrokes
// still reached the NEW one.
//
// Both halves are driven against the ISOLATED fixture daemon (its own temp LOOM_HOME, an OS-assigned port,
// the first-run marker pre-stamped so no real claude can auto-launch — see fixtures/daemon.ts). The owner's
// real daemon on :4317 is never touched.
//
// READING THE RENDER: as in terminal-canned-pty.spec.ts, xterm's Canvas renderer is unreadable to
// Playwright, so these assertions go through the visually-hidden `.xterm-accessibility-tree` — a real xterm
// accessibility feature kept in sync with the rendered buffer, not a monkeypatch. Nothing here stubs the
// WebSocket: the drop is a REAL transport drop (`context.setOffline`) and the respawn is the REAL
// `PtyHost.adoptSubscribers` chokeoint a live Stop→Resume runs.
import { expect, test, type Page } from "./fixtures/daemon";

const rows = (page: Page) => page.locator(".xterm-accessibility-tree > div");
const rowsText = (page: Page) => rows(page).filter({ hasText: /\S/ });
const reconnectStrip = (page: Page) => page.locator('[data-terminal-state="reconnecting"]');

declare global {
  interface Window {
    /** Every `{type:"stdin"}` frame the page has sent, recorded at the real transport. */
    __loomStdin?: string[];
    /** Every `/ws/term` socket the page has constructed, so the test can drop the live one. */
    __loomTermSockets?: WebSocket[];
  }
}

/**
 * Wraps `WebSocket.prototype.send` and the `WebSocket` constructor BEFORE any page script runs, to
 * OBSERVE stdin frames and to keep a handle on each `/ws/term` socket. It only observes — it never
 * substitutes or mocks the socket, so the terminal attaches, streams and reconnects for real.
 *
 * The send-recorder is the recipe from companion-terminal-readonly.spec.ts: the obvious DOM witness for
 * "can this pane write" does not exist (xterm's `disableStdin` sets no attribute, and a disconnected
 * socket sets nothing at all), so the only sound witness is the wire.
 */
async function instrumentSockets(page: Page) {
  await page.addInitScript(() => {
    window.__loomStdin = [];
    window.__loomTermSockets = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (this: WebSocket, data: Parameters<WebSocket["send"]>[0]) {
      if (typeof data === "string" && data.includes('"stdin"')) window.__loomStdin!.push(data);
      return send.call(this, data);
    };
    const Native = window.WebSocket;
    const Patched = function (this: WebSocket, url: string | URL, protocols?: string | string[]) {
      const ws = new Native(url, protocols);
      if (String(url).includes("/ws/term/")) window.__loomTermSockets!.push(ws);
      return ws;
    } as unknown as typeof WebSocket;
    Patched.prototype = Native.prototype;
    for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) {
      Object.defineProperty(Patched, k, { value: Native[k] });
    }
    window.WebSocket = Patched;
  });
}
const stdinCount = (page: Page) => page.evaluate(() => window.__loomStdin?.length ?? 0);

/**
 * Drops the pane's live socket and HOLDS it down until `restoreNetwork`.
 *
 * `context.setOffline(true)` alone is NOT enough — measured here: Chromium's offline emulation blocks NEW
 * requests but leaves an already-established WebSocket up, so the pane never saw a close at all and this
 * spec's first run failed on an absent reconnect strip. So the close is issued explicitly on the socket
 * the init script recorded, which raises the SAME `onclose` event a daemon restart's TCP teardown raises —
 * that event is the entire input to the behaviour under test. Offline mode is then what makes the
 * DOWN WINDOW deterministic: without it the pane reconnects on its ~1s backoff and the "no stdin while
 * disconnected" assertion becomes a race against that timer rather than a measurement.
 */
async function dropAndHoldDown(page: Page, context: import("@playwright/test").BrowserContext) {
  await context.setOffline(true);
  await page.evaluate(() => { for (const ws of window.__loomTermSockets ?? []) ws.close(); });
}
const restoreNetwork = (context: import("@playwright/test").BrowserContext) => context.setOffline(false);

test("a pane reconnects and repaints after its socket drops, and sends no stdin while it is down", async ({ page, context, loomDaemon }) => {
  const geometry = { cols: 60, rows: 16 };
  const marker = "LOOM-REATTACH-019d2e7a";
  const seeded = await loomDaemon.seedLiveSession({ role: "plain", ptyGeometry: geometry, ptyBytes: `${marker}\r\n` });

  await instrumentSockets(page);
  await page.goto(`${loomDaemon.baseURL}/session/${seeded.sessionId}`);

  // ── BEFORE: attached, painted, writable ──────────────────────────────────────────────────────────
  await expect(rows(page)).toHaveCount(geometry.rows);
  await expect(rows(page).filter({ hasText: marker })).toBeVisible();
  await expect(reconnectStrip(page)).toHaveCount(0);

  // POSITIVE CONTROL for the "no stdin while disconnected" assertion below. Without it, a recorder that
  // never fires and a pane that correctly withholds stdin produce the identical empty array — and the
  // assertion is an ABSENCE claim, the polarity that passes silently when the instrument is broken.
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("a");
  await expect.poll(() => stdinCount(page), { message: "a keystroke on a CONNECTED pane must reach the wire" }).toBeGreaterThan(0);
  const connectedFrames = await stdinCount(page);

  // ── THE DROP: the socket closes under the pane, the way a daemon restart closes it ──────────────
  await dropAndHoldDown(page, context);

  // The pane SAYS it is detached rather than looking like a live terminal gone quiet.
  await expect(reconnectStrip(page)).toBeVisible();
  await expect(reconnectStrip(page)).toContainText("Reconnecting");
  await expect(rowsText(page).filter({ hasText: "connection lost" })).toBeVisible();

  // ── EXERCISED WHILE DOWN: keystrokes are dropped, not buffered for a surprise replay later ───────
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("bcd");
  // Give the page real time to have sent something if it were going to — this is the one assertion here
  // that a too-early read could pass for the wrong reason.
  await page.waitForTimeout(500);
  expect(await stdinCount(page), "a disconnected pane must send no stdin").toBe(connectedFrames);

  // ── RECOVERY: no reload, no navigation — the pane heals itself ───────────────────────────────────
  await restoreNetwork(context);
  await expect(reconnectStrip(page)).toHaveCount(0, { timeout: 30_000 });

  // Repainted from the daemon's ring replay, and RESET first: the "[connection lost]" seam is gone and
  // the session's content is on screen exactly once, not stacked twice around it.
  await expect(rows(page).filter({ hasText: marker })).toBeVisible();
  await expect(rowsText(page).filter({ hasText: "connection lost" })).toHaveCount(0);
  await expect(rows(page).filter({ hasText: marker })).toHaveCount(1);

  // And it is writable again — proving the reconnect restored the transport, not just the pixels.
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("e");
  await expect.poll(() => stdinCount(page), { message: "a RECONNECTED pane must reach the wire again" }).toBeGreaterThan(connectedFrames);
});

test("a pane attached before a respawn follows the session onto the new pty", async ({ page, loomDaemon }) => {
  const geometry = { cols: 60, rows: 16 };
  const before = "LOOM-RESPAWN-BEFORE-019d2e7a";
  const after = "LOOM-RESPAWN-AFTER-019d2e7a";
  const seeded = await loomDaemon.seedLiveSession({ role: "plain", ptyGeometry: geometry, ptyBytes: `${before}\r\n` });

  await page.goto(`${loomDaemon.baseURL}/session/${seeded.sessionId}`);

  // ── BEFORE: the pane is showing the FIRST pty ────────────────────────────────────────────────────
  await expect(rows(page)).toHaveCount(geometry.rows);
  await expect(rows(page).filter({ hasText: before })).toBeVisible();

  // ── THE RESPAWN: the session's live entry is replaced under the SAME id, as a Stop→Resume does ───
  await loomDaemon.respawnSeededPty({ sessionId: seeded.sessionId, ptyGeometry: geometry, ptyBytes: `${after}\r\n` });

  // ── AFTER: the SAME, never-reloaded pane is showing the SECOND pty ───────────────────────────────
  // Pre-fix this sat frozen on `before` forever: the socket stayed open and attached to the discarded
  // Live, so nothing the successor produced ever reached it.
  await expect(rows(page).filter({ hasText: after })).toBeVisible();
  // …and the dead process's screen was CLEARED (the `reset` frame), not left underneath the new one.
  await expect(rows(page).filter({ hasText: before })).toHaveCount(0);
  // The pane never dropped its socket to do this — no "connection lost" seam.
  await expect(reconnectStrip(page)).toHaveCount(0);
  await expect(rowsText(page).filter({ hasText: "connection lost" })).toHaveCount(0);
});
