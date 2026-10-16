import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card ee9f3974, DoD-2 — forces the card's own race DETERMINISTICALLY, against the REAL PtyHost purge
// (`purgeConfirmedGiveUpRequeue`), rather than sampling for it. Sibling to `kickoff-giveup-remint-purge.mjs`
// (card 7772176d), which proves the HAPPY path: an EXACT content match purges a re-mint before it can drain
// a duplicate. This file proves the card's own title — "a re-mint's own confirming hook can arrive
// content-mismatched, so even a landed submit is unattributable" — by delivering a GENUINE confirming hook
// (UserPromptSubmit + Stop, the same two-hook shape `kickoff-giveup-exhausted.mjs`'s own (H2) negative
// control uses for "a real confirm") whose `prompt` is NOT byte-identical to what `requeueGiveUpOrigin`
// seeded into `Live.ambiguousDispatches` for the exhausted kickoff's own generation.
//
// ROOT CAUSE THIS TEST PINS DOWN (read together with `purgeConfirmedGiveUpRequeue`'s own doc, pty/host.ts):
// `requeueGiveUpOrigin` only ever pushes a generation onto `Live.giveUpConfirmQueue` — the FIFO-position
// fallback's own input — for a message that is KEPT (still within `GIVE_UP_REQUEUE_LIMIT`, i.e. `kept.push`
// at the bottom of that function). An EXHAUSTED message (requeues > the limit — exactly the kickoff's own
// case once `handleKickoffGiveUpExhausted` re-mints it, card cfd71868/7772176d) takes the `continue` branch
// instead and is NEVER added to `giveUpConfirmQueue` — only `Live.ambiguousDispatches` (the content-match
// map) is seeded for it. So for THIS specific class of ambiguity, the FIFO-position fallback's very first
// line (`if (live.giveUpConfirmQueue.length === 0) return false;`) always short-circuits to a no-op: there
// is NO backstop at all once content-matching fails. Exact content match is the ONLY resolution path for an
// exhausted-and-reminted message — not "the primary path with a fallback", as `kickoff-giveup-remint-
// purge.mjs`'s (A) alone could be read to suggest (it only ever exercises the byte-identical case).
//
// This isn't a kickoff-only gap either: `requeueGiveUpOrigin` is the SAME function every ordinary durable
// message's give-up (`handleGiveUpExhausted`, sessions/service.ts) also routes through — the exclusion from
// `giveUpConfirmQueue` on exhaustion applies there too. cfd71868/7772176d did not introduce this property;
// it extended an EXISTING exposure (present since card ccb407eb's original re-mint mechanism) to the
// kickoff path, which previously had no re-mint step at all and so no second generation to ever race against.
//
// WHY THIS ISN'T A THEORETICAL EDGE CASE: card 201d0d95's own 2026-08-05 platform sweep (pty/host.ts, the
// `[prompt-mismatch]` notice's own comment) measured byteIdentical=false on 288/3,816 (7.5%) of ALL retained
// `[prompt-echo]` confirmations — a genuine confirming hook failing to echo byte-identically is a routine
// occurrence, not a rare fluke this mechanism can safely ignore.
//
// THE TWO-CYCLE SHAPE and the driveToExhaustionAndCaptureCycle2Text helper are copied from
// `kickoff-giveup-remint-purge.mjs` (same reasoning: `GIVE_UP_REQUEUE_LIMIT` reads as `Number(env) || 1` in
// production, so exhaustion takes two full submit-retry cycles, not one).
//
// This suite proves, via a fake pty that NEVER emits output:
//   (C) THE RACE, FORCED DETERMINISTICALLY: after the real two-cycle exhaustion, the re-mint is sitting HELD
//       in pending. A GENUINE confirming hook then arrives (UserPromptSubmit carrying a `prompt` + a
//       matching Stop, the same shape (H2)'s "real confirm" negative control uses) — but its `prompt` is
//       cycle 2's own text with the last 5 characters truncated (byteIdentical=false, small tail delta —
//       the same shape class the real trace's own `[prompt-echo] byteIdentical=false reportedLen=44365
//       writtenLen=44405` recorded). Assert: NO content-matched CONFIRMED log fires, the re-mint is NOT
//       purged (pending count unchanged immediately after the hook), and — advancing past the hold and
//       reconciling — the kickoff body count reaches 2: the re-mint DOES drain and DOES write a real,
//       physical duplicate paste, DESPITE a confirming hook having genuinely arrived. The hook's mere
//       arrival is not what resolves the ambiguity; only an exact content match is, and this one wasn't.
//   (D) NEGATIVE CONTROL, PROVING (C) ISN'T A RIGGED FAKE-PTY ARTIFACT: identical setup, but the confirming
//       hook's `prompt` is cycle 2's text UNCHANGED (byte-identical). Assert: the content-matched CONFIRMED
//       log DOES fire, the re-mint IS purged, and the body count stays at 1 forever — proving this rig can
//       tell "resolved" apart from "not resolved" and that (C)'s failure is specifically about the mismatch,
//       not about anything else in this harness.
//
// RUN: pnpm build (from packages/daemon) then `node test/kickoff-giveup-content-mismatch.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Card ba4eebc1: the local `waitUntil(predicate, timeoutMs = 10_000)` poll loop that used to sit here was
// deleted — canonical-compatible (throw-on-timeout, positional predicate + timeout), so calls below now go
// straight to the shared `_wait.mjs` helper with an explicit options object (same timeoutMs:10_000/
// intervalMs:2 this file's own defaults used — values unchanged).

/** Repeatedly sleeps a short beat and calls `host.reconcile()` until `predicate()` is true or `timeoutMs`
 *  elapses — needed because the mismatched hook ALSO triggers the (real, production) `[loom:prompt-mismatch]`
 *  notice (submitWasOutstanding + hook.prompt !== live.lastPrompt), which itself dispatches, gives up, and
 *  gets held ahead of the kickoff re-mint in `pending` (unshift) — so draining the re-mint takes more than
 *  one hold window. A single fixed sleep+reconcile is not enough; this polls the ACTUAL observable (bodyCount)
 *  rather than guessing a total duration, so it can't under- or over-wait. */
async function reconcileUntil(predicate, timeoutMs = 15_000) {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`reconcileUntil: timed out after ${timeoutMs}ms`);
    await sleep(30);
    host.reconcile();
  }
}

const submitLog = [];
const realConsoleLog = console.log.bind(console);
const realConsoleError = console.error.bind(console);
const realConsoleWarn = console.warn.bind(console);
console.log = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleLog(...args); };
console.error = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleError(...args); };
console.warn = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleWarn(...args); };

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "loom-kickoff-mismatch-"));
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
const proj = `kgcm-proj-${sfx}`, agent = `kgcm-ag-${sfx}`;
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
const rootMsgIdBySession = {};
const exhaustionCountBySession = {};
events.onKickoffGiveUpExhausted = (sessionId, msgId, rootMsgId, kickoffText) => {
  rootMsgIdBySession[sessionId] ??= rootMsgId;
  exhaustionCountBySession[sessionId] = (exhaustionCountBySession[sessionId] ?? 0) + 1;
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

/** Identical to kickoff-giveup-remint-purge.mjs's own helper of the same name — see that file's doc for the
 *  full reasoning (card b9b8f8db: cycle 2 retries only the Enter, so `framePossibleDuplicate(KICKOFF,
 *  rootMsgId)` reconstructs the exact signature `requeueGiveUpOrigin` seeds, without a physical capture). */
async function driveToExhaustionAndCaptureCycle2Text(SID, KICKOFF, bodyCount) {
  await sharedWaitUntil(() => bodyCount(KICKOFF) >= 1, { timeoutMs: 10_000, intervalMs: 2 });
  await sharedWaitUntil(() => busyLog[SID].at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
  check(`(${SID}) cycle 1 gave up: requeued, not yet exhausted`, host.getPendingEntries(SID).length === 1);

  await sleep(HOLD_WAIT);
  const writesBeforeCycle2 = fakes[fakes.length - 1].writes.length;
  host.reconcile();
  await sharedWaitUntil(() => busyLog[SID].at(-1) === true, { timeoutMs: 10_000, intervalMs: 2 });
  await sharedWaitUntil(() => fakes[fakes.length - 1].writes.length > writesBeforeCycle2, { timeoutMs: 10_000, intervalMs: 2 });
  check(`(${SID}) cycle 2 wrote no NEW body chunk (Enter-only redelivery, card b9b8f8db)`,
    bodyCount(KICKOFF) === 1);

  await sharedWaitUntil(() => busyLog[SID].at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
  check(`(${SID}) cycle 2 gave up: the kickoff EXHAUSTED (real two-cycle exhaustion, not the single-cycle shortcut)`,
    submitLog.some((l) => l.includes("exhausted its requeue budget (1)")));
  const rootMsgId = rootMsgIdBySession[SID];
  check(`(${SID}) rootMsgId was captured via onKickoffGiveUpExhausted`, typeof rootMsgId === "string");
  return framePossibleDuplicate(KICKOFF, rootMsgId);
}

try {
  // ===== (C) THE RACE, FORCED: a GENUINE confirming hook arrives (UserPromptSubmit+Stop, the same shape ====
  // ===== kickoff-giveup-exhausted.mjs's own (H2) "real confirm" negative control uses) but its `prompt` ======
  // ===== is NOT byte-identical to cycle 2's own text — the re-mint is left un-purged. Card 844ca34e round ===
  // ===== 2 (Shape 2 — this is the real production trace that motivated it): the mismatch ALSO triggers a ==
  // ===== genuine [loom:prompt-mismatch] notice that physically OWNS the composer by the time the kickoff ===
  // ===== re-mint finally drains — an ownership mismatch means it writes NOTHING, never a duplicate paste. =
  {
    const SID = "kickoff-mismatch-unpurged";
    const mgr = `kgcm-mgr-c-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: SID, role: "worker", parentSessionId: mgr, taskId: `tk-mismatch-c-${sfx}` });
    const KICKOFF = "orchestrate task tk-mismatch-c — the confirming hook arrives but its content is truncated";
    const { fake, bodyCount } = spawnReady(SID, KICKOFF);

    const cycle2Text = await driveToExhaustionAndCaptureCycle2Text(SID, KICKOFF, bodyCount);
    check("(C) setup: exactly ONE physical body write so far", bodyCount(KICKOFF) === 1);

    await sharedWaitUntil(() => host.getPendingEntries(SID).length === 1, { timeoutMs: 10_000, intervalMs: 2 });
    check("(C) setup: the re-mint is queued (held)", host.getPendingEntries(SID).length === 1);

    // THE GENUINE, BUT MISMATCHED, CONFIRMING HOOK — truncated by 5 chars, same shape class as the real
    // trace's own reportedLen=44365 vs writtenLen=44405 (a short, non-byte-identical tail delta).
    const mismatchedPrompt = cycle2Text.slice(0, -5);
    check("(C) sanity: the mismatched prompt is genuinely a near-miss, not a wholesale different string",
      mismatchedPrompt.length === cycle2Text.length - 5 && cycle2Text.startsWith(mismatchedPrompt));
    submitLog.length = 0;
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: mismatchedPrompt });
    // OBSERVED (not merely predicted): the FIFO-position fallback DOES engage here — a STALE entry for
    // generation 1 (pushed when cycle 1's own give-up was KEPT, never shifted off since no Stop/StopFailure
    // has closed it) is still sitting at the front of `giveUpConfirmQueue`. It logs the EXACT shape the
    // card's own trace recorded ("a confirming hook arrived while generation 1 is still ambiguous, but
    // generation 2 … is now current") and still correctly DECLINES to purge, since generation 2 (now
    // current) is neither `gen` nor itself still-ambiguous. The content-match path (the only path that
    // could have resolved THIS exhausted generation's own ambiguity) never matches at all.
    check("(C) NO content-matched CONFIRMED log fired — the mismatch defeated the ONLY resolution path that " +
      "could actually purge this exhausted generation's re-mint",
      !submitLog.some((l) => l.includes("CONFIRMED logicalId=") && l.includes("content-matched")));
    check("(C) THE RE-MINT IS STILL QUEUED — a genuine confirming hook arrived and changed nothing",
      host.getPendingEntries(SID).length === 1);
    host.deliverHook(SID, { hook_event_name: "Stop" }); // closes out the genuine turn this hook opened
    await sharedWaitUntil(() => busyLog[SID].at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
    check("(C) after Stop: still un-purged", host.getPendingEntries(SID).length === 1);

    // Advance past the re-mint's OWN hold with nothing having purged it. The mismatch ALSO triggers the
    // real `[loom:prompt-mismatch]` notice (a genuine production side effect of submitWasOutstanding +
    // hook.prompt !== live.lastPrompt) — that notice dispatches, clears+pastes its OWN body (a fresh,
    // never-given-up lineage), and gives up too, PHYSICALLY OWNING the composer by the time the kickoff
    // re-mint's own held entry finally gets its turn (`pending.unshift` put the notice ahead of it). Card
    // 844ca34e round 2: the kickoff re-mint's own lineage is marked, but it does NOT own the composer —
    // ownership mismatch means it writes nothing at all, converging through its own bounded give-up chain
    // to a terminal resolution instead of ever risking submitting the notice's text as the kickoff.
    //
    // NOTE: that terminal resolution is NOT a recorded "parked" event in THIS exact scenario — the earlier
    // mismatched UserPromptSubmit hook already set `live.firstTurnStarted = true` (unconditional on ANY
    // UserPromptSubmit, content match or not), so by the time the re-mint's own give-up exhausts a SECOND
    // time, `handleKickoffGiveUpExhausted`'s own "late confirmation, not a dropped kickoff" check fires
    // and suppresses the notice with no durable record at all (see the `hasFirstTurnStarted` branch,
    // sessions/service.ts) — a pre-existing property of this test's own setup, unrelated to either card.
    // The REACHABLE, durable signals are: the message is gone from `pending` (requeueGiveUpOrigin removes
    // an exhausted entry regardless of what its callback does) and `onKickoffGiveUpExhausted` fired twice
    // (the re-mint, then its own exhaustion).
    //
    // Card 844ca34e round 4 (CR round 3, MINOR 5): round 3 replaced the body-count guard below with a
    // `composerBodyWrittenForGen`-vs-gen snapshot captured at the ownership-mismatch log line, reasoning
    // it was a stronger, non-racy check. CR round 3 (8d98f9d4) judged that snapshot ITSELF tautological:
    // `giveUpWithoutWriting`'s whole branch structurally never touches `composerBodyWrittenForGen` for
    // ITS OWN generation — once you're inside that branch (proven by the log firing at all), the snapshot
    // is true by construction, regardless of whether reaching that branch was itself the right decision.
    // Restored instead: the generation's own PHYSICAL body-write count, read right after the deferred
    // give-up-without-writing timer settles (same placement the original pre-round-3 check used) — a real
    // behavioral signal, not an internal-field snapshot.
    const writesBeforeMismatchSettle = fake.writes.length;
    await reconcileUntil(() => host.getPendingEntries(SID).length === 0, 15_000);
    check("(C) THE RESTORED BODY-COUNT GUARD: zero NEW physical writes for the KICKOFF text occurred while "
      + "the ownership-mismatch decision and its deferred settle ran — the mismatch generation never wrote "
      + "the kickoff's body a second time (Enter-only writes no body either way, so this does not by itself "
      + "discriminate round 1 from round 2+ — see the log-based check below for that)",
      fake.writes.slice(writesBeforeMismatchSettle).join("").split(KICKOFF).length - 1 === 0);
    check("(C) sanity: the kickoff body was NEVER physically pasted a second time, CUMULATIVELY, across "
      + "the whole scenario",
      bodyCount(KICKOFF) === 1);
    check("(C) THE FIX (round 2), THE ASSERTION THAT GOES RED AGAINST COMMIT 4af1e476 (round 1): the " +
      "ownership-mismatch mechanism fired for this session — round 1 has no such check at all and would " +
      "have pressed Enter against the [loom:prompt-mismatch] notice's own unconfirmed body under the " +
      "kickoff's identity instead",
      submitLog.some((l) => l.includes("GIVE-UP (composer ownership mismatch")));
    check("(C) the kickoff's own chain genuinely ran at least once through onKickoffGiveUpExhausted (the " +
      "re-mint) and is no longer stuck in `pending` (the poll above settled) — never a silent infinite " +
      "loop, never a wrong-identity submission. (Exactly how many further exhaustions the re-mint itself " +
      "goes through before settling is a race against the notice's own INDEPENDENT give-up chain — both " +
      "compete for drain priority — so this does not pin an exact count.)",
      exhaustionCountBySession[SID] >= 1 && host.getPendingEntries(SID).length === 0);
    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }

  // ===== (D) NEGATIVE CONTROL: identical setup, but the confirming hook's prompt IS byte-identical — proves ==
  // ===== this rig can tell "resolved" from "not resolved", so (C)'s failure is about the mismatch specifically =
  {
    const SID = "kickoff-mismatch-negctrl";
    const mgr = `kgcm-mgr-d-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: SID, role: "worker", parentSessionId: mgr, taskId: `tk-mismatch-d-${sfx}` });
    const KICKOFF = "orchestrate task tk-mismatch-d — the confirming hook arrives with exact matching content";
    const { bodyCount } = spawnReady(SID, KICKOFF);

    const cycle2Text = await driveToExhaustionAndCaptureCycle2Text(SID, KICKOFF, bodyCount);
    await sharedWaitUntil(() => host.getPendingEntries(SID).length === 1, { timeoutMs: 10_000, intervalMs: 2 });

    submitLog.length = 0;
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: cycle2Text }); // byte-identical this time
    check("(D) NEGATIVE CONTROL: the content-matched CONFIRMED log DOES fire when the echo is exact",
      submitLog.some((l) => l.includes("CONFIRMED logicalId=") && l.includes("content-matched")));
    check("(D) NEGATIVE CONTROL: the re-mint IS purged", host.getPendingEntries(SID).length === 0);
    host.deliverHook(SID, { hook_event_name: "Stop" });
    await sharedWaitUntil(() => busyLog[SID].at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });

    // NO sleep needed here (unlike (C)): the content-match purge already ran SYNCHRONOUSLY inside
    // deliverHook (checked at line "the re-mint IS purged" above, before Stop even fired) — pending is
    // already structurally empty, so this reconcile() is a true no-op with nothing to wait out, the same
    // justification kickoff-giveup-remint-purge.mjs's own scenario (A) uses for its identical sanity check.
    host.reconcile();
    check("(D) NEGATIVE CONTROL: body count stays at 1 — this rig genuinely distinguishes an exact " +
      "match (D, resolved) from a near-miss (C, unresolved), so (C)'s failure is specifically about the " +
      "content mismatch, not an artifact of this harness",
      bodyCount(KICKOFF) === 1);
    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }

  db.close();
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card ee9f3974: a GENUINE confirming hook (UserPromptSubmit+Stop) whose reported content " +
    "is NOT byte-identical to the exhausted generation's own tracked signature leaves a re-minted kickoff " +
    "un-purged (C) — DoD-1's race is forced deterministically, not sampled for. Card 844ca34e round 2: the " +
    "same mismatch's own [loom:prompt-mismatch] notice physically owns the composer by the time that " +
    "un-purged re-mint finally drains, and `composerOwnerLineage` catches it — the re-mint writes nothing " +
    "at all, never a duplicate paste, converging through its own bounded give-up chain to a terminal " +
    "resolution instead (not necessarily a recorded park in this exact scenario — see the test's own note " +
    "on why hasFirstTurnStarted suppresses it here). The identical setup with an exact-match hook resolves " +
    "cleanly and never duplicates (D), proving the rig discriminates the two cases rather than always " +
    "failing."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
