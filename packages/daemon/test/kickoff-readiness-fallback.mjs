import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 0050a17e DoD #5 (Code Review MAJOR finding) — the READINESS-FALLBACK path (READY_FALLBACK_MS →
// markReady, when the real `SessionStart` hook is missed entirely) had ZERO delivery coverage: every
// scenario in worker-kickoff-guarantee.mjs pins `LOOM_READY_FALLBACK_MS = 5000` specifically so it "never
// fires" within that suite's own windows, since that file is about the SessionStart-driven path. That
// left the OTHER path into markReady — a missed SessionStart hook, recovered only by the fallback timer —
// completely unproven for kickoff delivery: markReady itself doesn't care WHICH caller reached it, but
// nothing had ever actually exercised the fallback caller reaching scheduleKickoffGuarantee.
//
// This file proves: a fresh spawn whose SessionStart hook is NEVER delivered (fully missed, not just
// delayed) still gets its kickoff delivered — via READY_FALLBACK_MS firing → markReady → (after
// logLandedMode's gate settles) → scheduleKickoffGuarantee — exactly once, with the same give-up/requeue
// protection (task 15/this same card) as the SessionStart-driven path.
//
// HERMETIC, claude-free — a fake pty (mirrors worker-kickoff-guarantee.mjs).
//
// RUN: pnpm build (from packages/daemon) then `node test/kickoff-readiness-fallback.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil } from "./_wait.mjs";
import { observeOnce, assertNeverWithControl } from "./_timing-guard.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-readiness-fallback-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
// The two timers this scenario actually needs FAST and DETERMINISTIC — both small, both real for this file
// (unlike worker-kickoff-guarantee.mjs, which deliberately pins READY_FALLBACK_MS long so it never fires).
process.env.LOOM_READY_FALLBACK_MS = "30";
process.env.LOOM_MODE_LOG_POLL_MS = "5";
// Pinned (not left at the 900ms default) so the two negative-window constants below (200ms) have an
// EXPLICIT, measured margin under it — sendEnterAndVerify's give-up/reassert-paste retry (host.ts) also
// writes a bracket-paste marker, so a window that ever reached this timeout could misread an unrelated
// retry as a repeated kickoff delivery. See NO_REPEAT_WINDOW_MS's own comment below.
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = "5000";

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const PASTE_START = "\x1b[200~";

const fakes = [];
// Extends the shared seam (tracked onExit callback, a real kill()) rather than a local fake — see
// _seam-host-fixture.mjs's own doc for why a locally-discarded onExit is a real defect class (card
// c54d1ea0), not just a style nit. Adds write-capture on top, same pattern pty-restart-nudge-atomicity.mjs
// already uses.
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    const fake = { ...base, write: (d) => writes.push(d), writes };
    fakes.push(fake);
    return fake;
  }
}
const busyById = {};
const events = {
  onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onExit() {},
  onBusy(id, b) { (busyById[id] ??= []).push(b); },
};
const host = new TestPtyHost(events);
const writtenOf = (fake) => fake.writes.join("");
const countIn = (fake, marker) => writtenOf(fake).split(marker).length - 1;

// windowMs shared by every negative check below — derived from the pinned LOOM_SUBMIT_VERIFY_TIMEOUT_MS
// (5000ms) above: comfortably (25x) under it, so sendEnterAndVerify's give-up/reassert-paste retry can
// never fire inside the window and be mistaken for a repeated/unexpected kickoff delivery. Also comfortably
// over READY_FALLBACK_MS(30) + logLandedMode's gate(≤40ms), the other timers actually in play here.
const NEGATIVE_WINDOW_MS = 200;

// Spawn a throwaway control session on the SAME fallback path (no SessionStart ever delivered — only
// READY_FALLBACK_MS marks it ready) and wait for its own real kickoff delivery — used by every
// positiveControl below to prove countIn(...)'s PASTE_START check can actually catch a real delivery,
// via the identical write path scheduleKickoffGuarantee itself uses (not a hand-written fake write).
let controlSeq = 0;
async function spawnControlDelivery(label) {
  const id = `control-${controlSeq++}-${label.replace(/[^a-z0-9]+/gi, "-")}`;
  host.spawn({
    sessionId: id, cwd: tmpHome, startupPrompt: `control kickoff (${label})`,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  const fake = fakes[fakes.length - 1];
  await waitUntil(() => countIn(fake, PASTE_START) === 1, { label: `${label}: control kickoff delivered once via the fallback`, timeoutMs: 5000 });
  return { id, fake };
}

try {
  // ============ (1) SessionStart is NEVER delivered — READY_FALLBACK_MS is the ONLY path to ready =========
  {
    const A = "fallback-A";
    const KICKOFF = "orchestrate task via the readiness fallback — no SessionStart ever fires";
    host.spawn({
      sessionId: A, cwd: tmpHome, startupPrompt: KICKOFF,
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    const fa = fakes[fakes.length - 1];
    // Deliberately NEVER call host.deliverHook(A, {hook_event_name:"SessionStart"}) — the fallback timer
    // (READY_FALLBACK_MS, 30ms) is the ONLY thing that can ever mark this session ready.
    check("(1) not ready yet, nothing delivered, immediately after spawn", countIn(fa, PASTE_START) === 0);
    await waitUntil(() => countIn(fa, PASTE_START) === 1, { label: "(1) kickoff delivered via the readiness fallback (no SessionStart ever fired)", timeoutMs: 5000 });
    check("(1) the kickoff was delivered exactly once via the fallback path", countIn(fa, PASTE_START) === 1);
    check("(1) the delivered text is the ORIGINAL kickoff", writtenOf(fa).includes(KICKOFF));
    check("(1) busy was (re)armed true by the delivery", busyById[A]?.[busyById[A].length - 1] === true);
    const noRepeat1 = await assertNeverWithControl({
      label: "(1) still exactly ONE delivery (no repeat firing)",
      check: () => countIn(fa, PASTE_START) >= 2,
      windowMs: NEGATIVE_WINDOW_MS,
      positiveControl: async () => {
        // Arm a REAL second delivery on a throwaway control session — its own real fallback delivery,
        // then a legitimate end-of-turn (UserPromptSubmit+Stop, same shape worker-kickoff-guarantee.mjs
        // uses to finish a turn) + enqueueStdin to force a genuine second submit() — proving the >=2
        // check can actually catch a repeat via the SAME real write path scheduleKickoffGuarantee uses.
        const { id, fake } = await spawnControlDelivery("(1) repeat-check positive control");
        host.deliverHook(id, { hook_event_name: "UserPromptSubmit" });
        host.deliverHook(id, { hook_event_name: "Stop" }); // end that turn — clears busy
        host.enqueueStdin(id, "control forced second delivery", "system", undefined, undefined, "agent");
        const went = await observeOnce({ check: () => countIn(fake, PASTE_START) >= 2, windowMs: NEGATIVE_WINDOW_MS });
        try { host.stop(id, "hard"); } catch { /* ignore */ }
        return went;
      },
    });
    check("(1) still exactly ONE delivery (no repeat firing)", noRepeat1);
    try { host.stop(A, "hard"); } catch { /* ignore */ }
  }

  // ============ (2) resume/fork are STILL no-ops via the fallback path (no startupPrompt → nothing to =====
  // ============ deliver, exactly like the SessionStart-driven path — the fallback calls the SAME =========
  // ============ markReady, so this guards against a future divergence between the two callers) ===========
  {
    const B = "fallback-B";
    host.spawn({
      sessionId: B, cwd: tmpHome, resumeId: "engine-B", // resume: no startupPrompt passed
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    const fb = fakes[fakes.length - 1];
    const neverDelivered2 = await assertNeverWithControl({
      label: "(2) resume path via the fallback: NEVER delivers (no kickoff was ever passed)",
      check: () => countIn(fb, PASTE_START) >= 1,
      windowMs: NEGATIVE_WINDOW_MS,
      positiveControl: async () => {
        // Prove the >=1 check can catch a real delivery — a control session spawned WITH a startupPrompt
        // (unlike B) really does get one, via the identical fallback path and identical check+window shape.
        const { id, fake } = await spawnControlDelivery("(2) no-delivery positive control");
        const went = await observeOnce({ check: () => countIn(fake, PASTE_START) >= 1, windowMs: NEGATIVE_WINDOW_MS });
        try { host.stop(id, "hard"); } catch { /* ignore */ }
        return went;
      },
    });
    check("(2) resume path via the fallback: NEVER delivers (no kickoff was ever passed)", neverDelivered2);
    try { host.stop(B, "hard"); } catch { /* ignore */ }
  }
} finally {
  for (const id of ["fallback-A", "fallback-B"]) { try { host.stop(id, "hard"); } catch { /* ignore */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a fresh spawn whose SessionStart hook is NEVER delivered still gets its kickoff delivered exactly once, via READY_FALLBACK_MS's own markReady call chaining into the same logLandedMode-gated scheduleKickoffGuarantee delivery the SessionStart-driven path uses; resume (no startupPrompt) stays a byte-identical no-op through this path too."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
