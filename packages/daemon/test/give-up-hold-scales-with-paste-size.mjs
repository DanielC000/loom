import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card fd4704bc — proves `GIVE_UP_HOLD_MS`'s extra wait actually scales with paste size, both as a pure
// formula (unit-level, instant) and as REAL wiring through the production give-up/re-mint ladder
// (`requeueGiveUpOrigin` in pty/host.ts, and `handleKickoffGiveUpExhausted`'s own re-mint hold in
// sessions/service.ts) against the REAL PtyHost + SessionService, mirroring kickoff-giveup-remint-
// purge.mjs's own rig rather than a SessionService-level stub.
//
// WHY THIS MATTERS: 844ca34e (deployed cdbfa311) stopped a give-up/re-mint cycle from re-pasting a
// stranded message's body a second time, but it did NOT change how long Loom waits before concluding a
// large kickoff's delivery is dead. `GIVE_UP_HOLD_MS` (20s in production) is sized for an ordinary short
// dispatch; a real ~68-70K-char kickoff's own engine confirmation can legitimately take far longer
// (measured 57s in production; pinned memory records 232s), so the fixed hold was parking kickoffs well
// before their own hook had a real chance to land. `giveUpHoldExtraMs` (pty/host.ts) closes that gap by
// scaling the hold's EXTRA wait with the paste's own size, reusing `pasteSettleExtraMs`'s existing
// `scaledExtraMs` shape rather than inventing a second formula.
//
// This suite proves, via a fake pty that NEVER emits output:
//   (1) UNIT: `giveUpHoldExtraMs` is EXACTLY zero at/under its own `GIVE_UP_HOLD_SCALE_ABOVE_CHARS`
//       floor (ordinary small writes get byte-identical hold timing), grows linearly with the excess
//       above it, and is capped at `GIVE_UP_HOLD_SCALE_MAX_EXTRA_MS` for a pathologically large body —
//       asserted directly against the env-overridden constants this file itself sets, never a
//       hardcoded expectation that could silently drift from the real tuning.
//   (2) INTEGRATION, generic message path, cycle-1 hold (`requeueGiveUpOrigin`, host.ts): a SMALL
//       `messageWorker` directive (at/under the scale floor) is redelivered at close to the BASE hold; a
//       LARGE one (comfortably past the floor, comfortably under the cap) is redelivered measurably
//       LATER. This is the real, wired-in behavior a reverted fix would collapse back to one single
//       (base-only) timing for both.
//   (2b) INTEGRATION, generic message path, RE-MINT hold (`handleGiveUpExhausted`, service.ts): the
//       OTHER service.ts call site — a manager/worker-report redirect's own exhaustion-and-re-mint —
//       isolated the same way (3) isolates the kickoff re-mint, so a per-site revert of JUST this line
//       is caught even when (2)'s own cycle-1 measurement (a different call site) stays green.
//   (3) INTEGRATION, kickoff path, RE-MINT hold (`handleKickoffGiveUpExhausted`'s own re-mint hold): same
//       shape, but for a worker's turn-1 startup-prompt kickoff — the exact delivery path card fd4704bc
//       is about, not just the generic message path (2)/(2b) already cover.
//
// RUN: pnpm --filter @loom/daemon build, then `node test/give-up-hold-scales-with-paste-size.mjs`.
// NEGATIVE CONTROL (card fd4704bc DoD): reverting this card's `giveUpHoldExtraMs` wiring (restore the
// three call sites to bare `Date.now() + GIVE_UP_HOLD_MS`) must turn (2)/(3)'s "measurably LATER" checks
// RED — both the SMALL and LARGE directive/kickoff would then redeliver at the SAME base-hold timing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-giveup-hold-scale-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const ENTER_DELAY = 20;
const VERIFY_TIMEOUT = 100;
const MAX_ATTEMPTS = 2;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "1";
process.env.LOOM_GIVE_UP_REMINT_LIMIT = "1";
process.env.LOOM_MODE_LOG_POLL_MS = "5";

// The hold-scaling constants under test — shrunk from production's real tens-of-seconds-to-minutes
// tuning, but still sized to produce a multi-SECOND gap between the SMALL and LARGE cases (not just
// hundreds of ms): a real-pty-backed test on a loaded host can see multi-second scheduling jitter on an
// individual measurement (observed directly while proving this file's own negative control), so the
// gap this test measures must comfortably outlast that jitter rather than merely outlasting the
// idealized, unloaded case.
const HOLD_MS = 500;
const ABOVE_CHARS = 100;
const BYTES_PER_MS = 1;
const MAX_EXTRA_MS = 20_000;
process.env.LOOM_GIVE_UP_HOLD_MS = String(HOLD_MS);
process.env.LOOM_GIVE_UP_HOLD_SCALE_ABOVE_CHARS = String(ABOVE_CHARS);
process.env.LOOM_GIVE_UP_HOLD_SCALE_BYTES_PER_MS = String(BYTES_PER_MS);
process.env.LOOM_GIVE_UP_HOLD_SCALE_MAX_EXTRA_MS = String(MAX_EXTRA_MS);
const expectedExtra = (len) => Math.min(MAX_EXTRA_MS, Math.max(0, Math.ceil((len - ABOVE_CHARS) / BYTES_PER_MS)));

const { PtyHost, giveUpHoldExtraMs } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

// ===== (1) UNIT: the exported formula itself, against the SAME env-overridden constants ===================
{
  check("(1) at the floor (ABOVE_CHARS exactly): zero extra", giveUpHoldExtraMs(ABOVE_CHARS) === 0);
  check("(1) comfortably under the floor: zero extra", giveUpHoldExtraMs(10) === 0);
  const justOver = ABOVE_CHARS + 1;
  check(`(1) one char over the floor: extra === 1 (ceil(1/${BYTES_PER_MS}))`, giveUpHoldExtraMs(justOver) === expectedExtra(justOver));
  const midSize = ABOVE_CHARS + 600;
  check(`(1) mid-size excess (${midSize} chars): extra === ${expectedExtra(midSize)} (linear, uncapped)`,
    giveUpHoldExtraMs(midSize) === expectedExtra(midSize) && expectedExtra(midSize) < MAX_EXTRA_MS);
  const huge = ABOVE_CHARS + MAX_EXTRA_MS * BYTES_PER_MS + 50_000;
  check(`(1) pathologically large body: capped at MAX_EXTRA_MS (${MAX_EXTRA_MS})`, giveUpHoldExtraMs(huge) === MAX_EXTRA_MS);
}

const fakes = [];
const busyLog = {};
const busyAt = {};
const events = {
  onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onExit() {},
  onBusy(id, busy) { (busyLog[id] ??= []).push(busy); (busyAt[id] ??= []).push({ busy, at: Date.now() }); },
};
class SilentTestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    const fake = { ...base, write: (d) => { writes.push(d); }, writes };
    fakes.push(fake);
    return fake;
  }
}
const host = new SilentTestPtyHost(events);
const db = new Db();
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const proj = `ghs-proj-${sfx}`, agent = `ghs-ag-${sfx}`;
db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
const mkSession = (o) => db.insertSession({
  id: o.id, projectId: proj, agentId: agent, engineSessionId: `eng-${o.id}`, title: null, cwd: tmpHome,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: o.role ?? null, parentSessionId: o.parentSessionId ?? null, taskId: o.taskId ?? null,
  worktreePath: null, branch: null,
});
const sessions = new SessionService(db, host, new OrchestrationControl());
// Wire the REAL production chain (mirrors kickoff-giveup-remint-purge.mjs) — PtyHost's own
// onKickoffGiveUpExhausted event has no DB/manager access by design (card a8f8a8f2) and must be wired to
// SessionService's handler by the HOST process, never PtyHost itself; omitting this wiring doesn't fail
// loudly — the re-mint it would have produced simply never happens, which is what scenario (3) exists to
// exercise end to end.
events.onKickoffGiveUpExhausted = (sessionId, msgId, rootMsgId, kickoffText) =>
  sessions.handleKickoffGiveUpExhausted(sessionId, msgId, rootMsgId, kickoffText);

// Hold-fire timestamp for a session: the `at` of the busy->true transition that comes AFTER the
// busy->false give-up transition that follows index `sinceFalseCount`-many false flips already seen.
// Calls `host.reconcile()` on every poll tick — a HELD entry only drains once reconcile() re-checks it
// past its own `giveUpHeldUntil`, and nothing in this harness runs that on a background timer, so the
// poll itself must keep nudging it (mirrors every sibling fixture's own explicit `host.reconcile()`
// after `sleep(HOLD_WAIT)`, just on a tight loop instead of one single fixed wait).
async function waitForNextRedrainMs(sessionId, sinceFalseCount) {
  // This poll ALSO drives reconcile() — reaching a false-count PAST `sinceFalseCount` at all can itself
  // require an earlier HELD entry to be redrained first (e.g. cycle 2 can't even start, and so can't
  // give up a SECOND time, until cycle 1's own held requeue is reconciled past its hold).
  await sharedWaitUntil(() => {
    host.reconcile();
    return (busyLog[sessionId] ?? []).filter((b) => b === false).length > sinceFalseCount;
  }, { timeoutMs: 30_000, intervalMs: 5 });
  const falseIdx = busyAt[sessionId].map((e, i) => ({ e, i })).filter((x) => x.e.busy === false)[sinceFalseCount].i;
  const t0 = busyAt[sessionId][falseIdx].at;
  await sharedWaitUntil(() => {
    host.reconcile();
    return busyAt[sessionId].slice(falseIdx + 1).some((e) => e.busy === true);
  }, { timeoutMs: 30_000, intervalMs: 5 });
  const t1 = busyAt[sessionId].slice(falseIdx + 1).find((e) => e.busy === true).at;
  return t1 - t0;
}

// ===== (2) INTEGRATION, generic message path (requeueGiveUpOrigin) ==========================================
function spawnIdleReady(sessionId) {
  host.spawn({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
  return fakes[fakes.length - 1];
}

let msgSmallHoldMs;
{
  const mgr = `ghs-mgr-a-${sfx}`;
  mkSession({ id: mgr, role: "manager" });
  const SID = `ghs-msg-small-${sfx}`;
  mkSession({ id: SID, role: "worker", parentSessionId: mgr, taskId: `tk-ghs-a-${sfx}` });
  spawnIdleReady(SID);
  const SMALL_TEXT = "x".repeat(60); // under ABOVE_CHARS — zero extra expected
  check("(2) setup: SMALL text really is under the scale floor", SMALL_TEXT.length < ABOVE_CHARS);

  const r = sessions.messageWorker(mgr, SID, SMALL_TEXT);
  check("(2) setup: delivered immediately (worker was idle)", r.delivered === true);

  msgSmallHoldMs = await waitForNextRedrainMs(SID, 0);
  try { host.stop(SID, "hard"); } catch { /* ignore */ }
}

{
  const mgr = `ghs-mgr-b-${sfx}`;
  mkSession({ id: mgr, role: "manager" });
  const SID = `ghs-msg-large-${sfx}`;
  mkSession({ id: SID, role: "worker", parentSessionId: mgr, taskId: `tk-ghs-b-${sfx}` });
  spawnIdleReady(SID);
  const LARGE_TEXT = "x".repeat(ABOVE_CHARS + 15_000); // comfortably past the floor, comfortably under the cap
  check("(2) setup: LARGE text really is past the scale floor", LARGE_TEXT.length > ABOVE_CHARS);

  const r = sessions.messageWorker(mgr, SID, LARGE_TEXT);
  check("(2) setup: delivered immediately (worker was idle)", r.delivered === true);

  const largeHoldMs = await waitForNextRedrainMs(SID, 0);
  // THE PROOF is this RELATIVE gap, not an absolute ballpark figure — a real-pty-backed measurement on a
  // loaded host can see multi-second one-sided jitter (observed directly while proving this file's own
  // negative control: one run saw a SMALL case overshoot its own ~500ms expectation by ~2.7s on an
  // otherwise-idle assertion, which is exactly why there is no absolute-ms check left in this file). The
  // designed gap (~15000ms) is sized to stay unambiguous even against that much jitter; a reverted fix
  // collapses the gap to ~0 regardless.
  check(`(2) THE PROOF [requeueGiveUpOrigin, host.ts]: the LARGE directive's hold (${largeHoldMs}ms) is measurably LONGER than the SMALL one's (${msgSmallHoldMs}ms) by at least 6000ms — a reverted fix collapses both to the same base hold`,
    largeHoldMs - msgSmallHoldMs > 6000);
  try { host.stop(SID, "hard"); } catch { /* ignore */ }
}

// ===== (2b) INTEGRATION, generic message RE-MINT path (handleGiveUpExhausted, service.ts) ==================
// Scenario (2) above only exercises `requeueGiveUpOrigin`'s own hold (cycle 1's give-up). This scenario
// isolates the OTHER service.ts call site a manager/worker-report redirect's own exhaustion-and-re-mint
// goes through — `handleGiveUpExhausted` (service.ts ~10224) — mirroring (3)'s own
// `waitForNextRedrainMs(SID, 1)` pattern but for the generic message path, not the kickoff path.
// CODE REVIEW (2d2751bc): with ONLY that one line reverted, (2)/(3)/(2b)'s own first-cycle measurements
// stay green (they drive a DIFFERENT hold), but this scenario's re-mint measurement collapses to the base
// hold — a per-site proof, not just an any-site-reverted proof.
let msg2bSmallHoldMs;
{
  const mgr = `ghs-mgr-e-${sfx}`;
  mkSession({ id: mgr, role: "manager" });
  const SID = `ghs-msg2b-small-${sfx}`;
  mkSession({ id: SID, role: "worker", parentSessionId: mgr, taskId: `tk-ghs-e-${sfx}` });
  spawnIdleReady(SID);
  const SMALL_TEXT = "x".repeat(60); // under ABOVE_CHARS
  check("(2b) setup: SMALL directive really is under the scale floor", SMALL_TEXT.length < ABOVE_CHARS);
  const r = sessions.messageWorker(mgr, SID, SMALL_TEXT);
  check("(2b) setup: delivered immediately (worker was idle)", r.delivered === true);
  await sharedWaitUntil(() => (busyLog[SID] ?? []).filter((b) => b === false).length >= 1, { timeoutMs: 10_000, intervalMs: 2 });
  msg2bSmallHoldMs = await waitForNextRedrainMs(SID, 1); // the RE-MINT's own hold, via handleGiveUpExhausted
  try { host.stop(SID, "hard"); } catch { /* ignore */ }
}

{
  const mgr = `ghs-mgr-f-${sfx}`;
  mkSession({ id: mgr, role: "manager" });
  const SID = `ghs-msg2b-large-${sfx}`;
  mkSession({ id: SID, role: "worker", parentSessionId: mgr, taskId: `tk-ghs-f-${sfx}` });
  spawnIdleReady(SID);
  const LARGE_TEXT = "x".repeat(ABOVE_CHARS + 15_000);
  check("(2b) setup: LARGE directive really is past the scale floor", LARGE_TEXT.length > ABOVE_CHARS);
  const r = sessions.messageWorker(mgr, SID, LARGE_TEXT);
  check("(2b) setup: delivered immediately (worker was idle)", r.delivered === true);
  await sharedWaitUntil(() => (busyLog[SID] ?? []).filter((b) => b === false).length >= 1, { timeoutMs: 10_000, intervalMs: 2 });
  const msg2bLargeHoldMs = await waitForNextRedrainMs(SID, 1); // the RE-MINT's own hold
  check(`(2b) THE PROOF [handleGiveUpExhausted, service.ts]: the LARGE directive's RE-MINT hold (${msg2bLargeHoldMs}ms) is measurably LONGER than the SMALL one's (${msg2bSmallHoldMs}ms) by at least 6000ms`,
    msg2bLargeHoldMs - msg2bSmallHoldMs > 6000);
  try { host.stop(SID, "hard"); } catch { /* ignore */ }
}

// ===== (3) INTEGRATION, kickoff path (handleKickoffGiveUpExhausted's own re-mint hold) ======================
function spawnKickoffReady(sessionId, startupPrompt) {
  host.spawn({
    sessionId, cwd: tmpHome, startupPrompt,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
  return fakes[fakes.length - 1];
}

let kickoffSmallHoldMs;
{
  const mgr = `ghs-mgr-c-${sfx}`;
  mkSession({ id: mgr, role: "manager" });
  const SID = `ghs-kickoff-small-${sfx}`;
  mkSession({ id: SID, role: "worker", parentSessionId: mgr, taskId: `tk-ghs-c-${sfx}` });
  const SMALL_KICKOFF = "orchestrate " + "x".repeat(40); // under ABOVE_CHARS
  spawnKickoffReady(SID, SMALL_KICKOFF);
  check("(3) setup: SMALL kickoff really is under the scale floor", SMALL_KICKOFF.length < ABOVE_CHARS);

  // Cycle 1 give-up (requeueGiveUpOrigin — covered by (2) already); cycle 2's give-up is what EXHAUSTS and
  // fires handleKickoffGiveUpExhausted's OWN re-mint hold — the timing this scenario is actually about.
  await sharedWaitUntil(() => (busyLog[SID] ?? []).filter((b) => b === false).length >= 1, { timeoutMs: 10_000, intervalMs: 2 });
  kickoffSmallHoldMs = await waitForNextRedrainMs(SID, 1); // the re-mint's own hold, after cycle 2 exhausts
  try { host.stop(SID, "hard"); } catch { /* ignore */ }
}

{
  const mgr = `ghs-mgr-d-${sfx}`;
  mkSession({ id: mgr, role: "manager" });
  const SID = `ghs-kickoff-large-${sfx}`;
  mkSession({ id: SID, role: "worker", parentSessionId: mgr, taskId: `tk-ghs-d-${sfx}` });
  const LARGE_KICKOFF = "orchestrate " + "x".repeat(ABOVE_CHARS + 15_000);
  spawnKickoffReady(SID, LARGE_KICKOFF);
  check("(3) setup: LARGE kickoff really is past the scale floor", LARGE_KICKOFF.length > ABOVE_CHARS);

  await sharedWaitUntil(() => (busyLog[SID] ?? []).filter((b) => b === false).length >= 1, { timeoutMs: 10_000, intervalMs: 2 });
  const cycle2HoldMs = await waitForNextRedrainMs(SID, 1);
  // THE PROOF, same discipline as (2)'s own relative gap — see that scenario's comment for why this is a
  // RELATIVE check, not an absolute one, and why the gap is sized to ~15000ms.
  check(`(3) THE PROOF [handleKickoffGiveUpExhausted, service.ts]: the LARGE kickoff's re-mint hold (${cycle2HoldMs}ms) is measurably LONGER than the SMALL kickoff's (${kickoffSmallHoldMs}ms) by at least 6000ms — card fd4704bc's actual root-cause fix`,
    cycle2HoldMs - kickoffSmallHoldMs > 6000);
  try { host.stop(SID, "hard"); } catch { /* ignore */ }
}

db.close();
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — card fd4704bc: GIVE_UP_HOLD_MS's extra wait scales with paste size (giveUpHoldExtraMs, "
    + "reusing pasteSettleExtraMs's own scaledExtraMs shape), wired through BOTH the generic message give-up "
    + "path (requeueGiveUpOrigin) and the kickoff-specific re-mint path (handleKickoffGiveUpExhausted) — a "
    + "small write's hold timing is unchanged, a large one's is measurably, proportionally longer."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
