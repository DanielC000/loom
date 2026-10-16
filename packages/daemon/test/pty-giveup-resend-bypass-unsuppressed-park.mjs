// Regression test for card 844ca34e round 3 (CR round 2 finding, MAJOR) — a manual resend that auto-joins
// an ALREADY-PARKED root must get a FAIR, unblocked first attempt at writing (bypassing the marked-lineage
// ownership gate for THIS write only), and its OWN later park must never be silently suppressed as a moot
// "duplicate-parked" of the chain's earlier park.
//
// BACKGROUND (round 2's own known, documented residual — see docs/decisions/
// 844ca34e-giveup-lineages-block-further-repaste.md "KNOWN, DOCUMENTED RESIDUAL"): a manual resend after a
// `[loom:redelivery-parked]` notice auto-joins the OLD chain's logicalId (`hasAmbiguousMatch`, card
// 4a0af485) — correct, and load-bearing for the late-confirm purge (pty-giveup-coalesced-membersig-
// resend.mjs scenario 5). But inheriting that OLD logicalId also means inheriting its `giveUpLineages`
// mark. If, by the time the resend arrives, a DIFFERENT lineage ("owner B") physically owns the composer
// (round 2's own `composerOwnerLineage` ownership gate), the resend's OWN write would be silently blocked
// by `giveUpWithoutWriting` — never even attempting to land — and if it later parks too, that park used to
// be suppressed as "duplicate-parked" of the root's EARLIER park (CR round 2, MAJOR finding).
//
// THE FIX: `QueuedMessage.bypassOwnershipGateOnce` (set exactly once, at dispatch, only for a dispatch that
// itself auto-joined via `hasAmbiguousMatch` — sessions/service.ts's `isAutoJoinedResend`) lets THIS write
// skip the ownership-mismatch check and take the ordinary full clear+repaste branch instead, same as a
// fresh lineage's own first attempt. And `handleGiveUpExhausted`'s own PARKED branch now overrides
// `suppressMootParkNotice`'s "duplicate-parked" verdict for that SAME dispatch's chain — a second failure
// after a deliberate resend is genuinely new information, not a repeat of the first.
//
// Two scenarios:
//   (1) THE HAPPY PATH: park A -> owner B takes the composer -> resend A's text -> the bypass lets it
//       write A's body cleanly on top of B's dirty composer (never blocked) -> a genuine confirming hook
//       lands it decisively (no further give-up).
//   (2) THE FORCED 2ND FAILURE: same setup, but the resend is NEVER confirmed — it is driven through its
//       own give-up/re-mint/park cycle. Assert its OWN park produces a SECOND, independent
//       `[loom:redelivery-parked]` notice to the manager — not suppressed as "duplicate-parked" of A's
//       earlier park (the CR round 2 MAJOR bug this card fixes).
//
// NOTE on LOOM_GIVE_UP_REQUEUE_LIMIT: `GIVE_UP_REQUEUE_LIMIT = Number(env) || 1` (pty/host.ts) silently
// falls back to 1 for `"0"` (same documented trap as `LOOM_GIVE_UP_REMINT_LIMIT`, see ccb407eb's record) —
// so this file uses the production default (1), which needs TWO give-up cycles per message object (first
// KEPT/requeued, second EXHAUSTED) to reach `onGiveUpExhausted`, and a manual `host.reconcile()` redrain
// between them once each requeued entry's short HOLD_MS expires.
//
// RUN (daemon must be built first — reads ../dist/*.js): from packages/daemon,
//   pnpm build && node test/pty-giveup-resend-bypass-unsuppressed-park.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpHome = path.join(os.tmpdir(), `loom-resend-bypass-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const ENTER_DELAY = 20;
const VERIFY_TIMEOUT = 150;
const MAX_ATTEMPTS = 2;
const HOLD_MS = 10;
const HOLD_WAIT = HOLD_MS + 20;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_GIVE_UP_HOLD_MS = String(HOLD_MS);
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "1"; // production default — see the NOTE above for why not "0"
process.env.LOOM_GIVE_UP_REMINT_LIMIT = "1";

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const now = new Date().toISOString();

const submitLog = [];
const realConsoleLog = console.log.bind(console);
const realConsoleWarn = console.warn.bind(console);
const realConsoleError = console.error.bind(console);
const captureIfRelevant = (args) => { if (typeof args[0] === "string" && (args[0].startsWith("[submit]") || args[0].startsWith("[give-up]"))) submitLog.push(args[0]); };
console.log = (...args) => { captureIfRelevant(args); realConsoleLog(...args); };
console.warn = (...args) => { captureIfRelevant(args); realConsoleWarn(...args); };
console.error = (...args) => { captureIfRelevant(args); realConsoleError(...args); };

const fakes = {};
class RecordingTestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    const fake = Object.assign(base, { write: (d) => { writes.push(d); }, writes });
    fakes[opts.sessionId] = fake;
    return fake;
  }
}

function makeRig() {
  const busyLog = {};
  const host = new RecordingTestPtyHost({
    onEngineSessionId() {}, onBusy(id, busy) { (busyLog[id] ??= []).push(busy); },
    onContextStats() {}, onRateLimited() {}, onExit() {},
  });
  const db = new Db();
  const px = `rbup-${Math.random().toString(36).slice(2, 7)}`;
  const proj = `${px}-proj`, agent = `${px}-ag`;
  db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
  const mgrId = `${px}-mgr`, wkrId = `${px}-wkr`;
  db.insertSession({ id: mgrId, projectId: proj, agentId: agent, engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", parentSessionId: null });
  db.insertSession({ id: wkrId, projectId: proj, agentId: agent, engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId });
  const sessions = new SessionService(db, host, new OrchestrationControl());
  host.spawn({
    sessionId: wkrId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(wkrId, { hook_event_name: "SessionStart" });
  return { host, db, sessions, mgrId, wkrId, busyLog };
}

// The manager is never spawned with a live pty in this rig (not needed — its own delivery mechanics
// are not what this file tests), so a notice destined for it never reaches `host.getPendingEntries` (that
// reflects `Live.pending`, which requires a `Live` object this recipient never gets). The DURABLE
// `session_message_gave_up` (`outcome:"parked"`) event IS the authoritative record either way (card
// 085d9422: the parked outcome is recorded EITHER way, independent of whether the notice itself was
// suppressed) — a NON-suppressed one (`!detail.noticeSuppressed`) is exactly "a notice was dispatched".
function notices(db, wkrId) {
  return db.listEventsForWorker(wkrId).filter((e) =>
    e.kind === "session_message_gave_up" && e.detail?.outcome === "parked" && !e.detail?.noticeSuppressed);
}

async function waitForBusyFalseAfter(busyLog, sid, sinceLen, label) {
  await sharedWaitUntil(() => busyLog[sid]?.length > sinceLen && busyLog[sid]?.at(-1) === false,
    { timeoutMs: 10_000, intervalMs: 2, label });
}

// Drives a FRESH dispatch (already delivered immediately, busy armed) all the way to PARKED. Each
// message OBJECT needs two give-ups to exhaust its own budget (KEPT, then EXHAUSTED) under
// LOOM_GIVE_UP_REQUEUE_LIMIT=1, and EVERY requeued/re-minted entry (including a re-mint's own very
// first submission) carries its own `giveUpHeldUntil` hold — ineligible for drain, even while the
// recipient is idle, until that hold expires (card 73d5c34a) — so a bounded redrain loop, not a fixed
// cycle count, is what actually reaches PARKED: cycle1 (KEPT) -> redrain -> cycle2 (EXHAUSTED, re-mint
// created+held) -> redrain -> re-mint cycle1 (KEPT) -> redrain -> re-mint cycle2 (EXHAUSTED, chainDepth 1
// not < REMINT_LIMIT=1 -> PARKED).
async function driveToParked(host, busyLog, wkrId, label) {
  let lenBefore = busyLog[wkrId]?.length ?? 0;
  await waitForBusyFalseAfter(busyLog, wkrId, lenBefore, `${label} cycle1`);
  for (let i = 0; i < 10 && !submitLog.some((l) => l.includes("PARKED after")); i++) {
    lenBefore = busyLog[wkrId].length;
    await sleep(HOLD_WAIT);
    host.reconcile();
    await sharedWaitUntil(
      () => submitLog.some((l) => l.includes("PARKED after"))
        || (busyLog[wkrId].length > lenBefore && busyLog[wkrId].at(-1) === false),
      { timeoutMs: 10_000, intervalMs: 2, label: `${label} redrain ${i}` },
    );
  }
  if (!submitLog.some((l) => l.includes("PARKED after"))) {
    throw new Error(`${label}: never reached PARKED within the bounded redrain loop`);
  }
}

try {
  // ============================== (1) THE HAPPY PATH: bypass lets the resend's body LAND ===============
  {
    const { host, db, sessions, mgrId, wkrId, busyLog } = makeRig();
    const TEXT_A = "ORIGINAL_MESSAGE_PARKED_THEN_RESENT_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const TEXT_B = "UNRELATED_OWNER_B_TAKES_THE_COMPOSER_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    submitLog.length = 0;
    const rA = sessions.messageWorker(mgrId, wkrId, TEXT_A);
    check("(1) setup: A delivered immediately, busy armed", rA.delivered === true && busyLog[wkrId]?.at(-1) === true);
    await driveToParked(host, busyLog, wkrId, "(1) A");
    check("(1) setup: A reached PARKED", submitLog.some((l) => l.includes("PARKED after")));
    check("(1) setup: A's park produced exactly ONE notice to the manager (first-ever park, never moot)",
      notices(db, wkrId).length === 1);

    // Owner B: a genuinely different, fresh lineage writes and gives up too (same chained PARKED cycle),
    // which leaves `composerOwnerLineage` pointed at B's own logicalId and the composer genuinely dirty
    // (never confirmed) — the exact precondition CR round 2's MAJOR finding needs.
    submitLog.length = 0;
    const rB = sessions.messageWorker(mgrId, wkrId, TEXT_B);
    check("(1) setup: B delivered immediately (worker was idle)", rB.delivered === true);
    await driveToParked(host, busyLog, wkrId, "(1) B");
    check("(1) setup: B ALSO reached PARKED — composer is now dirty, owned by B, never confirmed",
      submitLog.some((l) => l.includes("PARKED after")));
    const liveAfterB = host.live.get(wkrId);
    check("(1) setup: composerOwnerLineage genuinely points at a lineage (B's), composer genuinely dirty",
      liveAfterB.composerOwnerLineage !== null && liveAfterB.composerOwnerLineage.size > 0
      && liveAfterB.composerDirtyLen > 0);

    // THE RESEND: a human/agent resends A's exact original text after seeing A's park notice. Worker is
    // idle (B's chain fully settled), so this submits immediately.
    submitLog.length = 0;
    const writesBefore = fakes[wkrId].writes.length;
    const rResend = sessions.messageWorker(mgrId, wkrId, TEXT_A);
    check("(1) THE FIX: the resend auto-joined A's still-ambiguous chain",
      submitLog.some((l) => l.includes("[give-up]") && l.includes("auto-matched still-ambiguous")));
    check("(1) THE FIX: the resend was NOT silently blocked — it is NOT the ownership-mismatch give-up "
      + "(absence of this log line proves bypassOwnershipGateOnce actually suppressed the gate)",
      !submitLog.some((l) => l.includes("GIVE-UP (composer ownership mismatch")));
    check("(1) THE FIX, THE CORE ASSERTION: the resend's body actually LANDED in the fake pty, cleanly, "
      + "despite A's marked lineage and B's prior ownership — this is the write round 2 alone would have "
      + "silently skipped",
      fakes[wkrId].writes.slice(writesBefore).join("").includes(TEXT_A));
    check("(1) sanity: the resend's own write is now busy/pending a confirmation", rResend.delivered === true);

    // A genuine confirming hook lands it decisively — no further give-up for this resend. Reset the log
    // first: it still carries A's/B's own long-stale, already-exhausted generations' entries, which
    // `purgeConfirmedGiveUpRequeue`'s positional fallback may harmlessly narrate here too (card 73d5c34a —
    // "leaving generation N's requeued entry un-purged" is expected noise from THEIR unconfirmed history,
    // not a new give-up for the resend) — narrow to the genuine DECISION log lines only, not that noise.
    submitLog.length = 0;
    const live = host.live.get(wkrId);
    // No sleep needed: both hooks resolve synchronously within deliverHook's own call (
    // purgeConfirmedGiveUpRequeue runs directly inside the Stop case, same stack) — a fixed wait here
    // would guard a negative assertion unfalsifiably (fixed-wait-negative-guard.mjs correctly flags
    // exactly this shape); anchoring to the synchronous hook delivery itself is the real observable event.
    host.deliverHook(wkrId, { hook_event_name: "UserPromptSubmit", prompt: live.lastPrompt });
    host.deliverHook(wkrId, { hook_event_name: "Stop" });
    check("(1) THE RESEND CONFIRMS: a content-matched CONFIRMED resolution fired for it",
      submitLog.some((l) => l.includes("CONFIRMED logicalId=")));
    check("(1) THE RESEND CONFIRMS: no NEW give-up decision fired for it after the confirming hook",
      !submitLog.some((l) => l.includes("GIVE-UP RECOVERY after") || l.includes("GIVE-UP (composer ownership mismatch")));
    check("(1) sanity: composer is decisively clean after the confirm",
      host.live.get(wkrId).composerDirtyLen === 0);

    try { host.stop(wkrId, "hard"); } catch { /* ignore */ }
  }

  // ============================== (2) THE FORCED 2ND FAILURE: exactly one NEW, unsuppressed notice ======
  {
    const { host, db, sessions, mgrId, wkrId, busyLog } = makeRig();
    const TEXT_A = "ORIGINAL_MESSAGE_PARKED_TWICE_OVER_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const TEXT_B = "UNRELATED_OWNER_B_AGAIN_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    submitLog.length = 0;
    const rA = sessions.messageWorker(mgrId, wkrId, TEXT_A);
    const rootA = rA.msgId; // a fresh, self-rooted dispatch: rootMsgId === msgId (no resendOf/rootMsgId supplied)
    await driveToParked(host, busyLog, wkrId, "(2) A");
    check("(2) setup: A's FIRST park produced exactly one notice for A's own root",
      notices(db, wkrId).filter((e) => e.detail?.rootMsgId === rootA).length === 1);

    submitLog.length = 0;
    sessions.messageWorker(mgrId, wkrId, TEXT_B);
    await driveToParked(host, busyLog, wkrId, "(2) B");

    // THE RESEND — auto-joins, bypasses, WRITES (same mechanism proven in (1)) — but this time NO
    // confirming hook ever arrives: let it run its own give-up/re-mint/park cycle to completion.
    submitLog.length = 0;
    const writesBefore = fakes[wkrId].writes.length;
    sessions.messageWorker(mgrId, wkrId, TEXT_A);
    check("(2) setup: the resend auto-joined and bypassed (its body landed immediately, same as scenario (1))",
      submitLog.some((l) => l.includes("[give-up]") && l.includes("auto-matched still-ambiguous"))
      && fakes[wkrId].writes.slice(writesBefore).join("").includes(TEXT_A));

    await driveToParked(host, busyLog, wkrId, "(2) resend");
    // Scoped to A's own root specifically — B is a genuinely different, unrelated lineage whose OWN park
    // ALSO (correctly) produces its own unsuppressed notice, which must not be mistaken for a 3rd notice
    // on A's chain here.
    check("(2) THE FIX, THE ASSERTION THAT GOES RED WITHOUT IT: the resend's OWN eventual park is NOT "
      + "suppressed as a moot 'duplicate-parked' of A's earlier park — it produced its OWN SECOND, "
      + "independent notice on A's root (2 total: A's original + the resend's own)",
      notices(db, wkrId).filter((e) => e.detail?.rootMsgId === rootA).length === 2);
    check("(2) sanity: the suppression log line was never used for this park (it would have fired at "
      + "exactly this log site before the fix)",
      !submitLog.some((l) => l.includes("SUPPRESSED as moot (duplicate-parked)")));

    // @decision 844ca34e (round 4, MAJOR) — THE WRITE-COUNTER ASSERTION THAT GOES RED ON a5f791b9: the
    // bypass must be a true ONE-SHOT. Pre-fix, `bypassOwnershipGateOnce` survived both the in-session
    // requeue (`requeueGiveUpOrigin`'s `...m` spread) AND the re-mint (carried via `isAutoJoinedResend`),
    // so the resend's OWN later give-up cycles kept skipping Enter-only and re-pasting the full body —
    // measured on a5f791b9: written 4x, with 1426 backspace bytes, across this exact chain shape.
    const resendBodyWrites = fakes[wkrId].writes.slice(writesBefore).join("").split(TEXT_A).length - 1;
    check("(2) THE FIX (round 4): the resend's body was written to the fake pty EXACTLY ONCE across its "
      + "ENTIRE chain (own give-up, re-mint, re-mint's own give-up, PARK) — never a repeated backspace+"
      + "repaste on a retry the bypass should only ever have covered once",
      resendBodyWrites === 1);

    try { host.stop(wkrId, "hard"); } catch { /* ignore */ }
  }

  // ============================== (3) NO BYPASS WHILE THE ORIGINAL IS MERELY REQUEUED, NOT PARKED ======
  // Ruling (d): "an auto-joined resend onto a PARKED root" — a fresh identical dispatch arriving while
  // the original chain is still just requeued/in-flight (never parked) must get NO bypass at all.
  {
    const { host, db, sessions, mgrId, wkrId, busyLog } = makeRig();
    const TEXT_A = "ORIGINAL_MESSAGE_STILL_REQUEUED_NEVER_PARKED_AAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    submitLog.length = 0;
    const rA = sessions.messageWorker(mgrId, wkrId, TEXT_A);
    const rootA = rA.msgId;
    let lenBefore = busyLog[wkrId]?.length ?? 0;
    await waitForBusyFalseAfter(busyLog, wkrId, lenBefore, "(3) A cycle1");
    check("(3) setup: A gave up ONCE — requeued (kept), NOT exhausted/re-minted/parked",
      host.getPendingEntries(wkrId).length === 1
      && !submitLog.some((l) => l.includes("PARKED after") || l.includes("re-minted as")));
    check("(3) setup: A's chain has genuinely never parked", !notices(db, wkrId).some((e) => e.detail?.rootMsgId === rootA));
    // Pin A's own requeued entry held indefinitely: A's real HOLD_MS (10ms) would otherwise long since
    // have expired by the time the resend below is dispatched (console/check overhead alone takes well
    // over 10ms), making A — now UN-held and still FIFO-front — eligible for the resend's OWN enqueue
    // call to drain INSTEAD of the resend itself, which would test A's stale redelivery's own ownership
    // decision, not the resend's. Decoupling this from wall-clock timing entirely.
    host.live.get(wkrId).pending[0].giveUpHeldUntil = Date.now() + 10_000_000;

    // Owner B: directly simulate a DIFFERENT lineage physically owning the composer, rather than running
    // a real second dispatch through its own give-up/re-mint/park cycle — a real B dispatch would race
    // A's own short (10ms) hold expiring mid-cycle, letting A's OWN chain keep progressing (and
    // eventually park) while this scenario is specifically trying to hold it at "merely requeued". This
    // is the same deterministic-state technique MINOR 5's own test (pty-giveup-round3-minors.mjs) uses.
    const liveNow = host.live.get(wkrId);
    liveNow.composerOwnerLineage = new Set(["unrelated-lineage-never-A"]);
    check("(3) setup: composerOwnerLineage points at an unrelated lineage, not A — the exact mismatch precondition",
      liveNow.composerOwnerLineage !== null && !liveNow.composerOwnerLineage.has(rootA)
      && liveNow.composerDirtyLen > 0);

    // THE RESEND: A's still-ambiguous signature auto-joins (A gave up once, so it IS in
    // ambiguousDispatches — matching is content-based, independent of parked state), but A's root has
    // NEVER parked — the bypass must NOT fire, and this write must hit the ordinary ownership-mismatch
    // path exactly like round 2's own Shape 1 (ownership mismatch, no bypass available at all).
    submitLog.length = 0;
    const writesBefore3 = fakes[wkrId].writes.length;
    sessions.messageWorker(mgrId, wkrId, TEXT_A);
    check("(3) the resend STILL auto-joined A's still-ambiguous chain (content match is unconditional)",
      submitLog.some((l) => l.includes("[give-up]") && l.includes("auto-matched still-ambiguous")));
    check("(3) THE FIX (round 4), THE ASSERTION THAT GOES RED WITHOUT IT: NO bypass — the resend hit the "
      + "ordinary ownership-mismatch path (no write at all), because A's root was merely requeued, never "
      + "PARKED, at the moment this resend arrived",
      submitLog.some((l) => l.includes("GIVE-UP (composer ownership mismatch")));
    check("(3) confirms: zero bytes written for this resend (blocked, not bypassed)",
      fakes[wkrId].writes.slice(writesBefore3).join("") === "");

    try { host.stop(wkrId, "hard"); } catch { /* ignore */ }
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 844ca34e round 3: an auto-joined resend onto an already-parked root bypasses the "
    + "marked-lineage ownership gate for its own write (lands cleanly even while a different lineage owns "
    + "the composer), and its own eventual park is never silently suppressed as a moot duplicate of the "
    + "chain's earlier park."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
