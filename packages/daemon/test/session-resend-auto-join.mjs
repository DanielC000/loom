// Regression test for card 4a0af485, Requirement A — "a manual resend after a give-up/PARKED notice must
// not be able to deliver a duplicate, and the protection must NOT depend on the caller knowing an id."
//
// SPECIMEN THIS GUARDS: worker 8c7c87ea (card 4a0af485's own trace) reported the same completed work FOUR
// TIMES because the engine's confirmation of an ORIGINAL write can arrive MINUTES late (232s measured) —
// well after Loom's own give-up/remint machinery gave up waiting and a manager, seeing the (previously
// false-negative) "could not be confirmed delivered" notice, sent a fresh copy of the same instruction.
//
// THE FIX (two parts, both exercised here):
//   (a) `PtyHost.hasAmbiguousMatch` + `enqueueDurableMessage`'s auto-join (sessions/service.ts): a fresh
//       dispatch whose CONTENT matches a still-ambiguous (given-up, not yet confirmed) prior dispatch to
//       the SAME recipient is joined to that dispatch's `logicalId` automatically — NO caller opt-in, NO
//       `resendOf` id required (manager directive: "defend at the resource, not the caller" — a manager
//       panicking after a scary notice will not go thread an id through).
//   (b) `purgeConfirmedGiveUpRequeue`'s CONTENT-MATCH branch: once the ORIGINAL write's late confirmation
//       arrives (proven here by feeding back the EXACT framed text as `hook.prompt`), EVERY still-queued
//       `live.pending` entry sharing that `logicalId` — the original's own lingering give-up requeue AND
//       the auto-joined resend — is purged as a confirmed duplicate, not just whichever happens to sit at
//       the front of the old FIFO-position queue.
//
// RED-FIRST PROOF, structural (not just outcome-based): the resend NEVER itself gives up (it is a single,
// freshly-held FIFO entry, never submitted before the purge fires), so it carries NO `giveUpGen` at any
// point — the OLD `purgeConfirmedGiveUpRequeue` fallback (scans `pending[i].giveUpGen === gen`) could
// structurally NEVER have found or purged it, regardless of what content it carried. Only the NEW
// `logicalId`-keyed content-match closes this — see (2) below, which asserts the resend is gone precisely
// BECAUSE of the shared logicalId, not despite the absence of a `giveUpGen` tag.
//
// POSITIVE CONTROL (3): a resend with genuinely DIFFERENT content must NOT auto-join and must NOT be
// purged by the original's late confirmation — proving the mechanism is content-scoped, not a blanket
// "purge anything queued for this recipient."
//
// RUN (no daemon needed): node test/session-resend-auto-join.mjs
//   Requires the daemon built first (reads ../dist/*.js): from packages/daemon, run `pnpm build`.
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

const tmpHome = path.join(os.tmpdir(), `loom-resend-autojoin-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const ENTER_DELAY = 20;
const VERIFY_TIMEOUT = 150;
const MAX_ATTEMPTS = 2;
const HOLD_MS = 5_000; // generous — this test resolves the ambiguity itself well before any hold expiry
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_GIVE_UP_HOLD_MS = String(HOLD_MS);
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "1";

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

const submitLog = [];
const realConsoleLog = console.log.bind(console);
const realConsoleError = console.error.bind(console);
console.log = (...args) => { if (typeof args[0] === "string" && (args[0].startsWith("[submit]") || args[0].startsWith("[give-up]"))) submitLog.push(args[0]); realConsoleLog(...args); };
console.error = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleError(...args); };

const fakes = [];
/** Every give-up this drives is a genuine drop (GIVE-UP RECOVERY) — the shared fixture's fake never
 *  emits output on its own. */
class SilentTestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    const fake = { ...base, write: (d) => { writes.push(d); }, writes };
    fakes.push(fake);
    return fake;
  }
}
const busyLog = {};
const host = new SilentTestPtyHost({
  onEngineSessionId() {}, onBusy(id, busy) { (busyLog[id] ??= []).push(busy); },
  onContextStats() {}, onRateLimited() {}, onExit() {},
});

const db = new Db();
const proj = `raj-proj-${sfx}`, agent = `raj-ag-${sfx}`;
db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
const mgrId = `raj-mgr-${sfx}`, wkrId = `raj-wkr-${sfx}`;
db.insertSession({ id: mgrId, projectId: proj, agentId: agent, engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", parentSessionId: null });
db.insertSession({ id: wkrId, projectId: proj, agentId: agent, engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId });

const sessions = new SessionService(db, host, new OrchestrationControl());

host.spawn({
  sessionId: wkrId, cwd: tmpHome,
  permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
  geometry: { cols: 120, rows: 40 }, sessionEnv: {},
});
host.deliverHook(wkrId, { hook_event_name: "SessionStart" });

const ORIGINAL_TEXT = "ORIGINAL_INSTRUCTION_MUST_NOT_DOUBLE_DELIVER";
const FRAMED_ORIGINAL = `[loom:from-manager]\n${ORIGINAL_TEXT}`;
const STOPGAP_TEXT = "UNRELATED_STOPGAP_KEEPS_WORKER_BUSY";
const UNRELATED_RESEND_TEXT = "COMPLETELY_DIFFERENT_FOLLOWUP_NOT_A_RESEND";

try {
  // ===== SETUP: the ORIGINAL directive is delivered idle-immediate (gen 1) and gives up (silent pty) =====
  const r1 = sessions.messageWorker(mgrId, wkrId, ORIGINAL_TEXT);
  check("(setup) ORIGINAL delivered immediately (worker was idle), busy armed", r1.delivered === true && busyLog[wkrId]?.at(-1) === true);
  await sharedWaitUntil(() => busyLog[wkrId]?.at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
  check("(setup) gen 1 genuinely gave up (RECOVERY, not SUPPRESSED)", submitLog.some((l) => l.includes(wkrId) && l.includes("GIVE-UP RECOVERY")));
  check("(setup) the ORIGINAL is requeued, held, sitting in pending", host.getPendingEntries(wkrId).some((m) => m.text === FRAMED_ORIGINAL));

  // ===== keep the worker BUSY with an unrelated turn (gen 2), confirmed normally so it never gives up — =====
  // ===== this is what makes the resend HOLD (queue) instead of ALSO taking the immediate-submit path =======
  host.enqueueStdin(wkrId, STOPGAP_TEXT, "system", undefined, undefined, "agent");
  check("(setup) the stopgap took the immediate path (gen 2), busy re-armed", busyLog[wkrId]?.at(-1) === true);
  host.deliverHook(wkrId, { hook_event_name: "UserPromptSubmit" }); // confirms gen 2 — no prompt field, so this must NOT disturb gen 1's tracked ambiguity
  check("(setup) gen 2 confirmed normally (no give-up, no prompt field) — busy stays true (turn still 'running')", busyLog[wkrId]?.at(-1) === true);

  // ===== (1) THE RESEND: the manager sends the SAME text again, with NO id at all — busy=true → HELD, and =====
  // ===== auto-joined to the ORIGINAL's still-ambiguous logicalId purely by content match ====================
  const rResend = sessions.messageWorker(mgrId, wkrId, ORIGINAL_TEXT);
  check("(1) the resend is HELD (worker busy) — sits in pending, not yet dispatched", rResend.delivered === false);
  check("(1) the auto-join fired (content-matched a still-ambiguous prior dispatch, no resendOf given)",
    submitLog.some((l) => l.includes("[give-up]") && l.includes("auto-matched still-ambiguous")));
  const pendingBeforeLateHook = host.getPendingEntries(wkrId);
  const matchingOriginalText = pendingBeforeLateHook.filter((m) => m.text === FRAMED_ORIGINAL);
  check("(1) BOTH the original's own lingering requeue AND the resend now sit in pending, same text",
    matchingOriginalText.length === 2);

  // ===== (2) THE LATE CONFIRMATION: feed back the engine's echo of the ORIGINAL write,
  // ===== proving it actually started — RED-FIRST: the resend carries NO giveUpGen (it never itself gave
  // ===== up), so the OLD FIFO-position purge (keyed on giveUpGen) could never have reached it structurally =====
  // Code Review follow-up (#7): read the REAL entries (getPendingEntries now surfaces `giveUpGen` — card
  // 4a0af485) instead of asserting a hardcoded literal that could never fail. One of the two matching
  // entries is gen 1's OWN requeue (tagged `giveUpGen: 1` by `requeueGiveUpOrigin`, its own real give-up);
  // the other is the resend, pushed by the PLAIN held branch, which never stamps `giveUpGen` at all.
  const originalsOwnRequeue = matchingOriginalText.find((m) => m.giveUpGen !== undefined);
  const resendEntry = matchingOriginalText.find((m) => m.giveUpGen === undefined);
  check("(1) exactly one of the two is gen 1's OWN requeue, genuinely tagged giveUpGen=1",
    !!originalsOwnRequeue && originalsOwnRequeue.giveUpGen === 1);
  check("(2) RED-FIRST PREMISE, asserted against the REAL entry: the RESEND itself carries NO giveUpGen — it never itself gave up, so the OLD FIFO-position purge (keyed on giveUpGen) could never have reached it structurally",
    !!resendEntry && resendEntry.giveUpGen === undefined);

  // CRITICAL FINDING (Code Reviewer, card 4a0af485): the resend was HELD (busy), so `enqueueDurableMessage`
  // persisted a `session_message_queued` row for it, unresolved, with NO matching `session_message_delivered`
  // yet — it was purged before ever being handed off. Confirm that row genuinely exists BEFORE the purge
  // (the RED-first premise for the durable-row assertion below — if this is empty, the next check would be
  // vacuous), then confirm the purge's `onDeliver` call resolves it.
  const unresolvedBeforePurge = db.listUnresolvedQueuedMessagesForWorker(wkrId);
  check("(setup) RED-FIRST: the resend's OWN durable row is genuinely UNRESOLVED before the purge (proves the next check isn't vacuous)",
    unresolvedBeforePurge.length > 0);

  host.deliverHook(wkrId, { hook_event_name: "UserPromptSubmit", prompt: FRAMED_ORIGINAL });
  check("(2) THE FIX: a CONTENT-MATCHED confirmation was logged for the original's logicalId",
    submitLog.some((l) => l.includes("CONFIRMED logicalId=") && l.includes("content-matched")));
  const pendingAfterLateHook = host.getPendingEntries(wkrId);
  check("(2) THE FIX: BOTH copies are purged — the resend (never `giveUpGen`-tagged) is gone precisely because it shares the ORIGINAL's logicalId",
    pendingAfterLateHook.filter((m) => m.text === FRAMED_ORIGINAL).length === 0);
  check("(2) the queue is genuinely EMPTY afterward (the stopgap already drained via its own immediate path and was never queued at all — nothing survives, nothing unexpected appears)",
    pendingAfterLateHook.length === 0);
  check("(2) CRITICAL FIX: the resend's durable row is now RESOLVED — onDeliver fired inside the purge, so the done-guard is never permanently wedged and boot/live-flip can never redrive this duplicate back",
    db.listUnresolvedQueuedMessagesForWorker(wkrId).length === 0);

  // The late/spurious UserPromptSubmit hook re-arms busy (this handler treats every UserPromptSubmit as
  // "a turn is now running", regardless of whether it's a genuinely new turn or a late confirmation of an
  // old one — an orthogonal, pre-existing quirk of the busy-gate, not something this card touches). End
  // this phantom turn cleanly before starting the next scenario from a real idle state.
  host.deliverHook(wkrId, { hook_event_name: "Stop" });
  await sharedWaitUntil(() => busyLog[wkrId]?.at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });

  // ===== (3) POSITIVE CONTROL: a genuinely DIFFERENT follow-up must NOT auto-join and must NOT be purged =====
  // ===== by an unrelated confirmation — the join is content-scoped, not "purge anything queued" ============
  {
    // Fresh gen 3: idle now (busy cleared after (2)'s purge left nothing to drain immediately — the FIFO is
    // empty), so this ALSO gives up (silent pty) to create a SECOND, independent ambiguity to test against.
    const r3 = sessions.messageWorker(mgrId, wkrId, "SECOND_UNRELATED_DIRECTIVE");
    check("(3) setup: a second, unrelated directive is delivered and given up on its own", r3.delivered === true);
    await sharedWaitUntil(() => busyLog[wkrId]?.at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
    const framedSecond = "[loom:from-manager]\nSECOND_UNRELATED_DIRECTIVE";
    check("(3) setup: it is requeued, ambiguous, sitting in pending", host.getPendingEntries(wkrId).some((m) => m.text === framedSecond));

    // Keep worker busy again so the control resend HOLDS instead of taking the immediate path.
    host.enqueueStdin(wkrId, STOPGAP_TEXT, "system", undefined, undefined, "agent");
    host.deliverHook(wkrId, { hook_event_name: "UserPromptSubmit" });

    submitLog.length = 0; // isolate this scenario's own log assertions
    const rControl = sessions.messageWorker(mgrId, wkrId, UNRELATED_RESEND_TEXT);
    check("(3) CONTROL: a genuinely different message does NOT auto-join (no content match)",
      !submitLog.some((l) => l.includes("auto-matched still-ambiguous")));
    check("(3) CONTROL: it is HELD (busy), sitting in pending as its own, self-rooted entry", rControl.delivered === false);

    // The SECOND directive's own late confirmation must purge ONLY its own duplicate, never the unrelated control text.
    host.deliverHook(wkrId, { hook_event_name: "UserPromptSubmit", prompt: framedSecond });
    const pendingAfterControl = host.getPendingEntries(wkrId);
    check("(3) CONTROL: the unrelated control message SURVIVES — content-scoped, not a blanket purge",
      pendingAfterControl.some((m) => m.text === `[loom:from-manager]\n${UNRELATED_RESEND_TEXT}`));
    check("(3) CONTROL: the SECOND directive's own duplicate (the requeued original) IS purged, exactly as (2) proved",
      !pendingAfterControl.some((m) => m.text === framedSecond));
  }

  try { host.stop(wkrId, "hard"); } catch { /* ignore */ }
  db.close();
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a manual resend with NO id is auto-joined to a still-ambiguous prior dispatch by content match alone (no resendOf required), and the original's late confirmation purges every queued duplicate sharing that logicalId — including a resend that never itself gave up and so carries no giveUpGen, which the OLD FIFO-position purge could never have reached. A genuinely different message is never touched (content-scoped, not a blanket purge)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
