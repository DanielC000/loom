// Regression test for card 9e27f4d2 — "a restart replays a held give-up requeue with neither hold nor
// purge" (found by the Code Reviewer while reviewing 73d5c34a, which added the give-up hold this bypasses).
//
// ROOT CAUSE: the pending snapshot carried a still-`isGiveUpHeld` entry as its TEXT ONLY, dropping
// `giveUpHeldUntil`. `daemon_restart`'s intent is consumed at boot BEFORE any confirming hook can fire, so
// a restart landing mid-hold-window replayed the entry on boot as an ordinary fresh message with NO hold —
// delivering the duplicate UNCONDITIONALLY and IMMEDIATELY, regardless of how much of the hold window was
// actually left. That reintroduces the exact double-delivery card 73d5c34a exists to prevent.
//
// THE FIX (round two, after code review rejected a widen-the-element-type first attempt as itself a LOSS
// bug — see restart.ts's `RestartIntent.pendingHolds` doc and host.ts's `getPersistablePendingSnapshot`
// doc for the full why): `RestartIntent.pending` stays a bare
// `Record<string, string[]>` — byte-identical on disk to the pre-this-card shape — and the give-up hold's
// `giveUpHeldUntil` deadline is carried in a wholly separate, ADDITIVE sibling field, `pendingHolds:
// Record<string, Record<number, number>>` (session → index into that session's `pending` array →
// deadline). `resumeFleetOnBoot`'s replay restores that deadline via `enqueueStdin`'s `giveUpHeldUntil`
// param, so `isGiveUpHeld` keeps the entry out of `drainPending` until the window naturally expires
// post-boot — degrading a restart-during-hold to the SAME delayed-duplicate SHAPE as the already-accepted
// residual (1) at `purgeConfirmedGiveUpRequeue` ("a confirming hook arriving too late still
// double-delivers"), though CERTAIN rather than merely probable (no confirming hook can ever reach a dead
// process's generation) — never the NEW, categorically worse "immediate and unconditional" bypass this
// card closes. An OLDER daemon (or any reader that only understands `pending`) sees nothing but the plain
// strings it always has — an unheld duplicate, the ALREADY-ACCEPTED pre-this-card behavior — never a
// garbled `"[object Object]"` loss.
//
// This suite proves, against a real (fake-pty-backed) PtyHost driving a genuine give-up, THEN a simulated
// restart onto a SECOND, fresh PtyHost instance (mirroring "the process dies, a new one boots" — same
// convention as queued-message-durability.mjs's Part B):
//   (1) getPersistablePendingSnapshot's `texts` half is unaffected (still bare strings, held or not) —
//       its `holds` half carries a still-held entry's deadline, keyed by that entry's index into `texts`,
//       returned from the SAME single-pass call so the two can never fall out of index alignment. Both
//       round-trip through the REAL on-disk intent file (writeRestartIntent/readRestartIntent) exactly
//       as `pending`/`pendingHolds`.
//   (2) OLD-DAEMON COMPATIBILITY (the direction the blocking review finding was about): replaying the
//       round-tripped `pending` array through the OLD (pre-9e27f4d2) call shape — plain strings only,
//       `pendingHolds` never even looked at — delivers the full, uncorrupted text with no crash and no
//       hold. Bad (an unheld duplicate) but survivable, never a loss — proving the additive format is
//       actually backward-compatible instead of merely claimed to be.
//   (3) THE FIX, through the REAL `SessionService.resumeFleetOnBoot` replay path (not a hand-rolled stub):
//       replaying the SAME `pending` text alongside its `pendingHolds` deadline restores the hold onto the
//       resumed session — it survives the first ready-drain UNDELIVERED, exactly as it would have on the
//       original (never-restarted) pty, while an unrelated queued entry behind it is never stalled.
//   (4) Once the restored hold naturally expires (no confirming hook can ever arrive post-restart — the
//       intent is consumed before any hook could fire), the entry still delivers — a delayed, honest
//       duplicate, never a silent loss.
//   (5) FAIL-OPEN, NOT FAIL-HARD: a malformed/corrupted pending entry (e.g. `null` — an on-disk intent is
//       un-versioned JSON, so this is reachable) is skipped and logged, never thrown — `resumeFleetOnBoot`
//       has no try/catch of its own and the intent file is already deleted by the time it runs, so an
//       uncaught throw here would abort resuming every LATER session in the fleet with nothing left to
//       retry from. The well-formed entries immediately before and after the bad one still replay.
//
// RUN (no daemon needed): node test/restart-giveup-hold.mjs
//   Requires the daemon built first (reads ../dist/*.js): from packages/daemon, run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flush = () => new Promise((r) => setTimeout(r, 0));
/** Bounded poll until `predicate()` is true — observe the real state transition instead of guessing a
 *  wall-clock deadline (this project's own blind-sleep campaign; see pty-giveup-hold-until-confirmed.mjs). */
async function waitUntil(predicate, timeoutMs = 10_000) {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitUntil: timed out after ${timeoutMs}ms`);
    await sleep(2);
  }
}

const tmpHome = path.join(os.tmpdir(), `loom-rgh-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const ENTER_DELAY = 20;
const VERIFY_TIMEOUT = 150;
const MAX_ATTEMPTS = 2;
const HOLD_MS = 350; // small + deterministic, mirrors pty-giveup-hold-until-confirmed.mjs's own HOLD_MS
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_GIVE_UP_HOLD_MS = String(HOLD_MS);

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const restart = await import("../dist/orchestration/restart.js");

const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/** Decorates the shared fixture's base pty with write-capture — every give-up this drives is a genuine
 *  drop, never the false-negative/SUPPRESSED case (that's pty-giveup-false-negative.mjs's job). */
function decorateSilentFakePty(base, fakes) {
  const writes = [];
  const fake = { ...base, write: (d) => { writes.push(d); }, writes };
  fakes.push(fake);
  return fake;
}

try {
  // ===================== SETUP: drive a genuine give-up on a REAL "pre-restart" PtyHost ===================
  const fakesPre = [];
  class PreHost extends createSeamHost(PtyHost) { createPty(opts) { return decorateSilentFakePty(super.createPty(opts), fakesPre); } }
  const busyLogPre = {};
  const hostPre = new PreHost({
    onEngineSessionId() {}, onBusy(id, busy) { (busyLogPre[id] ??= []).push(busy); },
    onContextStats() {}, onRateLimited() {}, onExit() {},
  });

  const SID = `rgh-sess-${sfx}`;
  const TEXT = "HELD_GIVE_UP_SURVIVES_A_RESTART";
  const PLAIN_TEXT = "ORDINARY_QUEUED_NUDGE";

  hostPre.spawn({
    sessionId: SID, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  hostPre.deliverHook(SID, { hook_event_name: "SessionStart" });
  hostPre.enqueueStdin(SID, TEXT); // idle immediate-submit; engine never confirms → give-up
  // While TEXT's retries are still in flight (session busy), an ORDINARY entry queues BEHIND it — same
  // setup as pty-giveup-hold-until-confirmed.mjs scenario (2). Once the give-up fires, TEXT is unshifted
  // back to the FRONT of `pending` (requeueGiveUpOrigin), so the final order is [TEXT (held), PLAIN_TEXT].
  const rPlain = hostPre.enqueueStdin(SID, PLAIN_TEXT, "system", undefined, undefined, "agent");
  check("(setup) the plain entry queues behind TEXT's in-flight retries", rPlain.delivered === false);

  await waitUntil(() => busyLogPre[SID]?.at(-1) === false);
  check("(setup) the give-up requeued TEXT to the front, held, with PLAIN_TEXT now behind it",
    hostPre.getPendingEntries(SID).length === 2 && hostPre.getPendingEntries(SID)[0].text === TEXT && hostPre.getPendingEntries(SID)[1].text === PLAIN_TEXT);

  // ===================== (1) the persisted SHAPE: getPersistablePendingSnapshot's texts are unaffected, holds are additive ======
  const { texts: rawTexts, holds: rawHolds } = hostPre.getPersistablePendingSnapshot(SID);
  check("(1) getPersistablePendingSnapshot's texts are bare strings, unaffected by the fix — [TEXT, PLAIN_TEXT]",
    JSON.stringify(rawTexts) === JSON.stringify([TEXT, PLAIN_TEXT]));
  check("(1) getPersistablePendingSnapshot's holds key ONLY the still-held index (0) with a future deadline",
    typeof rawHolds[0] === "number" && rawHolds[0] > Date.now() && rawHolds[1] === undefined && Object.keys(rawHolds).length === 1);

  // Round-trip through the REAL on-disk intent file (not a hand-rolled JSON.stringify) — proves the
  // additive field actually persists and reads back byte-identical, the same file boot itself reads.
  const mgrId = `rgh-mgr-${sfx}`;
  restart.writeRestartIntent({
    reason: "deploy merged daemon code", managerSessionId: mgrId, requestedAt: now,
    resume: [{ sessionId: mgrId, role: "auditor", parentSessionId: null }, { sessionId: SID, role: "auditor", parentSessionId: null }],
    pending: { [SID]: rawTexts },
    pendingHolds: { [SID]: rawHolds },
  });
  const onDisk = restart.readRestartIntent();
  check("(1) on-disk `pending` round-trips as plain strings, byte-identical",
    JSON.stringify(onDisk.pending[SID]) === JSON.stringify([TEXT, PLAIN_TEXT]));
  check("(1) on-disk `pendingHolds` round-trips, same index/deadline",
    onDisk.pendingHolds[SID][0] === rawHolds[0] && onDisk.pendingHolds[SID][1] === undefined);
  restart.clearRestartIntent();

  try { hostPre.stop(SID, "hard"); } catch { /* ignore */ }

  // ===================== (2) OLD-DAEMON COMPATIBILITY: a pre-9e27f4d2 replay, ignorant of `pendingHolds`, ===
  // ===================== reading this SAME round-tripped intent must never crash or corrupt the text ========
  {
    const fakesOld = [];
    class OldReplayHost extends createSeamHost(PtyHost) { createPty(opts) { return decorateSilentFakePty(super.createPty(opts), fakesOld); } }
    const busyLogOld = {};
    const hostOld = new OldReplayHost({
      onEngineSessionId() {}, onBusy(id, busy) { (busyLogOld[id] ??= []).push(busy); },
      onContextStats() {}, onRateLimited() {}, onExit() {},
    });
    const OLD_SID = `rgh-old-${sfx}`;
    hostOld.spawn({
      sessionId: OLD_SID, cwd: tmpHome,
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    }); // NOT ready yet — mirrors a freshly re-spawned, not-yet-booted resumed pty
    // The exact pre-9e27f4d2 `replayPending` call shape: iterate `pending[id]` as plain strings, never
    // touch `pendingHolds` (an older binary doesn't know the field exists) — against the REAL on-disk
    // `onDisk.pending[SID]` captured above, not a re-typed literal.
    for (const text of onDisk.pending[SID]) hostOld.enqueueStdin(OLD_SID, text, "system", undefined, undefined, "agent");
    hostOld.deliverHook(OLD_SID, { hook_event_name: "SessionStart" }); // boot → markReady → drainPending
    check("(2) OLD-DAEMON COMPAT: no hold restored (unaware of pendingHolds) — drains on the first ready-drain",
      busyLogOld[OLD_SID]?.at(-1) === true);
    check("(2) OLD-DAEMON COMPAT: the full, UNCORRUPTED text was written — a duplicate, never a garbled loss",
      fakesOld[0].writes.join("").includes(TEXT) && !fakesOld[0].writes.join("").includes("[object Object]"));
    try { hostOld.stop(OLD_SID, "hard"); } catch { /* ignore */ }
  }

  // ===================== (3)+(4) THE FIX: through the REAL resumeFleetOnBoot replay path ===================
  const fakesPost = [];
  class PostHost extends createSeamHost(PtyHost) { createPty(opts) { return decorateSilentFakePty(super.createPty(opts), fakesPost); } }
  const busyLogPost = {};
  const hostPost = new PostHost({
    onEngineSessionId() {}, onBusy(id, busy) { (busyLogPost[id] ??= []).push(busy); },
    onContextStats() {}, onRateLimited() {}, onExit() {},
  });

  const db = new Db();
  const proj = `rgh-proj-${sfx}`, agent = `rgh-ag-${sfx}`;
  db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
  // role:"auditor" + busy:false at capture → resumeFleetOnBoot sends NO continuation nudge for this entry
  // (card b5664b5b Problem B) — keeps this test scoped to the pending-FIFO replay, not nudge/MCP timing.
  db.insertSession({ id: mgrId, projectId: proj, agentId: agent, engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "auditor", parentSessionId: null });
  db.insertSession({ id: SID, projectId: proj, agentId: agent, engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "auditor", parentSessionId: null });

  const sessions = new SessionService(db, hostPost, new OrchestrationControl());
  // Re-stamp the hold deadline to a fresh full window right before building the boot intent (code review:
  // the true snapshot's deadline was captured back in (1), and the DB setup above — a real SQLite open +
  // a few inserts — spends some of it; re-stamping models a REAL restart's short boot gap rather than
  // burning this test's own unrelated setup cost against a fixed budget). (1)'s own assertions already
  // exercised the true, un-restamped snapshot — only the fixture feeding (3)/(4) is re-stamped here.
  const intent = {
    reason: "deploy merged daemon code", managerSessionId: mgrId, requestedAt: now,
    resume: [
      { sessionId: mgrId, role: "auditor", parentSessionId: null, busy: false },
      { sessionId: SID, role: "auditor", parentSessionId: null, busy: false },
    ],
    pending: { [SID]: rawTexts },
    pendingHolds: { [SID]: { 0: Date.now() + HOLD_MS } },
  };

  hostPost.spawn({
    sessionId: SID, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  }); // NOT ready yet — mirrors a freshly re-spawned, not-yet-booted resumed pty (mgrId is deliberately
      // never spawned on hostPost: resumeFleetOnBoot's requester nudge no-ops harmlessly on a dead session)

  const result = sessions.resumeFleetOnBoot(intent, { resumeOne: () => true });
  await flush();
  check("(3) setup: both sessions resumed, none failed", result.resumed.length === 2 && result.failed.length === 0);
  check("(3) setup: the persisted FIFO replayed onto the resumed (not-yet-ready) session",
    hostPost.getPendingEntries(SID).length === 2 && hostPost.getPendingEntries(SID)[0].text === TEXT && hostPost.getPendingEntries(SID)[1].text === PLAIN_TEXT);

  // Boot the resumed pty (SessionStart → markReady → one drainPending pass).
  hostPost.deliverHook(SID, { hook_event_name: "SessionStart" });
  check("(3) THE FIX: the restored hold kept the give-up entry OUT of the first ready-drain — still queued",
    hostPost.getPendingEntries(SID).some((m) => m.text === TEXT));
  check("(3) THE FIX: the give-up entry was NOT written on this first drain (no immediate duplicate)",
    !fakesPost[0].writes.join("").includes(TEXT));
  // The ORDINARY (non-held) entry, sitting right behind it, DOES drain normally — the hold never stalls it.
  check("(3) the ordinary entry behind it drained normally, unaffected by the other's hold",
    fakesPost[0].writes.join("").includes(PLAIN_TEXT) && !hostPost.getPendingEntries(SID).some((m) => m.text === PLAIN_TEXT));
  // Confirm the ordinary entry's turn cleanly (this fake pty never emits output on its own, so left alone
  // this turn would ALSO eventually give up — irrelevant noise for what (4) is testing). A real
  // UserPromptSubmit+Stop settles busy back to false without disturbing TEXT's own still-pending hold
  // (giveUpConfirmQueue is empty — this ordinary turn never gave up, so purgeConfirmedGiveUpRequeue no-ops).
  hostPost.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });
  hostPost.deliverHook(SID, { hook_event_name: "Stop" });

  // ===================== (4) once the restored hold naturally expires, it STILL delivers (a delayed, ========
  // ===================== honest duplicate — never a silent loss). A real wall-clock sleep past the hold, ====
  // ===================== the safe (upper-bound) direction — never used as the discriminator above. =========
  await sleep(HOLD_MS + 200);
  hostPost.reconcile();
  check("(4) THE DELIVERY: past its restored hold, the entry is genuinely redrained (busy re-armed)",
    busyLogPost[SID]?.at(-1) === true);
  check("(4) THE DELIVERY: it was actually written — delivered, not silently lost",
    fakesPost[0].writes.join("").includes(TEXT));
  check("(4) pending is now empty — nothing left unresolved", hostPost.getPendingEntries(SID).length === 0);

  try { hostPost.stop(SID, "hard"); } catch { /* ignore */ }
  db.close();

  // ===================== (5) MALFORMED ENTRY: a corrupted/foreign-shape pending entry must be skipped ======
  // ===================== (logged), never crash `replayPending` and abort the WHOLE fleet resume ============
  // (code review: pre-fix, a `null` entry took the object branch and threw on `.text`; replayPending had
  // no try/catch, resumeFleetOnBoot itself is uncaught at the boot call site, and `clearRestartIntent()`
  // has already run by then — so the throw would abort resuming every LATER session with the intent file
  // already gone. This must degrade to "skip the one bad entry, keep going", never "abort the fleet".)
  {
    const fakesBad = [];
    class BadHost extends createSeamHost(PtyHost) { createPty(opts) { return decorateSilentFakePty(super.createPty(opts), fakesBad); } }
    const hostBad = new BadHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
    const dbBad = new Db();
    const projBad = `rgh-bad-proj-${sfx}`, agentBad = `rgh-bad-ag-${sfx}`;
    dbBad.insertProject({ id: projBad, name: projBad, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
    dbBad.insertAgent({ id: agentBad, projectId: projBad, name: "t", startupPrompt: "", position: 0 });
    const BAD_ID = `rgh-bad-sess-${sfx}`;
    dbBad.insertSession({ id: BAD_ID, projectId: projBad, agentId: agentBad, engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "auditor", parentSessionId: null });
    const sessionsBad = new SessionService(dbBad, hostBad, new OrchestrationControl());
    hostBad.spawn({
      sessionId: BAD_ID, cwd: tmpHome,
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    }); // not ready — every entry queues, so the two GOOD strings are directly inspectable afterward

    const badIntent = {
      reason: "deploy", managerSessionId: BAD_ID, requestedAt: now,
      resume: [{ sessionId: BAD_ID, role: "auditor", parentSessionId: null, busy: false }],
      pending: { [BAD_ID]: ["ok before the malformed entry", null, "ok after the malformed entry"] },
    };
    let threw = null;
    try { sessionsBad.resumeFleetOnBoot(badIntent, { resumeOne: () => true }); } catch (e) { threw = e; }
    check("(5) resumeFleetOnBoot did NOT throw on a malformed (null) pending entry", threw === null);
    // BAD_ID is also its own requester (the sole entry in `resume`), so its "code is live" nudge lands as
    // a THIRD, later entry — irrelevant to what this check is about; just confirm the two REPLAYED
    // entries landed in order, with nothing malformed/corrupted in between them.
    const badPending = hostBad.getPendingEntries(BAD_ID).map((m) => m.text);
    check("(5) the entry BEFORE the malformed one still replayed, in place", badPending[0] === "ok before the malformed entry");
    check("(5) the entry AFTER the malformed one landed RIGHT BEHIND it — the malformed one was skipped, not substituted with a corrupted placeholder",
      badPending[1] === "ok after the malformed entry");

    try { hostBad.stop(BAD_ID, "hard"); } catch { /* ignore */ }
    dbBad.close();
  }
} finally {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — getPersistablePendingSnapshot's `texts` half stays bare strings (an OLDER daemon reads `pending` exactly as it always has, no crash, no corrupted text — proven against a REAL round-tripped on-disk intent), its additive `holds` half carries a still-held entry's deadline from the SAME single-pass call, a restart-during-hold no longer bypasses the hold through the real resumeFleetOnBoot path, an unrelated queued entry behind it is never stalled, and once the restored hold naturally expires the entry still delivers — a delayed, honest duplicate, never a silent loss."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
