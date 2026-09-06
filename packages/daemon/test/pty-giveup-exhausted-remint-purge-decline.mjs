// FIXED 2026-09-06, card dbc7ffea (successor to 66649a90/this file's own original characterization) —
// branch (1) below is now CLOSED. This file used to PIN known-defective behavior; it now asserts the FIX.
//
// WHAT CHANGED: a late engine confirmation of an exhausted-then-reminted message's ORIGINAL (cycle 1) write
// used to be unable to purge the still-held re-mint, because `Live.ambiguousDispatches` stored only ONE
// signature per logicalId and `drainPending` DELETED it outright (the "moot, about to be re-seeded"
// comment) the instant cycle 1 was redrained for its cycle-2 retry — cycle 1's own bare signature was gone
// BEFORE the redrained retry could even time out and call `requeueGiveUpOrigin` a second time, let alone
// before the re-mint existed.
//
// 📌 MECHANISM CORRECTION (from the card's own original framing): the card body describes this as
// `requeueGiveUpOrigin` "re-seeding... OVERWRITING cycle 1's bare signature" on cycle 2's own give-up. That
// is NOT what runs for this scenario — by the time `requeueGiveUpOrigin` is called for cycle 2, the entry
// is already gone (deleted at redrain, above), so its `.set()` is a fresh CREATE, not an overwrite of live
// data. A GENUINE overwrite-of-live-data path DOES exist, though, via a completely different trigger: an
// auto-joined resend (`hasAmbiguousMatch`) sharing a logicalId with a still-live entry, that itself later
// gives up — documented pre-existing in `capAmbiguousDispatches`'s own doc (card a9e4240f). Both paths are
// now fixed by the SAME archiving discipline (see `Live.retiredGiveUpSignatures`'s own doc in host.ts for
// the full correction) — this file's own repro exercises path (1) (self-retry/exhaustion, delete-based);
// `pty-giveup-retired-signature-safety.mjs` proves the archive's own safety properties (it never purges an
// unrelated logicalId, and its batch-provenance discrimination applies identically when one side of a
// collision lives in the archive).
//
// THE FIX (host.ts): `drainPending` (and, for the auto-join case, `requeueGiveUpOrigin`'s own `.set()`) now
// ARCHIVE a logicalId's superseded signature, via the shared `archiveAmbiguousDispatch` helper, into a new
// `Live.retiredGiveUpSignatures` map (logicalId → every prior cycle's own {len,hash,writtenAt,batchId}) at
// the exact point each used to just delete/overwrite it. `purgeConfirmedGiveUpRequeue`'s content-match now
// checks BOTH `ambiguousDispatches` (the current cycle) AND `retiredGiveUpSignatures` (every earlier cycle)
// before falling back to the FIFO-position logic — so a late echo of ANY prior cycle's write, not just the
// most recent one, can still be recognized and purge a still-queued duplicate. `hasAmbiguousMatch` (the
// manual-resend auto-join path) is UNCHANGED — it still only ever reads the current entry.
//
// ⚠️ BRANCH (2) IS DELIBERATELY LEFT OPEN, UNCHANGED: `purgeConfirmedGiveUpRequeue`'s FIFO-position
// fallback still never attributes to an exhausted generation (it's still never pushed onto
// `giveUpConfirmQueue` — see that method's own doc). It simply isn't REACHED in the scenario below anymore,
// because content-match (checked first) now resolves it before the fallback ever runs. A hook that arrives
// with no usable `reportedPrompt` at all (so content-match can't even run) would still hit the unfixed
// fallback — that residual is real but out of this card's scope; see the card body for why lever (b)
// (pushing exhausted generations onto the FIFO queue) was rejected as touching the loss-safety guard
// directly.
//
// LOSS-SAFETY: this fix can only ever WIDEN what a genuine, byte-matched engine confirmation is recognized
// against — it never changes any code path that guesses or infers delivery. The case the old FIFO-fallback
// guard exists to protect (a held entry must survive a FRESH, UNRELATED generation's own confirmation,
// never be misattributed and silently lost) is covered by `pty-giveup-hold-until-confirmed.mjs` scenario
// (4) and was re-verified passing, unmodified, against this fix.
//
// PROVENANCE: card 66649a90 ("make the remint re-dispatch delay LOAD-ELASTIC, not a measurement-derived
// constant") was reopened on a real production specimen, session `96c6afb8` (~9-day post-fix window, 1
// confirmed duplicate out of 54 give-up content-matched confirmations — see project memory
// `card-66649a90-duplicate-write-residual-measured`). That card's own checkpoint established the decline
// was STRUCTURAL, not timing-sensitive (identical results at `GIVE_UP_HOLD_MS=200` and `=5000`, 25x apart)
// — closing off a load-elastic hold-length remedy and handing off to this card (dbc7ffea) to fix the
// structural mechanism itself, which is what the change above does.
//
// ⛔⛔ IF YOU ARE HERE BECAUSE THIS TEST STARTED FAILING AGAIN: this file now asserts CORRECT behavior, not
// known-defective behavior. A failure here is a real regression — read the fix description above before
// changing any assertion.
//
// NOT KICKOFF-SPECIFIC: the fix lives in shared `drainPending`/`purgeConfirmedGiveUpRequeue` code in
// host.ts, reached by EVERY exhausted-then-reminted message (an ordinary agent/session message via
// `handleGiveUpExhausted` hits the identical machinery, not just a kickoff via
// `handleKickoffGiveUpExhausted`). This file drives the kickoff path only because it has the most direct
// existing test precedent (`kickoff-giveup-remint-purge.mjs`) to build on — the mechanism generalizes.
//
// A SEPARATE OBSERVATION, UNVERIFIED AT SCALE (flagged with its hedge intact — do not upgrade this): while
// building the original repro, the mismatched echo was also observed to trigger a session-facing
// `[loom:prompt-mismatch]` diagnostic NOTICE — a freshly-enqueued message that itself drains first
// (consuming the busy-free window) and goes through its own give-up/retry cycle. This plausibly explains
// part of the real `96c6afb8` specimen's own ~8-minute gap between its two confirmed hooks (competing
// busy-slot traffic, not purely `GIVE_UP_HOLD_MS`) — but this has NOT been confirmed against production
// logs at scale; treat it as a lead, not a finding. It is UNCHANGED by this fix and still fires below (it
// harmlessly gives up and is dropped — a non-durable notice with no `onGiveUpExhausted` wired).
//
// POSITIVE CONTROLS (both required — the FIXED result below is meaningless without them):
//   (BASELINE) proves this harness CAN detect a genuine content match: an EXACT tagged-text echo of
//     cycle 2's own retry DOES purge the held re-mint (mirrors `kickoff-giveup-remint-purge.mjs`'s own
//     scenario A). Without this, "the bare echo purged" could just mean the harness always reports a match.
//   (FIXED scenario's own setup checks) prove the re-mint genuinely exists and is genuinely held BEFORE the
//     late hook arrives — without this, "no duplicate landed" could just mean the re-mint never happened at
//     all (a different, unrelated non-event that would say nothing about this mechanism).
//
// RUN: `pnpm build` (from packages/daemon) then `node test/pty-giveup-exhausted-remint-purge-decline.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil, sleepPast } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const submitLog = [];
const realConsoleLog = console.log.bind(console);
const realConsoleError = console.error.bind(console);
const realConsoleWarn = console.warn.bind(console);
console.log = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleLog(...args); };
console.error = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleError(...args); };
console.warn = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleWarn(...args); };

const tmpHome = path.join(os.tmpdir(), `loom-giveup-remint-decline-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME
const ENTER_DELAY = 20;
const VERIFY_TIMEOUT = 150;
const MAX_ATTEMPTS = 2;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "1";
process.env.LOOM_MODE_LOG_POLL_MS = "5";
// A representative, fast hold — card 66649a90's investigation confirmed this test's own verdict is
// IDENTICAL at GIVE_UP_HOLD_MS=200 and =5000 (25x apart; both branches decline in both, and the duplicate
// eventually lands in both), so this file pins one fast value rather than re-running the timing comparison
// on every CI run. GIVE_UP_HOLD_MS is read ONCE at module-load time in dist/pty/host.js — it cannot vary
// within one process.
const HOLD_MS = 200;
process.env.LOOM_GIVE_UP_HOLD_MS = String(HOLD_MS);

const { PtyHost, framePossibleDuplicate } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const fakes = [];
const busyLog = {};
const events = {
  onEngineSessionId() {}, onBusy(id, busy) { (busyLog[id] ??= []).push(busy); }, onContextStats() {}, onRateLimited() {}, onExit() {},
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

const db = new Db();
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const proj = `giveup-remint-decline-proj-${sfx}`, agent = `giveup-remint-decline-ag-${sfx}`;
db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
const mkSession = (o) => db.insertSession({
  id: o.id, projectId: proj, agentId: agent, engineSessionId: `eng-${o.id}`, title: null, cwd: tmpHome,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: o.role ?? null, parentSessionId: o.parentSessionId ?? null, taskId: o.taskId ?? null,
  worktreePath: null, branch: null,
});

// Mirrors kickoff-giveup-remint-purge.mjs's own helper exactly (same production call graph: PtyHost's
// onKickoffGiveUpExhausted -> SessionService.handleKickoffGiveUpExhausted -> the same host's enqueueStdin).
async function driveToExhaustionAndCaptureCycle2Text(host, rootMsgIdBySession, SID, KICKOFF, bodyCount) {
  await sharedWaitUntil(() => bodyCount(KICKOFF) >= 1, { timeoutMs: 10_000, intervalMs: 2 });
  await sharedWaitUntil(() => busyLog[SID].at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
  check(`(${SID}) cycle 1 gave up: requeued, not yet exhausted`, host.getPendingEntries(SID).length === 1);

  // sleepPast (not a bare sleep) proves this wait genuinely exceeds GIVE_UP_HOLD_MS, the precondition the
  // held entry needs to become drainable at all — and the check this precedes (below) is itself gated by
  // TWO further sharedWaitUntil polls on an OBSERVABLE event (busy flips true, then a real new pty write
  // lands) before it ever runs, so it is not a fixed-wait-then-check in the unfalsifiable sense.
  await sleepPast(HOLD_MS + 150, HOLD_MS, "past GIVE_UP_HOLD_MS (cycle 1's hold)");
  const writesBeforeCycle2 = fakes[fakes.length - 1].writes.length;
  host.reconcile();
  await sharedWaitUntil(() => busyLog[SID].at(-1) === true, { timeoutMs: 10_000, intervalMs: 2 });
  await sharedWaitUntil(() => fakes[fakes.length - 1].writes.length > writesBeforeCycle2, { timeoutMs: 10_000, intervalMs: 2 });
  check(`(${SID}) cycle 2 wrote no NEW body chunk (Enter-only redelivery, card b9b8f8db)`, bodyCount(KICKOFF) === 1);

  await sharedWaitUntil(() => busyLog[SID].at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
  check(`(${SID}) cycle 2 gave up: the kickoff EXHAUSTED (real two-cycle exhaustion)`,
    submitLog.some((l) => l.includes("exhausted its requeue budget (1)")));
  const rootMsgId = rootMsgIdBySession[SID];
  check(`(${SID}) rootMsgId was captured via onKickoffGiveUpExhausted`, typeof rootMsgId === "string");
  return framePossibleDuplicate(KICKOFF, rootMsgId);
}

function makeHost() {
  const host = new SilentTestPtyHost(events);
  const rootMsgIdBySession = {};
  events.onKickoffGiveUpExhausted = (sessionId, msgId, rootMsgId, kickoffText) => {
    rootMsgIdBySession[sessionId] ??= rootMsgId;
    sessions.handleKickoffGiveUpExhausted(sessionId, msgId, rootMsgId, kickoffText);
  };
  const sessions = new SessionService(db, host, new OrchestrationControl());
  return { host, rootMsgIdBySession };
}

function spawnReady(host, sessionId, startupPrompt) {
  host.spawn({
    sessionId, cwd: tmpHome, startupPrompt,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
  const fake = fakes[fakes.length - 1];
  return { fake, bodyCount: (text) => fake.writes.join("").split(text).length - 1 };
}

try {
  // ===== POSITIVE CONTROL (BASELINE): reproves kickoff-giveup-remint-purge.mjs's own scenario (A) — an ====
  // ===== EXACT tagged-text echo DOES content-match and purge. Proves this harness can detect a genuine =====
  // ===== match at all, so the DECLINE scenario's own non-match below isn't just a broken rig. ==============
  {
    const { host, rootMsgIdBySession } = makeHost();
    const SID = "baseline-exact-tag-match-purges";
    const mgr = `giveup-remint-decline-mgr-base-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: SID, role: "worker", parentSessionId: mgr, taskId: `tk-base-${sfx}` });
    const KICKOFF = "orchestrate task tk-base — baseline: exact tagged echo purges the held re-mint";
    const { bodyCount } = spawnReady(host, SID, KICKOFF);

    const cycle2Text = await driveToExhaustionAndCaptureCycle2Text(host, rootMsgIdBySession, SID, KICKOFF, bodyCount);
    await sharedWaitUntil(() => host.getPendingEntries(SID).length === 1, { timeoutMs: 10_000, intervalMs: 2 });

    submitLog.length = 0;
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: cycle2Text });
    check("(BASELINE) exact tagged echo DOES content-match and purge",
      submitLog.some((l) => l.includes("CONFIRMED logicalId=") && l.includes("content-matched")));
    check("(BASELINE) the held re-mint is gone from pending", host.getPendingEntries(SID).length === 0);
    check("(BASELINE) body count stays at 1 forever — no duplicate", bodyCount(KICKOFF) === 1);
    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }

  // ===== FIXED: the 96c6afb8 shape — a genuine engine confirmation of the ORIGINAL bare write arrives ======
  // ===== late, and now content-matches via the ARCHIVED (retired) signature, purging the still-held ========
  // ===== re-mint before it can drain — no second physical write ever lands. IF ANY ASSERTION BELOW =========
  // ===== STARTS FAILING, that is a REAL REGRESSION of the fix — read the file header before changing it. ===
  {
    const { host, rootMsgIdBySession } = makeHost();
    const SID = "exhausted-remint-bare-echo-purges";
    const mgr = `giveup-remint-decline-mgr-echo-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: SID, role: "worker", parentSessionId: mgr, taskId: `tk-echo-${sfx}` });
    const KICKOFF = "orchestrate task tk-echo — bare untagged echo of the exhausted original arrives late";
    const { bodyCount } = spawnReady(host, SID, KICKOFF);

    await driveToExhaustionAndCaptureCycle2Text(host, rootMsgIdBySession, SID, KICKOFF, bodyCount);
    await sharedWaitUntil(() => host.getPendingEntries(SID).length === 1, { timeoutMs: 10_000, intervalMs: 2 });
    check("(FIXED) setup: re-mint sitting held, exactly one physical write so far", bodyCount(KICKOFF) === 1);

    // A genuine hook fires, reporting the ORIGINAL BARE text (cycle 1's own pre-give-up write) — not the
    // tagged text `ambiguousDispatches`'s CURRENT slot holds (cycle 2's own give-up moved it there). Before
    // the fix, cycle 1's bare signature was gone by this point (deleted, not archived) — now it survives in
    // `retiredGiveUpSignatures`, so this hook DOES content-match. Delivered essentially immediately — well
    // inside the hold window either way (card 66649a90 confirmed this outcome is identical at HOLD_MS=200
    // and =5000, and the fix's own correctness doesn't depend on hold length either).
    submitLog.length = 0;
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: KICKOFF });
    const purged = submitLog.some((l) => l.includes("CONFIRMED logicalId=") && l.includes("content-matched"));
    check("(FIXED) THE FIX: the bare/untagged echo of the EARLIER, retired cycle DOES content-match (CONFIRMED log present)",
      purged);
    check("(FIXED) THE FIX: the held re-mint is PURGED by this hook instead of surviving it",
      host.getPendingEntries(SID).length === 0);
    check("(FIXED) branch (2) (the FIFO-fallback's own exhausted-generation exclusion) is never reached for this hook — content-match resolved it first",
      !submitLog.some((l) => l.includes("a fresh, non-ambiguous submit") && l.includes("leaving generation")));

    // The stale UserPromptSubmit hook itself sets busy=true (the daemon now believes SOME turn is running,
    // expecting an eventual Stop/StopFailure). Nothing produces one for a turn that was never real in
    // production either. Delivering Stop here reaches that same state deliberately rather than leaving an
    // unexplained hang.
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(FIXED) busy clears after the phantom turn's Stop", busyLog[SID].at(-1) === false);

    // Let several real give-up-timeout windows elapse UNCONDITIONALLY (bounded, not gated on pending's
    // current state). Code Review Minor 4 (re-review, precise wording): pending is ALREADY asserted EMPTY
    // just above, so each of these 8 `reconcile()` calls is a genuine no-op on THIS message's own chain —
    // there is nothing left of it to redrain. What this loop actually proves is narrower than "survived
    // several real give-up cycles": it proves no TIMER-DRIVEN REDRIVE ever resurrects the purged duplicate
    // even after real elapsed time passes — including across the mismatched echo's OWN separate
    // session-facing [loom:prompt-mismatch] notice (see header's "separate observation"), which fires and
    // gives up/drops (non-durable, no `onGiveUpExhausted` wired) independently of anything this loop calls,
    // driven by its own real timers in the background. An earlier version of this loop's condition was
    // `host.getPendingEntries(SID).length > 0` — false on the very first check (pending was already empty),
    // so the loop body never ran at all and the "no second duplicate EVER lands" check below was silently
    // asserting "still 1, zero elapsed time after the purge". Iterating unconditionally (bounded at 8, a
    // backstop against a runaway loop, not a polled exit condition) is what makes this loop actually spend
    // real wall-clock time before the check below runs, rather than a no-op.
    for (let i = 0; i < 8; i++) {
      await sleepPast(HOLD_MS + 300, HOLD_MS, "past GIVE_UP_HOLD_MS (per give-up cycle)");
      host.reconcile();
    }
    check("(FIXED) POSITIVE CONTROL: no second, duplicate paste of the kickoff body EVER lands — the purge above was real, not vacuous",
      bodyCount(KICKOFF) === 1);
    check("(FIXED) pending is empty — nothing left waiting to (wrongly) drain a duplicate", host.getPendingEntries(SID).length === 0);
    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }

  db.close();
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — FIX HOLDS: an exhausted-then-reminted message's late, bare original-write confirmation " +
    "now content-matches via the archived (retired) signature and purges the still-held re-mint before it " +
    "can drain, so no second physical write ever lands (branch (1) closed; branch (2) unchanged but no " +
    "longer reached for this shape — see header). If this ever goes red, that is a real regression."
  : `\n❌ ${failures} FAILURE(S) — a real regression of the dbc7ffea fix; read the file header before changing ` +
    "any assertion.");
process.exit(failures === 0 ? 0 : 1);
