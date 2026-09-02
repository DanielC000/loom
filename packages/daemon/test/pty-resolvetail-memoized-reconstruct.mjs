// Regression test for card ea77f71d (Code Reviewer Major ②, follow-up on 8e0d09e8) — before this card,
// `QueuedMessage.resolveTailAtDelivery` was re-invoked LIVE every time `annotatedMessageText` touched an
// entry, including `requeueGiveUpOrigin`'s reconstruction of a failed attempt's signature. A resolver that
// reads live external state (the production case: `SessionService.platformEscalate`'s escalated-card
// column) could therefore return a DIFFERENT value at reconstruction time than it did at the real write —
// silently breaking the byte-identity invariant `requeueGiveUpOrigin`'s own doc (host.ts, "SHARED,
// deliberately, between `drainPending`... and `requeueGiveUpOrigin`") already declares load-bearing for the
// late-confirmation content-match/purge mechanism.
//
// THE FIX: `withDeliveryTail` now memoizes the resolved tail onto the entry itself
// (`resolvedTailReady`/`resolvedTail`) the FIRST time it's touched, so `requeueGiveUpOrigin`'s later call —
// on the SAME object reference `drainPending` drained (see `submit`'s `live.giveUpOrigin = origin`) — reads
// the cached value instead of re-invoking the resolver against (by then) different external state.
//
// THE DISCRIMINATING RED (DoD-3): mutate the external state the resolver reads (a real task's board
// column, via a real `Db`) INSIDE the reconstruct window — after the original write, before the give-up
// fires — then confirm the reconstructed signature still matches what was ACTUALLY written, never a
// signature drifted toward the mutated value. Two checks flip together:
//   (1) RED-FIRST: a candidate text shaped exactly like what BROKEN (pre-fix) code would reconstruct — the
//       base text plus the MUTATED (post-write) column value — must NOT content-match. Pre-fix, this WOULD
//       match (the broken reconstruction re-reads live state, landing on the mutated column) — so this
//       assertion is itself RED under the pre-fix code, not just a sanity check.
//   (2) THE CHECK: the text ACTUALLY written (base text plus the ORIGINAL, pre-mutation column) must
//       content-match and purge the give-up requeue. Pre-fix this is RED (the reconstructed signature was
//       seeded from the mutated column, so the real written text never matches it, and the message stays
//       stuck in `pending` forever). Post-fix this is GREEN (the memoized tail is byte-identical to what
//       was written).
//
// MUTATION-VERIFIED: this file was run once with `host.ts`'s `withDeliveryTail` reverted to its pre-card
// (always re-invoke, no memoization) shape — both (1) and (2) went RED as predicted (the wrong candidate
// content-matched; the real written text did not, so the message never left `pending`) — then reverted back
// and re-run GREEN. See the worker's `worker_report` for the raw command + output of both runs.
//
// RUN (no daemon needed): node test/pty-resolvetail-memoized-reconstruct.mjs
//   Requires the daemon built first (reads ../dist/pty/host.js and ../dist/db.js): from packages/daemon,
//   run `pnpm build`.
import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const submitLog = [];
const realConsoleLog = console.log.bind(console);
const realConsoleError = console.error.bind(console);
console.log = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleLog(...args); };
console.error = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleError(...args); };

const tmpHome = path.join(os.tmpdir(), `loom-resolvetail-reconstruct-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
// Module-level constants in host.ts, read once at import — small values so the give-up fires fast.
const ENTER_DELAY = 20;
const VERIFY_TIMEOUT = 150;
const MAX_ATTEMPTS = 2;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "1";
process.env.LOOM_GIVE_UP_HOLD_MS = "5000";

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const fakes = [];
const busyLog = {};
const events = { onEngineSessionId() {}, onBusy(id, busy) { (busyLog[id] ??= []).push(busy); }, onContextStats() {}, onRateLimited() {}, onExit() {} };
class SilentTestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    const fake = { ...base, write: (d) => { writes.push(d); }, writes };
    fakes.push(fake);
    return fake;
  }
}

const now = new Date().toISOString();
const db = new Db();
const TASK_ID = "task-reconstruct-1";
try {
  db.insertProject({ id: "pOrd", name: "Ordinary", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
  db.insertTask({ id: TASK_ID, projectId: "pOrd", title: "task read by the resolver", body: "", columnKey: "in_progress", position: 0, priority: "p2", createdAt: now, updatedAt: now });

  const host = new SilentTestPtyHost(events);
  const SID = "sess-resolvetail-reconstruct";
  const BASE_TEXT = "ESCALATION_BASE_TEXT";
  // Mirrors SessionService.platformEscalate's own resolver shape (reads a task's live column), but scoped
  // to exactly the state this test controls.
  const resolveTailAtDelivery = () => ` · column: ${db.getTask(TASK_ID)?.columnKey ?? "unknown"}`;

  host.spawn({ sessionId: SID, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  host.deliverHook(SID, { hook_event_name: "SessionStart" });
  const fake = fakes.at(-1);

  // ===== The real, ACTUAL write — column is "in_progress" at this instant =====
  const r1 = host.enqueueStdin(SID, BASE_TEXT, "system", undefined, undefined, "agent", undefined, undefined, undefined, undefined, { resolveTailAtDelivery });
  check("(setup) delivered immediately, busy armed", r1.delivered === true && busyLog[SID]?.at(-1) === true);
  // The LOGICAL text actually assembled and written — `fake.writes` also carries raw bracketed-paste/Enter
  // pty escape sequences around it, so this is verified with `.includes()` (mirrors the sibling
  // `pty-giveup-mintedatgen-signature.mjs` test's own technique), not a strict `===` against the raw buffer.
  const originalWritten = `${BASE_TEXT} · column: in_progress`;
  check("(setup) the ACTUAL write carries the tail read at write time (\"in_progress\")", fake.writes.join("").includes(originalWritten));

  // ===== INSIDE THE RECONSTRUCT WINDOW: the task's column moves AFTER the write, BEFORE the give-up fires =====
  db.updateTask(TASK_ID, { columnKey: "done" });
  check("(setup) the task's column has genuinely moved", db.getTask(TASK_ID).columnKey === "done");

  // ===== Let this generation genuinely give up — the silent pty never emits output =====
  await sharedWaitUntil(() => busyLog[SID]?.at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
  check("(setup) the message's generation genuinely gave up (GIVE-UP RECOVERY fired)", submitLog.some((l) => l.includes(`[submit] ${SID} `) && l.includes("GIVE-UP RECOVERY after")));
  check("(setup) the message is requeued, sitting ambiguous", host.getPendingEntries(SID).some((m) => m.text === BASE_TEXT));

  // ===== Intervening fresh, unrelated, non-ambiguous generation — disables the content-BLIND FIFO-position =====
  // ===== fallback, so ONLY a genuine content match can resolve it from here on (mirrors the sibling test =====
  // ===== `pty-giveup-mintedatgen-signature.mjs`'s own technique for the exact same reason) ======================
  const r2 = host.enqueueStdin(SID, "HEALTHY_UNRELATED_GEN", "system", undefined, undefined, "agent");
  check("(setup) unrelated generation delivered, busy armed", r2.delivered === true && busyLog[SID]?.at(-1) === true);
  host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: "HEALTHY_UNRELATED_GEN" });
  check("(setup) unrelated generation confirmed — the escalation message still sits unresolved", host.getPendingEntries(SID).some((m) => m.text === BASE_TEXT));

  // ===== (1) RED-FIRST: the candidate BROKEN (pre-fix) code would have reconstructed — base text plus the =====
  // ===== column value AFTER the mutation — must NOT content-match. Pre-fix, this WOULD match. ==================
  submitLog.length = 0;
  const wrongCandidate = `${BASE_TEXT} · column: done`;
  host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: wrongCandidate });
  check("(1) RED-FIRST: the mutation-shaped (post-drift) candidate does NOT content-match", !submitLog.some((l) => l.includes("CONFIRMED logicalId=") && l.includes("content-matched")));
  check("(1) RED-FIRST: the message is still unresolved", host.getPendingEntries(SID).some((m) => m.text === BASE_TEXT));

  // ===== (2) THE CHECK — this is the assertion that flips RED under the pre-fix (always-re-invoke) code: =====
  // ===== the text ACTUALLY WRITTEN (column "in_progress", frozen at write time) resolves the give-up =========
  submitLog.length = 0;
  host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: originalWritten });
  check("(2) THE CHECK: the ACTUAL written text content-matches and resolves the give-up", submitLog.some((l) => l.includes("CONFIRMED logicalId=") && l.includes("content-matched")));
  check("(2) THE CHECK: the message is purged from pending", !host.getPendingEntries(SID).some((m) => m.text === BASE_TEXT));

  try { host.stop(SID, "hard"); } catch { /* ignore */ }
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — `withDeliveryTail`'s memoization makes `requeueGiveUpOrigin`'s reconstruction byte-identical to the real write, even when the resolver's own live external state (a task's board column) moves inside the reconstruct window — proven by mutating that column between the write and the give-up, then confirming only the ORIGINALLY-written text (never the post-drift value) resolves the late-confirmation content match."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
