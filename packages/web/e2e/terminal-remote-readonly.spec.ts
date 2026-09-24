// Card 5c14fa6b — a REMOTE (non-loopback) terminal viewer must be TOLD its pane is view-only, and must
// stop putting stdin on the wire.
//
// THE DEFECT: since 710a34fa the daemon silently drops a remote peer's `{type:"stdin"}` frames. Silently
// is the whole problem — there is no error frame for a dropped stdin (by design), so a remote viewer got
// local xterm echo and nothing whatsoever happening, forever. The fix is a one-off `readOnly` control
// frame the daemon pushes on attach, which this pane turns into a visible note + an inert keyboard.
//
// ⚠️ WHAT THIS SPEC DOES AND DOES NOT PROVE — read before trusting it.
// This harness talks to `loomDaemon` over LOOPBACK, so it CANNOT produce a genuine non-loopback peer: the
// daemon would never classify this page as remote, and no amount of UI driving changes that. So this spec
// proves the WEB half only — given the frame, the pane behaves. It DRIVES THE COMPONENT WITH THE FRAME
// rather than earning it from a real remote attach.
// The daemon half — that a remote peer gets exactly this frame and a loopback peer gets none — is proven
// separately and hermetically in `packages/daemon/test/ws-term-remote-token-stdin.mjs` (section "(c)").
// Neither test alone covers the card; they are two halves of one claim, joined at the frame's literal
// shape, which is why BOTH spell `{type:"readOnly", reason:"remote"}` out verbatim rather than importing a
// helper that could drift in lockstep and hide a break.
import { expect, test } from "./fixtures/daemon";
import type { Page } from "@playwright/test";

const shortId = (id: string) => id.slice(0, 8);

const xtermScreen = (page: Page) => page.locator(".xterm-screen");

const readOnlyNote = (page: Page) => page.getByText("View-only from a remote device. Steer via the composer.");

// THE WITNESS. Records every `{type:"stdin"}` frame the page puts on ANY WebSocket, by wrapping
// WebSocket.prototype.send before page scripts run — the REAL /ws/term transport, not a proxy for it.
// (xterm's `disableStdin` sets NO `readonly` attribute on its helper textarea, so the obvious DOM witness
// does not exist; see project memory `xterm-disablestdin-has-no-readonly-attribute`.) It only records and
// always forwards, so the terminal still attaches for real.
//
// The same script installs the frame INJECTOR: a WebSocket wrapper that keeps every /ws/term socket the
// page opens, so the test can hand one the control frame the daemon would have sent a remote peer.
// `__loomForceReadOnly()` returns how many sockets it actually drove — asserted below, because "the note
// never appeared" and "the injector hit nothing" look identical from the DOM.
async function installTerminalProbe(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __loomStdin: string[]; __loomForceReadOnly: () => number };
    w.__loomStdin = [];
    const origSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data: Parameters<WebSocket["send"]>[0]) {
      try {
        if (typeof data === "string") {
          const msg = JSON.parse(data) as { type?: string; data?: string };
          if (msg?.type === "stdin") w.__loomStdin.push(msg.data ?? "");
        }
      } catch { /* binary pty bytes / non-JSON — never a stdin frame */ }
      return origSend.call(this, data);
    };

    const termSockets: WebSocket[] = [];
    const Orig = window.WebSocket;
    const Wrapped = function (this: unknown, url: string | URL, protocols?: string | string[]) {
      const ws = new Orig(url, protocols);
      if (String(url).includes("/ws/term/")) termSockets.push(ws);
      return ws;
    } as unknown as typeof WebSocket;
    Wrapped.prototype = Orig.prototype;
    for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) {
      (Wrapped as unknown as Record<string, unknown>)[k] = (Orig as unknown as Record<string, unknown>)[k];
    }
    window.WebSocket = Wrapped;

    w.__loomForceReadOnly = () => {
      let driven = 0;
      for (const ws of termSockets) {
        const handler = (ws as WebSocket & { onmessage: ((e: { data: string }) => void) | null }).onmessage;
        if (typeof handler === "function") { handler.call(ws, { data: JSON.stringify({ type: "readOnly", reason: "remote" }) }); driven++; }
      }
      return driven;
    };
  });
}

const stdinFrames = (page: Page) => page.evaluate(() => (window as unknown as { __loomStdin: string[] }).__loomStdin ?? []);

const forceReadOnly = (page: Page) => page.evaluate(() => (window as unknown as { __loomForceReadOnly: () => number }).__loomForceReadOnly());

async function typeIntoTerminal(page: Page, text: string) {
  await xtermScreen(page).first().click({ force: true });
  await page.keyboard.type(text);
}

test.describe("a remote terminal viewer is told its pane is read-only", () => {
  test("before/after on one live pane: writable, then the frame lands and input stops", async ({ page, loomDaemon }) => {
    const worker = await loomDaemon.seedLiveSession({ role: "worker", agentName: "Remote View Worker" });
    await installTerminalProbe(page);

    await page.goto(`${loomDaemon.baseURL}/session/${worker.sessionId}`);
    // Fixture identity: a sibling worker's dev server renders this app identically, so pin WHICH session
    // this is before drawing any conclusion from what is or is not on the page.
    await expect(page.getByText(new RegExp(shortId(worker.sessionId))).first()).toBeVisible();
    await expect(xtermScreen(page)).toHaveCount(1);

    // ── BEFORE: a loopback pane is writable and says nothing. This is DoD-3's "before" AND the positive
    // control that makes the zero below a measured zero — it proves the stdin recorder really records.
    await expect(readOnlyNote(page)).toHaveCount(0);
    await typeIntoTerminal(page, "ls");
    await expect.poll(() => stdinFrames(page).then((f) => f.join(""))).toContain("ls");

    // ── AFTER: hand the pane the exact frame a remote attach would have brought (see the header caveat).
    expect(await forceReadOnly(page)).toBeGreaterThan(0);

    await expect(readOnlyNote(page)).toBeVisible();

    // The terminal is NOT removed — the whole point of a view-only pane is that you can still watch and
    // still copy; only writing is taken away.
    await expect(xtermScreen(page)).toHaveCount(1);

    // THE SILENT SURFACE. Typing must now put NO {type:"stdin"} frame on the wire at all.
    const before = (await stdinFrames(page)).length;
    await typeIntoTerminal(page, "whoami");
    await page.waitForTimeout(300); // give a frame that WOULD be sent time to actually be sent
    expect((await stdinFrames(page)).slice(before)).toEqual([]);

    // And the note survives the typing attempt rather than being a one-shot flash.
    await expect(readOnlyNote(page)).toBeVisible();
  });

  test("a plain loopback pane never renders the note (no frame, no change)", async ({ page, loomDaemon }) => {
    const worker = await loomDaemon.seedLiveSession({ role: "worker", agentName: "Local View Worker" });
    await installTerminalProbe(page);

    await page.goto(`${loomDaemon.baseURL}/session/${worker.sessionId}`);
    await expect(page.getByText(new RegExp(shortId(worker.sessionId))).first()).toBeVisible();
    await expect(xtermScreen(page)).toHaveCount(1);

    // The note is driven ONLY by the daemon's frame, and this loopback attach is sent none — so an
    // over-broad fix that read-onlys every pane fails right here. The sibling test above is this
    // assertion's positive control: it proves the locator can find the note when it IS rendered.
    await typeIntoTerminal(page, "echo hi");
    await expect.poll(() => stdinFrames(page).then((f) => f.join(""))).toContain("echo hi");
    await expect(readOnlyNote(page)).toHaveCount(0);
  });
});
