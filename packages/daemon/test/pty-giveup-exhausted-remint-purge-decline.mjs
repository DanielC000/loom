// ⚠️⚠️ CHARACTERIZATION TEST — THIS FILE PINS CURRENT, KNOWN-DEFECTIVE BEHAVIOR. ⚠️⚠️
//
// It does NOT assert correct behavior. It exists to DOCUMENT, with a byte-for-byte reproduction, why a
// genuine late engine confirmation of an exhausted-then-reminted message's ORIGINAL write can never purge
// the still-held re-mint — and to prove that a duplicate physical write to the pty is the real, observed
// consequence, not a theoretical one.
//
// PROVENANCE: card 66649a90 ("make the remint re-dispatch delay LOAD-ELASTIC, not a measurement-derived
// constant") was reopened on a real production specimen, session `96c6afb8` (~9-day post-fix window, 1
// confirmed duplicate out of 54 give-up content-matched confirmations — see project memory
// `card-66649a90-duplicate-write-residual-measured`). Before designing a load-elastic re-dispatch delay,
// the card's own checkpoint required establishing whether the purge decline that produced `96c6afb8` was
// TIMING-sensitive (a race a longer hold could win) or STRUCTURAL (settled before any hold timer runs).
// This file is that investigation, kept as a permanent regression/characterization test. VERDICT: NOT
// timing-sensitive — the scenario below was run at `GIVE_UP_HOLD_MS=200` and `=5000` (25x apart) with
// IDENTICAL results in both directions (decline fires either way; the duplicate eventually lands either
// way, only later). Card 66649a90 was closed on this evidence: no load-elastic hold-length rule can fix
// this specimen, because both decline branches below are settled at EXHAUSTION time, before any hold
// timer is even relevant.
//
// ⛔⛔ IF YOU ARE HERE BECAUSE THIS TEST STARTED FAILING: read this before "fixing" the test. ⛔⛔
// A FAILURE below on a check labeled "KNOWN-DEFECTIVE" or "HYPOTHESIS" most likely means someone actually
// FIXED the underlying mechanism — that is progress, not a regression. Do NOT restore the old assertion,
// silence the check, or add an exemption. INVERT the assertion to match the new (correct) behavior, update
// this header to say what changed and which commit fixed it, and remove the "known-defective" framing for
// whichever branch was closed. If only ONE of the two branches below was fixed, say so explicitly — they
// are independent and can be fixed on different schedules.
//
// THE TWO INDEPENDENT DECLINE BRANCHES (both in packages/daemon/src/pty/host.ts):
//
//   (1) CONTENT-MATCH SIGNATURE OVERWRITE — `requeueGiveUpOrigin` (host.ts, seeds/refreshes
//       `Live.ambiguousDispatches`) re-seeds the SAME logicalId's entry on EVERY give-up, each time with
//       the signature of THAT generation's own just-failed submitted text. Cycle 1's give-up (the
//       original, untagged attempt) seeds the entry with the BARE signature. Cycle 2's give-up (a
//       giveUpGen-tagged retry — the one that actually exceeds GIVE_UP_REQUEUE_LIMIT and fires the
//       re-mint) OVERWRITES that SAME entry with the TAGGED signature. By the time the re-mint exists, the
//       map no longer represents cycle 1's own bare signature AT ALL — a late echo of the ORIGINAL bare
//       write can never content-match again, independent of when it arrives, because the entry it would
//       need to match against was already overwritten before the re-mint was even created.
//
//   (2) FIFO-FALLBACK "FRESH GENERATION" EXCLUSION — `purgeConfirmedGiveUpRequeue`'s FIFO-position
//       fallback (host.ts) only purges when the hook's generation is the CURRENT `submitGeneration` or is
//       itself listed in `giveUpConfirmQueue`. An EXHAUSTED generation (cycle 2, the one whose failure
//       triggers the re-mint) never gets pushed onto `giveUpConfirmQueue` at all — `requeueGiveUpOrigin`
//       `continue`s past the `giveUpConfirmQueue.push` step the moment `GIVE_UP_REQUEUE_LIMIT` is
//       exceeded, since only in-budget requeues get queued. So from the FIFO-fallback's own point of view,
//       generation 2 "looks fresh and non-ambiguous" even though it too just gave up — it declines to
//       purge generation 1's still-held entry rather than risk deleting a genuinely-unconfirmed message.
//       This exclusion is gated entirely by `GIVE_UP_REQUEUE_LIMIT`'s exhaustion branch, structurally
//       unrelated to `GIVE_UP_HOLD_MS`.
//
// NOT KICKOFF-SPECIFIC: both branches live in shared `requeueGiveUpOrigin`/`purgeConfirmedGiveUpRequeue`
// code in host.ts, reached by EVERY exhausted-then-reminted message (an ordinary agent/session message via
// `handleGiveUpExhausted` hits the identical machinery, not just a kickoff via
// `handleKickoffGiveUpExhausted`). This file drives the kickoff path only because it has the most direct
// existing test precedent (`kickoff-giveup-remint-purge.mjs`) to build on — the mechanism generalizes.
//
// A SEPARATE OBSERVATION, UNVERIFIED AT SCALE (flagged with its hedge intact — do not upgrade this): while
// building this repro, the mismatched echo was also observed to trigger a session-facing
// `[loom:prompt-mismatch]` diagnostic NOTICE — a freshly-enqueued message that itself drains first
// (consuming the busy-free window) and goes through its own give-up/retry cycle before the underlying
// re-mint gets a turn. This plausibly explains part of the real `96c6afb8` specimen's own ~8-minute gap
// between its two confirmed hooks (competing busy-slot traffic, not purely `GIVE_UP_HOLD_MS`) — but this
// has NOT been confirmed against production logs at scale; treat it as a lead, not a finding.
//
// POSITIVE CONTROLS (both required — the negative result below is meaningless without them):
//   (BASELINE) proves this harness CAN detect a genuine content match: an EXACT tagged-text echo of
//     cycle 2's own retry DOES purge the held re-mint (mirrors `kickoff-giveup-remint-purge.mjs`'s own
//     scenario A). Without this, "the mismatched echo didn't purge" could just mean the harness is broken.
//   (DECLINE scenario's own final check) proves the duplicate write is REAL, not merely "nothing appeared
//     to happen": the fake pty must actually receive the kickoff body TWICE. Without this, "no purge
//     occurred" could just mean the re-mint never drained at all (a different, unrelated failure to purge
//     that would say nothing about this mechanism).
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

  // ===== KNOWN-DEFECTIVE: the 96c6afb8 shape — a genuine engine confirmation of the ORIGINAL bare write ====
  // ===== arrives, but BOTH purge branches decline (see the header for why), and the held re-mint later =====
  // ===== drains anyway, producing a real second physical write. IF EITHER "does NOT" ASSERTION BELOW =======
  // ===== STARTS FAILING, READ THE HEADER — that is the mechanism being fixed, not a regression. ============
  {
    const { host, rootMsgIdBySession } = makeHost();
    const SID = "exhausted-remint-bare-echo-declines";
    const mgr = `giveup-remint-decline-mgr-echo-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: SID, role: "worker", parentSessionId: mgr, taskId: `tk-echo-${sfx}` });
    const KICKOFF = "orchestrate task tk-echo — bare untagged echo of the exhausted original arrives late";
    const { bodyCount } = spawnReady(host, SID, KICKOFF);

    await driveToExhaustionAndCaptureCycle2Text(host, rootMsgIdBySession, SID, KICKOFF, bodyCount);
    await sharedWaitUntil(() => host.getPendingEntries(SID).length === 1, { timeoutMs: 10_000, intervalMs: 2 });
    check("(DECLINE) setup: re-mint sitting held, exactly one physical write so far", bodyCount(KICKOFF) === 1);

    // A genuine hook fires, reporting the ORIGINAL BARE text (cycle 1's own pre-give-up write) — not the
    // tagged text `ambiguousDispatches` now holds (overwritten by cycle 2's own give-up; see header branch
    // (1)). Delivered essentially immediately — well inside the hold window either way (card 66649a90
    // confirmed this outcome is identical at HOLD_MS=200 and =5000).
    submitLog.length = 0;
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: KICKOFF });
    const purged = submitLog.some((l) => l.includes("CONFIRMED logicalId=") && l.includes("content-matched"));
    check("(DECLINE) KNOWN-DEFECTIVE: the bare/untagged echo does NOT content-match (no CONFIRMED log) — header branch (1)",
      !purged);
    check("(DECLINE) KNOWN-DEFECTIVE: the held re-mint SURVIVES this hook instead of being purged — header branch (2) also declines",
      host.getPendingEntries(SID).length === 1);
    check("(DECLINE) the specimen's own diagnostic line fired (confirms this repro hits the SAME branch as the real incident)",
      submitLog.some((l) => l.includes("a fresh, non-ambiguous submit") && l.includes("leaving generation")));

    // The stale UserPromptSubmit hook itself sets busy=true (the daemon now believes SOME turn is running,
    // expecting an eventual Stop/StopFailure). Nothing produces one for a turn that was never real in
    // production either — the real specimen's own write-up says "the reminted copy drained anyway once
    // busy freed", i.e. busy DID eventually clear. Delivering Stop here reaches that same state
    // deliberately rather than leaving an unexplained hang.
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(DECLINE) busy clears after the phantom turn's Stop", busyLog[SID].at(-1) === false);

    // Advance through several give-up cycles (bounded) rather than assuming one hold window is enough —
    // the mismatched echo ALSO triggers its own session-facing [loom:prompt-mismatch] notice, which drains
    // first and goes through its own give-up cycle before the kickoff re-mint gets a turn (see header's
    // "separate observation"). This loop's own condition RE-CHECKS bodyCount(KICKOFF) < 2 before each
    // sleep and exits the instant it's satisfied (bounded at 8 iterations as a backstop) — it is a poll,
    // not a single fixed wait, so it cannot pass vacuously for "hasn't happened yet".
    // TIMING-GUARD-FALSE-MATCH: keyword-in-methodology-aside — NEG_KEYWORDS' bare "not" below matches
    // inside the label's methodology parenthetical ("proves ... is real, not vacuous"), same shape as
    // pty-giveup-suppressed-terminal-recheck.mjs's own identical annotation. The label's actual assertion
    // (`bodyCount(KICKOFF) === 2`) is POSITIVE-polarity — it asserts something DID happen twice, not that
    // something did NOT happen — and fails loudly if the second write never lands. sleepPast also proves
    // each iteration's wait genuinely exceeds GIVE_UP_HOLD_MS rather than an arbitrary guess.
    for (let i = 0; i < 8 && bodyCount(KICKOFF) < 2; i++) {
      await sleepPast(HOLD_MS + 300, HOLD_MS, "past GIVE_UP_HOLD_MS (per give-up cycle)");
      host.reconcile();
    }
    check("(DECLINE) POSITIVE CONTROL: the re-mint eventually drains and writes a genuine SECOND, duplicate paste — proves the decline above is real, not vacuous",
      bodyCount(KICKOFF) === 2);
    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }

  db.close();
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — CHARACTERIZATION HOLDS: an exhausted-then-reminted message's late, bare original-write " +
    "confirmation still fails to purge the held re-mint (both branches decline for structural, non-timing " +
    "reasons — see header), and the re-mint still lands as a genuine duplicate physical write. If this ever " +
    "goes red, read the file header before touching the assertions."
  : `\n❌ ${failures} FAILURE(S) — if a KNOWN-DEFECTIVE check above just started failing, the mechanism was ` +
    "likely FIXED; read the header and update the assertions rather than reverting to make this pass.");
process.exit(failures === 0 ? 0 : 1);
