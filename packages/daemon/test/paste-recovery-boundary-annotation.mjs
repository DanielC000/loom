// Regression test for card 1c47454b — the ANNOTATION RENDERING half of "a redelivery frame asserts 'you
// have not seen this' — false for ANY consumed message, EITHER direction". HERMETIC — real PtyHost
// (fake pty via the createPty seam), no daemon, no real claude.
//
// paste-recovery-boundary-carry.mjs proves the PLUMBING: `carryPendingToSuccessor` (recycleWorker /
// recycleManager) and the daemon-restart replay both thread a carried paste-recovery notice's
// `mintedAtWallClock` through onto the successor, while DELIBERATELY OMITTING `mintedAtGen` — producing
// the exact parameter shape {mintedAtGen: undefined, mintedAtWallClock: <predecessor's stamp>} on the far
// side of a boundary. THIS FILE proves what `annotatePasteRecoveryAge` actually RENDERS given that shape,
// against a REAL successor session whose own `submitGeneration` is genuinely LOW (0 or 1 — the manager's
// own "the real 0-vs-47 case" framing) while the predecessor's `mintedAtGen` was HIGH (47).
//
// THE TRAP THIS GUARDS AGAINST (manager's own warning while reviewing the plan): `submitGeneration` is a
// PER-SESSION counter that restarts at 0 for a fresh successor. Threading `mintedAtGen` VERBATIM across
// the boundary is UNIT-INCOMPATIBLE — `annotatePasteRecoveryAge`'s own `currentGen <= mintedAtGen` guard
// would then read "0 <= 47" as "delivered before anything else ran, nothing to disclose" and silently
// produce NO annotation. That is the EXACT SAME silent nothing the original bug produces, just moved one
// call deeper — a naive "just thread mintedAtGen through" fix would pass a plumbing test but still be
// dead code at the point that matters. This file drives that naive shape DIRECTLY (scenario A) and shows
// it is inert, then drives the ACTUAL fix's shape (scenario B) and shows it discloses correctly.
//
// (A) NAIVE-FIX TRAP, reproduced directly: a carried entry arrives with BOTH `mintedAtGen: 47` (as if
//     verbatim-threaded — the mistake the manager warned against) AND `mintedAtWallClock` set, drained by
//     a session whose own `submitGeneration` is genuinely 1 (< 47) at drain time. Asserts the annotation
//     is ABSENT — proving that shape is silently broken, exactly like the original bug.
// (B) THE ACTUAL FIX: the SAME scenario, but with `mintedAtGen` OMITTED (exactly what
//     `carryPendingToSuccessor`/the restart replay now do) and `mintedAtWallClock` still set. Asserts the
//     annotation IS PRESENT, states an absolute wall-clock time (not a generation count), and tells the
//     reader to compare it against their own handoff/transcript.
// (C) IN-SESSION CONTROL (branch-selection sanity, not the boundary case): when `mintedAtGen` genuinely
//     reflects an IN-SESSION mint (currentGen > mintedAtGen) and `mintedAtWallClock` is ALSO set, the
//     existing generation-count wording still wins — the wall-clock branch never masks the in-session one.
//
// Run (no daemon needed): node test/paste-recovery-boundary-annotation.mjs
//   Requires the daemon built first (reads ../dist/*): from packages/daemon run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpHome = path.join(os.tmpdir(), `loom-prba-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { buildPasteRecoveryText, PASTE_RECOVERY_TAG } = await import("../dist/orchestration/paste-tripwire.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const fakes = [];
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    const fake = { ...base, pid: 4321, write: (d) => { writes.push(d); }, writes };
    fakes.push(fake);
    return fake;
  }
}
const host = new TestPtyHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
const SID = "sess-prba";
host.spawn({
  sessionId: SID, cwd: tmpHome,
  permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
  geometry: { cols: 120, rows: 40 }, sessionEnv: {},
});
const fake = fakes[0];

try {
  host.deliverHook(SID, { hook_event_name: "SessionStart" });
  check("spawn used the injected fake pty (no real claude)", !!fake && host.isAlive(SID) === true);

  const PREDECESSOR_MINTED_GEN = 47; // the "real 0-vs-47 case" the manager named while reviewing the plan
  const MINTED_WALLCLOCK = Date.now() - 7 * 60_000; // minted 7 minutes ago, on the (now-gone) predecessor

  // ===================== (A) NAIVE-FIX TRAP: mintedAtGen verbatim-threaded across the boundary ============
  {
    // Occupy the session with an ordinary turn (busy=true, submitGeneration -> 1) so the recovery entry
    // below QUEUES instead of delivering immediately — mirrors a carried entry landing on an already-busy
    // successor. This is turn 1 for this fresh session, so its own submitGeneration is genuinely LOW (1)
    // by the time the recovery entry drains — the manager's "0-vs-47" framing, concretely.
    const setup = host.enqueueStdin(SID, "[loom:test] setup turn (A)");
    if (!setup.delivered) throw new Error("test setup: (A) setup turn did not submit immediately");

    const naiveText = buildPasteRecoveryText("content lost before the boundary (A)");
    const held = host.enqueueStdin(
      SID, naiveText, "system", undefined, undefined, "agent",
      undefined, undefined, undefined, undefined, undefined, undefined, randomUUID(),
      PREDECESSOR_MINTED_GEN, MINTED_WALLCLOCK, // BOTH fields — simulates a naive verbatim-thread of mintedAtGen
    );
    check("(A) setup: the naive-shape entry queues behind the in-flight setup turn", held.delivered === false && held.queued === true);

    const writesBeforeSetupStop = fake.writes.length;
    host.deliverHook(SID, { hook_event_name: "Stop" }); // settles setup turn; drains the naive-shape entry next
    await sleep(10);
    const drained = fake.writes.slice(writesBeforeSetupStop).join("");
    check("(A) setup: the naive-shape entry is what actually drained", drained.includes(naiveText.slice(PASTE_RECOVERY_TAG.length + 1, PASTE_RECOVERY_TAG.length + 30)));
    check("(A) THE TRAP: with mintedAtGen=47 carried verbatim against a successor at submitGeneration=1 (1 <= 47), the annotation is ABSENT — silently inert, the SAME bug one call deeper",
      drained.includes(PASTE_RECOVERY_TAG) && !/generation(s)? ago/.test(drained) && !/minted at/i.test(drained));

    // Resolve cleanly before the next scenario.
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });
    host.deliverHook(SID, { hook_event_name: "Stop" });
  }

  // ===================== (B) THE ACTUAL FIX: mintedAtGen OMITTED, mintedAtWallClock carried ===============
  {
    const setup = host.enqueueStdin(SID, "[loom:test] setup turn (B)");
    if (!setup.delivered) throw new Error("test setup: (B) setup turn did not submit immediately");

    const fixedText = buildPasteRecoveryText("content lost before the boundary (B)");
    const held = host.enqueueStdin(
      SID, fixedText, "system", undefined, undefined, "agent",
      undefined, undefined, undefined, undefined, undefined, undefined, randomUUID(),
      undefined, MINTED_WALLCLOCK, // mintedAtGen OMITTED — exactly what carryPendingToSuccessor/replayPending now do
    );
    check("(B) setup: the fixed-shape entry queues behind the in-flight setup turn", held.delivered === false && held.queued === true);

    const writesBeforeSetupStop = fake.writes.length;
    host.deliverHook(SID, { hook_event_name: "Stop" });
    await sleep(10);
    const drained = fake.writes.slice(writesBeforeSetupStop).join("");
    check("(B) THE FIX: the delivered recovery still carries the recovery tag", drained.includes(PASTE_RECOVERY_TAG));
    check("(B) THE FIX: the delivered recovery still carries the ORIGINAL lost content", drained.includes("content lost before the boundary (B)"));
    check("(B) THE FIX: with mintedAtGen absent, the annotation IS PRESENT — an absolute wall-clock disclosure, not silence",
      new RegExp(`minted at ${new Date(MINTED_WALLCLOCK).toISOString().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(drained));
    check("(B) THE FIX: the disclosure names the boundary explicitly (before this session began)", /before this session began/i.test(drained));
    check("(B) THE FIX: the disclosure does NOT use the in-session generation-count wording (that would be a unit error against a fresh successor)",
      !/generation(s)? ago/.test(drained));
    check("(B) THE FIX: the disclosure tells the reader to check their own handoff/transcript",
      /handoff|transcript/i.test(drained));

    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });
    host.deliverHook(SID, { hook_event_name: "Stop" });
  }

  // ===================== (C) IN-SESSION CONTROL: generation wording still wins when genuinely in-session ===
  {
    const setup = host.enqueueStdin(SID, "[loom:test] setup turn (C)");
    if (!setup.delivered) throw new Error("test setup: (C) setup turn did not submit immediately");

    // mintedAtGen=0 is genuinely IN-SESSION here (this session's own submitGeneration is already several
    // turns in by (C), so currentGen > 0 at drain time) — mintedAtWallClock is ALSO set, to prove the
    // generation branch is preferred over the wall-clock one whenever mintedAtGen is present and stale.
    const inSessionText = buildPasteRecoveryText("content lost within this same session (C)");
    const held = host.enqueueStdin(
      SID, inSessionText, "system", undefined, undefined, "agent",
      undefined, undefined, undefined, undefined, undefined, undefined, randomUUID(),
      0, MINTED_WALLCLOCK,
    );
    check("(C) setup: the in-session-shape entry queues behind the in-flight setup turn", held.delivered === false && held.queued === true);

    const writesBeforeSetupStop = fake.writes.length;
    host.deliverHook(SID, { hook_event_name: "Stop" });
    await sleep(10);
    const drained = fake.writes.slice(writesBeforeSetupStop).join("");
    check("(C) setup: the in-session-shape entry is what actually drained (positive signal the wait was sufficient before the negative conjunct below inspects it)",
      drained.includes(PASTE_RECOVERY_TAG) && drained.includes("content lost within this same session (C)"));
    check("(C) CONTROL: an in-session mint (mintedAtGen present + stale) uses generation wording, not wall-clock wording, even though mintedAtWallClock is also set",
      /generation(s)? ago/.test(drained) && !/minted at \d{4}-/.test(drained));

    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });
    host.deliverHook(SID, { hook_event_name: "Stop" });
  }
} finally {
  try { host.stop(SID, "hard"); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a carried paste-recovery notice's age evidence renders correctly at the exact boundary shape the fix produces: threading mintedAtGen verbatim across a boundary (the naive-fix trap) is silently inert against a successor's genuinely-low submitGeneration, exactly like the original bug; the actual fix (mintedAtGen omitted, mintedAtWallClock carried) discloses an absolute mint time instead; and a genuinely in-session mint still uses the existing generation-count wording, never masked by the wall-clock branch."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
