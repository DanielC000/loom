// Card f7e580cf: claude's `attributeOwnerText` records `recentOwnerTurns` with `unshift` (most-recent-
// first — `[0]` is the newest), but codex's own `enqueueStdinCodex`/`drainCodexPending` used `push`+
// `shift` (oldest-first growth — `[0]` was the OLDEST of the retained window). Fixed by `pushRecentOwnerTurn`
// (pty/host.ts), the ONE shared ring-push helper both harnesses now call, so they can't drift apart again.
// This test proves `[0]` is the newest on BOTH harnesses, via each harness's own real dispatch path —
// never by asserting against the shared helper in isolation, which would prove nothing about whether
// either harness actually calls it.
//
// RUN (no daemon needed): node test/pty-codex-owner-turns-order.mjs  (build first: from packages/daemon `pnpm build`).
import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-codex-owner-order-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

// TestPtyHost: reuses the shared claude-side fake-pty seam (_seam-host-fixture.mjs) for the claude
// comparison below, AND stubs codex's own `submitCodex` (a TS `private` method — compiles to an ordinary
// overridable prototype method, same established technique pty-codex-agnostic-methods.mjs's header
// documents for reading/writing `liveCodex` directly) so this test isolates the ring-push ordering
// `enqueueStdinCodex`/`drainCodexPending` perform BEFORE they ever call submitCodex, from the real
// write/Enter/busy-timer machinery submitCodex owns — none of which this test needs or wants to exercise.
class TestPtyHost extends createSeamHost(PtyHost) {
  submitCodex(_sessionId, _live, _text) { /* no-op: isolate ring-push ordering from real submit mechanics */ }
}
const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new TestPtyHost(events);

const SIDS = [];
const CODEX_SID = "codex-owner-order";

/** Minimal CodexLive fixture — only the fields `enqueueStdinCodex`/`drainCodexPending` actually read,
 *  matching this suite's own established "minimal subset" convention (pty-codex-agnostic-methods.mjs). */
function makeCodexLive() {
  return {
    kind: "codex",
    alive: true,
    bootReady: true,
    busy: false,
    stopping: false,
    drainHeld: false,
    activeTurnRoute: null, lastPromptRoute: null,
    activeTurnProactive: false, lastPromptProactive: false,
    activeTurnOwnerText: null, lastPromptOwnerText: null,
    recentOwnerTurns: [],
    activeTurnSenderId: null, lastPromptSenderId: null,
    pending: [],
  };
}

try {
  // ===== CODEX side =====
  const live = makeCodexLive();
  host.liveCodex.set(CODEX_SID, live);

  // --- 1. Two consecutive IMMEDIATE-path turns (the enqueueStdinCodex `push` call site) ---
  const enq = (ownerText) => host.enqueueStdin(CODEX_SID, `text for: ${ownerText}`, "system", undefined, undefined, "agent", undefined, ownerText);
  check("codex: empty window before any owner turn", JSON.stringify(host.getRecentOwnerTurns(CODEX_SID)) === "[]");
  enq("codex turn one");
  check("codex: single turn — [0] is (trivially) the newest", host.getRecentOwnerTurns(CODEX_SID)[0] === "codex turn one");
  enq("codex turn two");
  check(
    "codex: a SECOND immediate-path turn is prepended — [0] is the NEWEST, not the oldest (RED on pre-fix push+shift, which would read 'codex turn one' here)",
    host.getRecentOwnerTurns(CODEX_SID)[0] === "codex turn two",
  );
  check(
    "codex: full order after 2 immediate turns is most-recent-first",
    JSON.stringify(host.getRecentOwnerTurns(CODEX_SID)) === JSON.stringify(["codex turn two", "codex turn one"]),
  );

  // --- 2. A QUEUED turn, delivered via drainCodexPending (the OTHER push call site) ---
  live.busy = true; // forces enqueueStdinCodex onto its queued branch instead of the immediate one
  const queuedResult = enq("codex turn three");
  check("codex: busy forces queueing rather than immediate delivery", queuedResult.queued === true);
  check("codex: queued turn not yet in the window", host.getRecentOwnerTurns(CODEX_SID)[0] === "codex turn two");
  host.drainCodexPending(CODEX_SID, live); // private method — directly callable on compiled JS, same technique as submitCodex above
  check(
    "codex: the DRAINED turn also lands newest-first — [0] is the newest after a drain, not just an immediate delivery",
    host.getRecentOwnerTurns(CODEX_SID)[0] === "codex turn three",
  );
  check(
    "codex: full order after the drain",
    JSON.stringify(host.getRecentOwnerTurns(CODEX_SID)) === JSON.stringify(["codex turn three", "codex turn two", "codex turn one"]),
  );

  // --- 3. Negative control: a non-owner (proactive/system) turn must NOT enter the window, on codex either ---
  live.busy = false;
  host.enqueueStdin(CODEX_SID, "[loom:heartbeat] proactive check-in", "system", undefined, undefined, "agent"); // no ownerText
  check(
    "codex: a non-owner turn does not get pushed into the recent-owner window",
    JSON.stringify(host.getRecentOwnerTurns(CODEX_SID)) === JSON.stringify(["codex turn three", "codex turn two", "codex turn one"]),
  );

  // --- 4. Bounded window on codex too — pushing well past the retained window still keeps [0] the newest
  //     and evicts the oldest, same shape as claude's own test (pty-owner-attestation.mjs scenario 8) ---
  const moreTurns = ["codex turn four", "codex turn five", "codex turn six", "codex turn seven"];
  for (const t of moreTurns) enq(t);
  const window = host.getRecentOwnerTurns(CODEX_SID);
  check("codex: the recent-owner window is BOUNDED (does not grow past its configured size)", window.length > 0 && window.length < 7);
  check("codex: the MOST RECENT turn is retained at [0]", window[0] === "codex turn seven");
  check("codex: an OLD-ENOUGH turn (the very first one) has fallen out of the window", !window.includes("codex turn one"));

  // ===== CLAUDE side (comparison — same assertion shape, the REAL claude dispatch path) =====
  {
    const sid = "claude-owner-order"; SIDS.push(sid);
    host.spawn({ sessionId: sid, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
    host.deliverHook(sid, { hook_event_name: "SessionStart" });
    const stop = () => host.deliverHook(sid, { hook_event_name: "Stop" });
    const claudeEnq = (ownerText) => host.enqueueStdin(sid, `text for: ${ownerText}`, "system", undefined, undefined, "agent", undefined, ownerText);

    claudeEnq("claude turn one"); stop();
    check("claude: single turn — [0] is (trivially) the newest", host.getRecentOwnerTurns(sid)[0] === "claude turn one");
    claudeEnq("claude turn two"); stop();
    check("claude: a second turn is prepended — [0] is the newest (unchanged behavior)", host.getRecentOwnerTurns(sid)[0] === "claude turn two");
    check(
      "claude: full order after 2 turns is most-recent-first — SAME shape as codex above, via the SAME shared helper",
      JSON.stringify(host.getRecentOwnerTurns(sid)) === JSON.stringify(["claude turn two", "claude turn one"]),
    );
  }
} finally {
  for (const sid of SIDS) { try { host.stop(sid, "hard"); } catch { /* ignore */ } }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card f7e580cf: `getRecentOwnerTurns(sid)[0]` is the NEWEST owner turn on BOTH harnesses, via each one's own real dispatch path (codex: enqueueStdinCodex's immediate push AND drainCodexPending's queued drain; claude: attributeOwnerText) — all three call sites now share the ONE `pushRecentOwnerTurn` ring helper (pty/host.ts) instead of codex's own prior push+shift (oldest-first) divergence. A non-owner (proactive/system) turn is confirmed to never enter the window on codex either, and the window stays bounded with the newest retained and the oldest evicted, matching claude's existing behavior (pty-owner-attestation.mjs scenario 8)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
