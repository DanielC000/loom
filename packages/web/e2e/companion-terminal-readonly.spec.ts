// Card 5c87f4b6 — a Companion's terminal must be WATCH-ONLY from every route, and every other session's
// terminal must stay fully writable.
//
// THE DEFECT: the "a companion is driven ONLY through its chat surface, never a raw pty tile + STDIN
// Composer" invariant was documented in two files and enforced in neither for the routes that render a
// terminal from an UNFILTERED session list. Two such routes existed:
//   • /session/:id (SessionView) — the destination a STUCK-BUSY attention alert deep-links to. `isStuckBusy`
//     is role-agnostic, so a wedged Companion raises an alert whose "Open" lands the owner right here.
//   • the project Overview's "Terminals" grid (ProjectTerminals) — reachable by just opening the page the
//     owner already works on. NO alert required, so in practice the MORE exposed of the two.
// Both rendered <TerminalTile> with no `readOnly` ⇒ a full Composer + xterm stdin for a Companion.
//
// WHY THIS SPEC DRIVES THE BROWSER RATHER THAN TRUSTING THE 403: the server refuses a companion write on
// BOTH inbound surfaces, but it refuses them DIFFERENTLY. POST /api/sessions/:id/input returns 403 + a
// readable {error}. The /ws/term {type:"stdin"} frame is SILENTLY DROPPED — the guard is
// `if (msg.type === "stdin" && role !== "assistant") writeStdin(...)` with no else, so no error frame is
// ever sent back. The terminal uses the WEBSOCKET path, so the owner got keystrokes echoing locally into
// xterm and nothing whatsoever happening, forever. A test that only exercised the REST 403 would pass
// while the real defect survived untouched — hence the xterm-side assertion below.
//
// SEEDING (the no-real-claude invariant): `seedLiveSession` inserts `processState:"live"` DB rows via the
// test-only POST /internal/test/seed — never startSession, so the fixture's `[pty] spawn` guard is never
// tripped. `role: "assistant"` is already part of SeededLiveRole, so no daemon change is needed. Both
// sessions are seeded into ONE project so the Overview grid renders them side by side.
import { expect, test } from "./fixtures/daemon";
import type { Page } from "@playwright/test";

const shortId = (id: string) => id.slice(0, 8);

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

// The turn-Composer's send button — present iff TerminalCard rendered a <Composer>. This is the REST
// surface (api.sendInput → POST /api/sessions/:id/input), the one that DOES answer with a readable 403.
const composer = (page: Page) => page.getByRole("button", { name: "Send turn" });

const xtermScreen = (page: Page) => page.locator(".xterm-screen");

// THE WITNESS FOR THE SILENT PATH. We record every `{type:"stdin"}` frame the page puts on ANY WebSocket,
// by wrapping WebSocket.prototype.send before page scripts run. This observes the REAL /ws/term transport
// rather than a proxy for it — the whole point of DoD-6 — and it only records, never substitutes the
// socket, so the terminal still attaches for real.
//
// ⚠️ An empty recording is only meaningful if the recorder can record. Reading zero frames is exactly what
// a BROKEN recorder returns too, so every use below is preceded by a POSITIVE CONTROL on a known-writable
// session in the same test: prove a real terminal DOES emit a stdin frame, THEN assert the companion emits
// none. A zero measured that way is a measured zero.
async function recordStdinFrames(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __loomStdin: string[] }).__loomStdin = [];
    const origSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data: Parameters<WebSocket["send"]>[0]) {
      try {
        if (typeof data === "string") {
          const msg = JSON.parse(data) as { type?: string; data?: string };
          if (msg?.type === "stdin") (window as unknown as { __loomStdin: string[] }).__loomStdin.push(msg.data ?? "");
        }
      } catch { /* binary pty bytes / non-JSON — never a stdin frame */ }
      return origSend.call(this, data);
    };
  });
}

const stdinFrames = (page: Page) => page.evaluate(() => (window as unknown as { __loomStdin: string[] }).__loomStdin ?? []);

// Focus the real terminal and type — the exact gesture an owner makes after clicking a stuck-busy alert.
async function typeIntoTerminal(page: Page, text: string) {
  await xtermScreen(page).first().click({ force: true });
  await page.keyboard.type(text);
}

test.describe("companion terminals are watch-only; every other session's is not", () => {
  test("/session/:id — a Companion gets NO composer and NO stdin; a normal session is unchanged", async ({ page, loomDaemon }) => {
    const worker = await loomDaemon.seedLiveSession({ role: "worker", agentName: "Writable Worker" });
    const companion = await loomDaemon.seedLiveSession({
      role: "assistant", project: worker.project, agentId: worker.agentId, agentName: worker.agentName,
    });
    await recordStdinFrames(page);

    // ── POSITIVE CONTROL FIRST: a NORMAL session must still be fully writable. ────────────────────────
    // This is DoD-5's direction (an over-broad fix would make EVERY terminal read-only and nobody would
    // notice until they needed it) AND the control that makes the companion's zero below meaningful — it
    // proves the stdin recorder actually records.
    await page.goto(`${loomDaemon.baseURL}/session/${worker.sessionId}`);
    // Fixture identity: a sibling worker's dev server renders this app identically, so pin WHICH session
    // this is before drawing any conclusion from what is or isn't on the page.
    await expect(page.getByText(new RegExp(shortId(worker.sessionId))).first()).toBeVisible();
    await expect(composer(page)).toBeVisible();
    await typeIntoTerminal(page, "ls");
    await expect.poll(() => stdinFrames(page).then((f) => f.join(""))).toContain("ls");

    // ── THE COMPANION — the carded defect, measured with a recorder just proven to work. ──────────────
    await page.goto(`${loomDaemon.baseURL}/session/${companion.sessionId}`);
    await expect(page.getByText(new RegExp(shortId(companion.sessionId))).first()).toBeVisible();

    // The terminal itself still MOUNTS — watch-only, NOT excluded. Keeping it is the point: the owner can
    // still read the wedged companion's scrollback, and still gets Stop, which is the actual recovery
    // action for the stuck-busy alert that sent them here.
    await expect(xtermScreen(page)).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

    // (a) the REST surface — the Composer is withheld, exactly as the Companion page has always done.
    await expect(composer(page)).toHaveCount(0);

    // (b) THE SILENT SURFACE — typing must put NO {type:"stdin"} frame on the wire. Before this fix the
    // frame was sent and the daemon dropped it without any error frame, so the owner saw keystrokes echo
    // locally and nothing happen, forever.
    const before = (await stdinFrames(page)).length;
    await typeIntoTerminal(page, "whoami");
    await page.waitForTimeout(300); // give a frame that WOULD be sent time to actually be sent
    expect((await stdinFrames(page)).slice(before)).toEqual([]);
    await expect(composer(page)).toHaveCount(0);
  });

  test("Overview's Terminals grid — the same guard, on the route that needs no alert at all", async ({ page, loomDaemon }) => {
    const worker = await loomDaemon.seedLiveSession({ role: "worker", agentName: "Grid Worker" });
    await loomDaemon.seedLiveSession({
      role: "assistant", project: worker.project, agentId: worker.agentId, agentName: worker.agentName,
    });

    await pinActiveProject(page, worker.projectId);
    await page.goto(`${loomDaemon.baseURL}/overview`);

    // Fixture identity: this project's own grid, with the writable worker present.
    await expect(page.getByText(new RegExp(shortId(worker.sessionId))).first()).toBeVisible();

    // The grid renders BOTH live sessions — Overview never filtered companions out, which is exactly why
    // this route was exposed with no alert required. So exactly ONE of the two tiles may carry a composer:
    // the worker's. Before the fix this was 2.
    await expect(xtermScreen(page)).toHaveCount(2);
    await expect(composer(page)).toHaveCount(1);
  });
});
