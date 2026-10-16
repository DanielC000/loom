import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 7772176d, manager CONDITION C — the double-delivery race, exercised against the REAL PtyHost purge
// (`purgeConfirmedGiveUpRequeue`, card 4a0af485), not a SessionService-level stub. `kickoff-giveup-
// exhausted.mjs`'s (S11)/(S12) prove the re-mint fires with `logicalId: rootMsgId`; this file proves that
// choice actually PREVENTS a duplicate write to the pty when the original kickoff confirms late AFTER the
// re-mint is already sitting queued — the exact scenario the manager's checkpoint review flagged as
// unproven ("landed cleanly" only shows a re-mint delivered, not that anything was ever purged).
//
// MECHANISM UNDER TEST: `handleKickoffGiveUpExhausted`'s re-mint (sessions/service.ts) is dispatched with
// `logicalId: rootMsgId` — the IDENTICAL key `requeueGiveUpOrigin` (pty/host.ts) already seeds into
// `Live.ambiguousDispatches` for the ORIGINAL kickoff write, unconditionally, even on the exhaustion branch
// (before the budget check — the `ambiguousDispatches.set(...)` line runs before `requeues >
// GIVE_UP_REQUEUE_LIMIT` is even evaluated). So if a later hook confirms the ORIGINAL write by content,
// `purgeConfirmedGiveUpRequeue`'s existing content-match purge (card 4a0af485) finds and deletes the
// still-queued re-mint by that shared `logicalId` — before it can ever drain and physically write a
// duplicate paste to the pty.
//
// THE TWO-CYCLE SHAPE (why this isn't a single give-up): `GIVE_UP_REQUEUE_LIMIT` is read as
// `Number(env) || 1` in production (pty/host.ts) — a documented, deliberate footgun-shaped default (`0` is
// falsy, so it collapses to `1`, same as unset; see `GIVE_UP_REMINT_LIMIT`'s own doc for the identical
// idiom). So exhaustion cannot be forced on the FIRST give-up here; it takes the SAME two full submit-retry
// cycles `kickoff-giveup-exhausted.mjs`'s (H1) already drives: cycle 1 gives up and REQUEUES (kept, tagged
// on its NEXT write); cycle 2's write is that tag; cycle 2 ALSO giving up is what actually exhausts and
// fires the re-mint this file is about. This test captures cycle 2's EXACT physical write (ground truth
// from the fake pty, never hand-derived from `joinSubmittedText`/`annotatePasteRecoveryAge`) and replays it
// as the late confirming hook's `prompt` — the same text `requeueGiveUpOrigin` reconstructs internally to
// seed `Live.ambiguousDispatches`, by construction.
//
// This suite proves, via a fake pty that NEVER emits output:
//   (A) THE FIX, THE ACTUAL RACE: after the real two-cycle exhaustion, the re-mint is sitting HELD in
//       pending. THEN the ORIGINAL write's late confirmation arrives (cycle 2's own exact text as
//       `hook.prompt`) BEFORE the re-mint's hold expires. Assert: the queued re-mint is PURGED by
//       logicalId (pending goes to zero), the purge's own "content-matched" log fires, and — advancing
//       past the hold and reconciling — the kickoff body count STAYS at 1 forever; the re-mint never
//       produces a second write. Asserts the COUNT, not merely the absence of an error. (Card 844ca34e:
//       the purge still matters here even though the re-mint can no longer physically re-paste either way
//       (B) — an unpurged re-mint still drains and spends a real Enter-only cycle, which (A) shows the
//       purge correctly avoids entirely.)
//   (B) card 844ca34e's OWN fix, re-pointed at this exact rig: identical setup, but NO confirming hook ever
//       arrives before the re-mint's hold expires (the purge never gets anything to act on for this entry —
//       functionally identical, from this test's perspective, to disabling the purge). Before card
//       844ca34e, advancing past the hold and reconciling here produced a real SECOND, physical paste of
//       the kickoff body (bodyCount reached 2) — the exact production bug (3 real specimens, see card
//       844ca34e's investigation) where a re-mint is a BRAND NEW QueuedMessage, so the old `isGiveUpRedelivery`
//       check (keyed off a per-message `giveUpGen` stamp) never recognized it as a redelivery of the SAME
//       lineage and let it fall into the full backspace+repaste branch on its own first attempt, every time
//       it re-minted. card 844ca34e closes that gap generically, at `Live.giveUpLineages` (keyed by
//       `logicalId`, which a re-mint always shares with its originating chain via `rootMsgId` — survives the
//       re-mint's own brand-new msgId): the re-mint STILL drains unpurged, but now takes Enter-only, exactly
//       like an ordinary same-msgId redelivery always could — bodyCount STAYS at 1, forever. Since nobody
//       ever confirms the re-mint's Enter-only cycle either, it runs through its OWN one-requeue budget and
//       exhausts a SECOND time — which PARKS (chainDepth 1 >= GIVE_UP_REMINT_LIMIT), exactly once, never a
//       silent loop.
//
// RUN: pnpm build (from packages/daemon) then `node test/kickoff-giveup-remint-purge.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Card ba4eebc1: the local `waitUntil(predicate, timeoutMs = 10_000)` poll loop that used to sit here was
// deleted — canonical-compatible (throw-on-timeout, positional predicate + timeout), so calls below now go
// straight to the shared `_wait.mjs` helper with an explicit options object (same timeoutMs default/
// intervalMs:2 this file's own defaults used — values unchanged).

const submitLog = [];
const realConsoleLog = console.log.bind(console);
const realConsoleError = console.error.bind(console);
const realConsoleWarn = console.warn.bind(console);
console.log = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleLog(...args); };
console.error = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleError(...args); };
console.warn = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleWarn(...args); };

const tmpHome = path.join(os.tmpdir(), `loom-kickoff-remint-purge-${Date.now()}-${process.pid}`);
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
// Pinned explicitly (matches production's own default of 1 — see the file-header note on why 0 can't be
// used to force single-cycle exhaustion here).
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "1";
const HOLD_MS = 200;
process.env.LOOM_GIVE_UP_HOLD_MS = String(HOLD_MS);
const HOLD_WAIT = HOLD_MS + 150;
process.env.LOOM_MODE_LOG_POLL_MS = "5";

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
const host = new SilentTestPtyHost(events);

const db = new Db();
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const proj = `kgrp-proj-${sfx}`, agent = `kgrp-ag-${sfx}`;
db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
const mkSession = (o) => db.insertSession({
  id: o.id, projectId: proj, agentId: agent, engineSessionId: `eng-${o.id}`, title: null, cwd: tmpHome,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: o.role ?? null, parentSessionId: o.parentSessionId ?? null, taskId: o.taskId ?? null,
  worktreePath: null, branch: null,
});

// Wire the REAL production chain: PtyHost's onKickoffGiveUpExhausted -> SessionService.handleKickoffGiveUpExhausted
// -> (re-mint) this SAME host's own enqueueStdin. This is the actual call graph index.ts wires, not a stub.
const sessions = new SessionService(db, host, new OrchestrationControl());
// Card b9b8f8db: capture each session's rootMsgId as it exhausts, keyed by sessionId — needed below to
// reconstruct cycle 2's LOGICAL text (framePossibleDuplicate(KICKOFF, rootMsgId)) now that cycle 2 no
// longer physically re-pastes it (see driveToExhaustionAndCaptureCycle2Text's own updated doc).
const rootMsgIdBySession = {};
events.onKickoffGiveUpExhausted = (sessionId, msgId, rootMsgId, kickoffText) => {
  rootMsgIdBySession[sessionId] ??= rootMsgId;
  sessions.handleKickoffGiveUpExhausted(sessionId, msgId, rootMsgId, kickoffText);
};

function spawnReady(sessionId, startupPrompt) {
  host.spawn({
    sessionId, cwd: tmpHome, startupPrompt,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
  const fake = fakes[fakes.length - 1];
  return { fake, bodyCount: (text) => fake.writes.join("").split(text).length - 1 };
}

/** Drives BOTH give-up cycles (mirrors kickoff-giveup-exhausted.mjs's own H1) up to and including the REAL
 *  two-cycle exhaustion that fires the NEW re-mint — then returns the LOGICAL text cycle 2 would confirm
 *  against (what a real confirming hook's `prompt` would echo back).
 *
 *  Card b9b8f8db (the composer-runaway fix): cycle 2 is a REDELIVERY of cycle 1's own message (giveUpGen
 *  set by cycle 1's requeue) — submit() now retries ONLY the Enter for that case and never re-pastes the
 *  body, so there is no physical "cycle 2 write" left in the fake pty to capture as ground truth anymore
 *  (that's the byte-growth this card removes). The signature `requeueGiveUpOrigin` seeds into
 *  `ambiguousDispatches` is UNCHANGED by that fix, though — still `textSignature(joinSubmittedText([msg],
 *  gen-1))`, which for this kickoff (mintedAtGen/mintedAtWallClock both undefined, so
 *  annotatePasteRecoveryAge is the identity function) reduces to exactly `framePossibleDuplicate(KICKOFF,
 *  logicalId)`. `logicalId` — the kickoff's `rootMsgId` — is captured via the `onKickoffGiveUpExhausted`
 *  hook this file already wires (see `rootMsgIdBySession` above), so this reconstructs the identical string
 *  via the SAME exported function production uses, rather than a physical capture. */
async function driveToExhaustionAndCaptureCycle2Text(SID, KICKOFF, bodyCount) {
  await sharedWaitUntil(() => bodyCount(KICKOFF) >= 1, { timeoutMs: 10_000, intervalMs: 2 });
  // Cycle 1: never confirmed -> give-up #1 -> within budget (LIMIT=1) -> REQUEUED, not exhausted.
  await sharedWaitUntil(() => busyLog[SID].at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
  check(`(${SID}) cycle 1 gave up: requeued, not yet exhausted`, host.getPendingEntries(SID).length === 1);

  // Drain the requeued kickoff past its hold — this is cycle 2's attempt: a redelivery of the SAME
  // message, so it retries only the Enter (card b9b8f8db) — a real pty write still happens (the
  // reassert-paste + Enter), just never the body.
  await sleep(HOLD_WAIT);
  const writesBeforeCycle2 = fakes[fakes.length - 1].writes.length;
  host.reconcile();
  await sharedWaitUntil(() => busyLog[SID].at(-1) === true, { timeoutMs: 10_000, intervalMs: 2 });
  await sharedWaitUntil(() => fakes[fakes.length - 1].writes.length > writesBeforeCycle2, { timeoutMs: 10_000, intervalMs: 2 });
  check(`(${SID}) cycle 2 wrote no NEW body chunk (Enter-only redelivery, card b9b8f8db)`,
    bodyCount(KICKOFF) === 1);

  // Cycle 2 ALSO never confirms -> THIS give-up exceeds GIVE_UP_REQUEUE_LIMIT(1) -> EXHAUSTS -> the NEW
  // re-mint fires (card 7772176d), instead of the old bare park.
  await sharedWaitUntil(() => busyLog[SID].at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
  check(`(${SID}) cycle 2 gave up: the kickoff EXHAUSTED (real two-cycle exhaustion, not the single-cycle shortcut)`,
    submitLog.some((l) => l.includes("exhausted its requeue budget (1)")));
  const rootMsgId = rootMsgIdBySession[SID];
  check(`(${SID}) rootMsgId was captured via onKickoffGiveUpExhausted`, typeof rootMsgId === "string");
  return framePossibleDuplicate(KICKOFF, rootMsgId);
}

try {
  // ===== (A) THE FIX: the original's late confirmation, arriving AFTER the re-mint is queued, purges it — ====
  // ===== the kickoff body count stays at 1 (card b9b8f8db: cycle 2 no longer re-pastes) forever; the =========
  // ===== re-mint never drains at all (purged), so it never even reaches its own Enter-only cycle (B) ========
  {
    const SID = "kickoff-remint-purged";
    const mgr = `kgrp-mgr-a-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: SID, role: "worker", parentSessionId: mgr, taskId: `tk-remint-a-${sfx}` });
    const KICKOFF = "orchestrate task tk-remint-a — original confirms LATE, after the re-mint is already queued";
    const { bodyCount } = spawnReady(SID, KICKOFF);

    const cycle2Text = await driveToExhaustionAndCaptureCycle2Text(SID, KICKOFF, bodyCount);
    check("(A) setup: exactly ONE physical body write so far (card b9b8f8db: cycle 2 retried the Enter only)", bodyCount(KICKOFF) === 1);

    // The re-mint (chainDepth 0 -> 1) is now sitting HELD in pending, targeting the SAME session, tagged.
    await sharedWaitUntil(() => host.getPendingEntries(SID).length === 1, { timeoutMs: 10_000, intervalMs: 2 });
    const remint = host.getPendingEntries(SID)[0];
    check("(A) THE RE-MINT is queued (held), carrying the possible-duplicate tag over the SAME kickoff content",
      !!remint && remint.text.includes("[loom:possible-duplicate") && remint.text.includes(KICKOFF));
    check("(A) sanity: no SECOND physical write has happened yet — the re-mint is still just sitting queued",
      bodyCount(KICKOFF) === 1);

    // THE RACE: the ORIGINAL write's late confirmation arrives NOW, BEFORE the re-mint's hold expires —
    // the LOGICAL text cycle 2's own give-up seeded into ambiguousDispatches (see the helper's own doc for
    // why this is reconstructed via framePossibleDuplicate rather than captured from a physical write).
    submitLog.length = 0;
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: cycle2Text });
    check("(A) THE PURGE FIRED: a content-matched CONFIRMED log was emitted",
      submitLog.some((l) => l.includes("CONFIRMED logicalId=") && l.includes("content-matched")));
    check("(A) THE PURGE FIRED: reported as a false negative, content-matched (the exact purge log line)",
      submitLog.some((l) => l.includes("false negative (content-matched)") && l.includes("purged a still-queued duplicate")));
    check("(A) THE RE-MINT IS GONE from pending — purged before it could ever drain", host.getPendingEntries(SID).length === 0);
    // Card (fixed-wait-negative-guard): NOT anchored on a fixed sleep-then-recheck — `deliverHook`'s
    // UserPromptSubmit handler runs `purgeConfirmedGiveUpRequeue` SYNCHRONOUSLY (no await inside it), so
    // `getPendingEntries` immediately above is already the post-purge state, not a snapshot that could still
    // change. With pending structurally EMPTY (nothing left for reconcile/drainPending to ever act on), the
    // body count observed right now is the FINAL count — there is no further async window to wait out.
    check("(A) COUNT-BASED PROOF: the kickoff body count STAYS AT 1 — the re-mint never produced a second write",
      bodyCount(KICKOFF) === 1);
    // Sanity: reconcile is a genuine no-op with nothing pending — proves the count above isn't "stale
    // because reconcile was never asked to run", it's "nothing for reconcile to find".
    host.reconcile();
    check("(A) sanity: reconcile with empty pending is a true no-op — the count is unchanged", bodyCount(KICKOFF) === 1);
    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }

  // ===== (B) card 844ca34e: same setup, but NO confirming hook ever arrives before the hold expires — the ===
  // ===== purge has nothing to act on, so the re-mint DOES drain unpurged — but, unlike pre-844ca34e, it ======
  // ===== takes Enter-only (its own lineage already gave up once), never a second physical paste. Its own ====
  // ===== Enter-only cycle also never confirms, so it exhausts AGAIN and PARKS — exactly once. =================
  {
    const SID = "kickoff-remint-unpurged";
    const mgr = `kgrp-mgr-b-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: SID, role: "worker", parentSessionId: mgr, taskId: `tk-remint-b-${sfx}` });
    const KICKOFF = "orchestrate task tk-remint-b — nobody ever confirms the original; the re-mint must drain unpurged";
    const { bodyCount } = spawnReady(SID, KICKOFF);

    await driveToExhaustionAndCaptureCycle2Text(SID, KICKOFF, bodyCount);
    check("(B) setup: exactly ONE physical body write so far (card b9b8f8db: cycle 2 retried the Enter only)", bodyCount(KICKOFF) === 1);
    await sharedWaitUntil(() => host.getPendingEntries(SID).length === 1, { timeoutMs: 10_000, intervalMs: 2 });
    check("(B) setup: the re-mint is queued (held), same as (A)", host.getPendingEntries(SID).length === 1);

    // NO confirming hook this time — advance past the hold with nothing to purge the re-mint. It drains
    // unpurged (this is what (A)'s purge exists to avoid), but card 844ca34e means its drain is Enter-only:
    // the re-mint's OWN logicalId (rootMsgId) is already in `Live.giveUpLineages` from cycle 1/2's earlier
    // give-up, so submit() never re-enters the backspace+repaste branch for it, even on this brand-new
    // QueuedMessage's own first attempt.
    submitLog.length = 0;
    await sleep(HOLD_WAIT);
    const writesBeforeRemintDrain = fakes[fakes.length - 1].writes.length;
    host.reconcile();
    await sharedWaitUntil(() => busyLog[SID].at(-1) === true, { timeoutMs: 10_000, intervalMs: 2 });
    const remintDrainBurst = fakes[fakes.length - 1].writes.slice(writesBeforeRemintDrain).join("");
    check("(B) THE FIX: the re-mint DOES drain unpurged, but its own physical write carries none of the "
      + "kickoff body — Enter-only (card 844ca34e), not a backspace+repaste",
      remintDrainBurst.length > 0 && !remintDrainBurst.includes(KICKOFF));
    check("(B) THE FIX, the count-based proof: the kickoff body was NEVER physically pasted a second time, "
      + "even though the re-mint genuinely drained unpurged — this is the assertion that goes RED against "
      + "pre-844ca34e code (there it reaches 2)",
      bodyCount(KICKOFF) === 1);
    check("(B) the Enter-only drain logged the lineage-protected reason, not the old trust-gate one",
      submitLog.some((l) => l.includes("retrying the Enter only") && l.includes("844ca34e")));

    // The re-mint's own Enter-only cycle ALSO never confirms — it runs through its own one-requeue budget
    // (same GIVE_UP_REQUEUE_LIMIT=1 every message gets) and exhausts a SECOND time, which PARKS
    // (chainDepth 1 >= GIVE_UP_REMINT_LIMIT) rather than re-minting again — never a silent loop.
    await sharedWaitUntil(() => busyLog[SID].at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
    await sharedWaitUntil(() => host.getPendingEntries(SID).length === 1, { timeoutMs: 10_000, intervalMs: 2 });
    await sleep(HOLD_WAIT);
    const writesBeforeSecondCycle = fakes[fakes.length - 1].writes.length;
    host.reconcile();
    await sharedWaitUntil(() => busyLog[SID].at(-1) === true, { timeoutMs: 10_000, intervalMs: 2 });
    // Witness a write genuinely happened before asserting what it did NOT contain — a negative assertion
    // with no such precondition could pass vacuously if this cycle somehow wrote nothing at all yet.
    await sharedWaitUntil(() => fakes[fakes.length - 1].writes.length > writesBeforeSecondCycle, { timeoutMs: 10_000, intervalMs: 2 });
    check("(B) precondition: the re-mint's own 2nd cycle actually wrote something (the poll above resolved)",
      fakes[fakes.length - 1].writes.length > writesBeforeSecondCycle);
    const secondCycleBurst = fakes[fakes.length - 1].writes.slice(writesBeforeSecondCycle).join("");
    check("(B) the re-mint's OWN redelivery (its 2nd cycle) is ALSO Enter-only, not a body write",
      secondCycleBurst.length > 0 && !secondCycleBurst.includes(KICKOFF));
    await sharedWaitUntil(() => busyLog[SID].at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
    const parkedEvents = db.listEventsForWorker(SID)
      .filter((e) => e.kind === "session_message_gave_up" && e.detail?.outcome === "parked");
    check("(B) THE SECOND EXHAUSTION PARKS — exactly once, never a silent re-mint loop", parkedEvents.length === 1);
    const remintedEvents = db.listEventsForWorker(SID)
      .filter((e) => e.kind === "session_message_gave_up" && e.detail?.outcome === "reminted");
    check("(B) sanity: exactly ONE re-mint happened total (chainDepth bound, GIVE_UP_REMINT_LIMIT=1), never a THIRD",
      remintedEvents.length === 1);
    check("(B) sanity: the kickoff body was STILL never pasted a second time, even after the park",
      bodyCount(KICKOFF) === 1);
    // Card 844ca34e DoD: bounded total bytes across the FULL chain (the ONE real body paste + cycle 2's +
    // the re-mint's own two Enter-only cycles), not just "never a second body paste" — a bare-Enter burst
    // is a handful of bytes (paste-bracket markers + one `\r`), so three full cycles of Enter-only retries
    // on TOP of the one real paste still stays comfortably under 3x one kickoff length. Pre-844ca34e code
    // would have blown well past this on the re-mint's own first attempt alone (a SECOND full body paste
    // plus a backspace burst sized off the accumulated conservative total, then a THIRD on its redelivery).
    const totalBytesWritten = fakes[fakes.length - 1].writes.join("").length;
    check(`(B) BOUNDED TOTAL BYTES across the whole chain: ${totalBytesWritten} chars written, comfortably `
      + `under 3x one kickoff length (${KICKOFF.length * 3}) — no escalating backspace+repaste ever fired`,
      totalBytesWritten < KICKOFF.length * 3);
    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }

  db.close();
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 7772176d, manager Condition C: the kickoff re-mint's shared `logicalId: rootMsgId` " +
    "is what the existing content-match purge (card 4a0af485) keys on, proven end to end against the REAL " +
    "PtyHost (not a SessionService-level stub) — an original kickoff that confirms LATE, after its re-mint " +
    "is already queued, has that re-mint PURGED before it can ever drain, so the kickoff body count never " +
    "goes past 1 (A). And card 844ca34e: when the purge has nothing to act on and the re-mint drains " +
    "UNPURGED (B), it no longer re-pastes the body either — `Live.giveUpLineages` recognizes a brand-new " +
    "re-mint QueuedMessage as the SAME lineage (shared `logicalId`/`rootMsgId`) that already gave up once, " +
    "so it takes Enter-only on its own first attempt, same as an ordinary same-msgId redelivery always " +
    "could. Its own Enter-only cycle also never confirms, so it exhausts a second time and PARKS exactly " +
    "once — never a silent re-mint loop."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
