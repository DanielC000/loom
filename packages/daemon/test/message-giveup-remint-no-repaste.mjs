import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 844ca34e, manager scope addendum — "make sure the no-re-paste-after-first-give-up rule applies to
// ANY give-up'd delivery lineage, not only handleKickoffGiveUpExhausted's worker-kickoff path."
//
// WHY THIS FILE EXISTS: kickoff-giveup-remint-purge.mjs proves the fix against the KICKOFF give-up path
// (`handleKickoffGiveUpExhausted`). Neither that file nor give-up-exhausted-durable.mjs (which uses a
// contract-faithful PtyStub, never the real PtyHost `submit()`) proves anything about the OTHER give-up
// path — `handleGiveUpExhausted` (sessions/service.ts), used for every ORDINARY durable dispatch
// (worker_message/redirect, a Lead session_message, and — the manager's own live specimen, card 844ca34e's
// triage notes — a worker_report arriving at a manager). This file closes that gap: it drives a
// `messageWorker` dispatch (manager -> worker; mechanically identical to a worker -> manager report —
// `handleGiveUpExhausted` is role-agnostic) through a REAL give-up -> re-mint -> redelivery -> park chain
// against the REAL PtyHost + SessionService (the actual production call graph, not a stub), and asserts
// the re-mint's own first physical write is Enter-only — never a second body paste — exactly like
// kickoff-giveup-remint-purge.mjs proves for the kickoff path.
//
// WHY THE FIX ALREADY COVERS THIS, WITHOUT A SEPARATE CODE CHANGE: `Live.giveUpLineages` (pty/host.ts) is
// keyed purely on `QueuedMessage.logicalId`, checked at the ONE shared `submit()` decision point every
// write funnels through, regardless of which SessionService-level handler re-minted it.
// `handleGiveUpExhausted`'s own re-mint call (`this.enqueueDurableMessage(recipientId,
// framePossibleDuplicate(text, rootMsgId), { ..., rootMsgId, ... })`) goes through the SAME
// `enqueueDurableMessage` that already stamps `logicalId: rootMsgId` on every dispatch it makes (card
// 4a0af485) — the IDENTICAL mechanism the kickoff path's own re-mint relies on. So a lineage that gave up
// once via `handleGiveUpExhausted` is marked in `Live.giveUpLineages` by the SAME `requeueGiveUpOrigin`
// call site, under the SAME logicalId, and `submit()` can't tell which SessionService handler produced the
// write it's deciding on — this file is the PROOF that reasoning holds, not a new code path.
//
// This suite proves, via a fake pty that NEVER emits output:
//   (1) A `messageWorker` dispatch gives up once (requeued, Enter-only redelivery — unchanged, pre-existing
//       b9b8f8db behavior), then exhausts and RE-MINTS via `handleGiveUpExhausted` (not the kickoff path).
//       The re-mint — a BRAND-NEW QueuedMessage, exactly like a kickoff re-mint — drains Enter-only on its
//       own FIRST attempt: zero body bytes, zero backspaces. bodyCount(TEXT) stays at 1 throughout.
//   (2) The re-mint's own redelivery cycle is ALSO Enter-only, then exhausts a second time and PARKS
//       (chainDepth 1 >= GIVE_UP_REMINT_LIMIT) — exactly once, never a silent loop — and the sender
//       (the manager) gets exactly one `[loom:redelivery-parked]`-shaped durable notice.
//
// RUN: pnpm build (from packages/daemon) then `node test/message-giveup-remint-no-repaste.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpHome = path.join(os.tmpdir(), `loom-msg-remint-norepaste-${Date.now()}-${process.pid}`);
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
// Pinned explicitly (matches production's default of 1) — same posture as kickoff-giveup-remint-purge.mjs.
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
const proj = `mgrp-proj-${sfx}`, agent = `mgrp-ag-${sfx}`;
db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
const mkSession = (o) => db.insertSession({
  id: o.id, projectId: proj, agentId: agent, engineSessionId: `eng-${o.id}`, title: null, cwd: tmpHome,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: o.role ?? null, parentSessionId: o.parentSessionId ?? null, taskId: o.taskId ?? null,
  worktreePath: null, branch: null,
});

const sessions = new SessionService(db, host, new OrchestrationControl());

// No `startupPrompt` — `scheduleKickoffGuarantee` is never scheduled (pty/host.ts: `if (kickoff != null)`),
// so the session goes straight to idle/ready with no kickoff give-up chain to interfere with the test.
function spawnIdleReady(sessionId) {
  host.spawn({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
  return fakes[fakes.length - 1];
}

try {
  const mgr = `mgrp-mgr-${sfx}`, wkr = `mgrp-wkr-${sfx}`, taskId = `tk-mgrp-${sfx}`;
  mkSession({ id: mgr, role: "manager" });
  mkSession({ id: wkr, role: "worker", parentSessionId: mgr, taskId });
  const mgrFake = spawnIdleReady(mgr);
  const fake = spawnIdleReady(wkr);
  const TEXT = "NEVER_CONFIRMED_DIRECTIVE_MUST_NOT_RE_PASTE_ON_ITS_OWN_REMINT";
  const bodyCount = (text) => fake.writes.join("").split(text).length - 1;

  const r = sessions.messageWorker(mgr, wkr, TEXT);
  check("(1) setup: messageWorker delivered immediately (worker was idle)", r.delivered === true);
  await sharedWaitUntil(() => bodyCount(TEXT) >= 1, { timeoutMs: 10_000, intervalMs: 2 });
  check("(1) setup: exactly ONE physical body write so far", bodyCount(TEXT) === 1);

  // Cycle 1 gives up -> requeued (within budget, card b9b8f8db's Enter-only redelivery, unchanged).
  await sharedWaitUntil(() => busyLog[wkr]?.at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
  check("(1) cycle 1 gave up: requeued, not yet exhausted", host.getPendingEntries(wkr).length === 1);

  await sleep(HOLD_WAIT);
  const writesBeforeCycle2 = fake.writes.length;
  host.reconcile();
  await sharedWaitUntil(() => busyLog[wkr]?.at(-1) === true, { timeoutMs: 10_000, intervalMs: 2 });
  await sharedWaitUntil(() => fake.writes.length > writesBeforeCycle2, { timeoutMs: 10_000, intervalMs: 2 });
  check("(1) precondition: cycle 2 actually wrote something", fake.writes.length > writesBeforeCycle2);
  check("(1) cycle 2 wrote no NEW body chunk (Enter-only redelivery, card b9b8f8db)", bodyCount(TEXT) === 1);

  // Cycle 2 ALSO gives up -> EXHAUSTS -> handleGiveUpExhausted RE-MINTS (not the kickoff path).
  await sharedWaitUntil(() => busyLog[wkr]?.at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
  await sharedWaitUntil(() => host.getPendingEntries(wkr).length === 1, { timeoutMs: 10_000, intervalMs: 2 });
  const remint = host.getPendingEntries(wkr)[0];
  check("(1) THE RE-MINT is queued (held), carrying the possible-duplicate tag over the SAME directive",
    !!remint && remint.text.includes("[loom:possible-duplicate") && remint.text.includes(TEXT));

  // The re-mint drains UNPURGED (nothing confirms it) — THE PROOF: its own first physical write is
  // Enter-only, not a backspace+repaste, even though it is a BRAND-NEW QueuedMessage. Must wait out its
  // own hold first (giveUpHeldUntil) — an immediate reconcile() is a no-op against a still-held entry.
  await sleep(HOLD_WAIT);
  const writesBeforeRemintDrain = fake.writes.length;
  host.reconcile();
  await sharedWaitUntil(() => busyLog[wkr]?.at(-1) === true, { timeoutMs: 10_000, intervalMs: 2 });
  await sharedWaitUntil(() => fake.writes.length > writesBeforeRemintDrain, { timeoutMs: 10_000, intervalMs: 2 });
  check("(1) precondition: the re-mint actually wrote something", fake.writes.length > writesBeforeRemintDrain);
  const remintDrainBurst = fake.writes.slice(writesBeforeRemintDrain).join("");
  check("(1) THE FIX APPLIES TO handleGiveUpExhausted TOO: the re-mint's own FIRST attempt is Enter-only — "
    + "no body bytes at all, even though this is a brand-new QueuedMessage never physically written before",
    remintDrainBurst.length > 0 && !remintDrainBurst.includes(TEXT));
  check("(1) THE COUNT-BASED PROOF: the directive body was NEVER physically pasted a second time",
    bodyCount(TEXT) === 1);

  // The re-mint's own cycle also never confirms -> runs through its own one-requeue budget -> exhausts a
  // SECOND time -> PARKS (chainDepth 1 >= GIVE_UP_REMINT_LIMIT) -> notifies the sender (the manager).
  await sharedWaitUntil(() => busyLog[wkr]?.at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
  await sharedWaitUntil(() => host.getPendingEntries(wkr).length === 1, { timeoutMs: 10_000, intervalMs: 2 });
  await sleep(HOLD_WAIT);
  const writesBeforeSecondCycle = fake.writes.length;
  host.reconcile();
  await sharedWaitUntil(() => busyLog[wkr]?.at(-1) === true, { timeoutMs: 10_000, intervalMs: 2 });
  await sharedWaitUntil(() => fake.writes.length > writesBeforeSecondCycle, { timeoutMs: 10_000, intervalMs: 2 });
  check("(2) precondition: the re-mint's own 2nd cycle actually wrote something", fake.writes.length > writesBeforeSecondCycle);
  const secondCycleBurst = fake.writes.slice(writesBeforeSecondCycle).join("");
  check("(2) the re-mint's OWN redelivery (its 2nd cycle) is ALSO Enter-only, not a body write",
    secondCycleBurst.length > 0 && !secondCycleBurst.includes(TEXT));
  await sharedWaitUntil(() => busyLog[wkr]?.at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });

  const parkedEvents = db.listEventsForWorker(wkr)
    .filter((e) => e.kind === "session_message_gave_up" && e.detail?.outcome === "parked");
  check("(2) THE SECOND EXHAUSTION PARKS — exactly once, never a silent re-mint loop", parkedEvents.length === 1);
  const remintedEvents = db.listEventsForWorker(wkr)
    .filter((e) => e.kind === "session_message_gave_up" && e.detail?.outcome === "reminted");
  check("(2) sanity: exactly ONE re-mint happened total (chainDepth bound), never a THIRD", remintedEvents.length === 1);
  check("(2) sanity: the directive body was STILL never pasted a second time, even after the park",
    bodyCount(TEXT) === 1);

  // The park's own sender-facing notice (enqueueSystemNudge -> enqueueDurableMessage) goes to the manager,
  // which is IDLE — it delivers IMMEDIATELY (no session_message_queued record; that kind is only appended
  // on the HELD/!delivered branch, card 129efe74's own doc). Check the manager's OWN pty writes instead —
  // the physical proof the notice landed exactly once, not duplicated.
  await sharedWaitUntil(() => mgrFake.writes.join("").includes("[loom:redelivery-parked]"), { timeoutMs: 10_000, intervalMs: 2 });
  const parkNoticeCount = mgrFake.writes.join("").split("[loom:redelivery-parked]").length - 1;
  check("(2) the sender (manager) received exactly ONE [loom:redelivery-parked] notice for this chain",
    parkNoticeCount === 1);

  const totalBytesWritten = fake.writes.join("").length;
  check(`(2) BOUNDED TOTAL BYTES across the whole chain: ${totalBytesWritten} chars written, comfortably `
    + `under 4x the directive length (${TEXT.length * 4}) — no escalating backspace+repaste ever fired`,
    totalBytesWritten < TEXT.length * 4);

  try { host.stop(wkr, "hard"); } catch { /* ignore */ }
  try { host.stop(mgr, "hard"); } catch { /* ignore */ }
  db.close();
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 844ca34e's scope addendum: the fix is lineage-generic, not kickoff-specific. A "
    + "`messageWorker` directive (mechanically identical to a worker_report arriving at a manager — the "
    + "manager's own live specimen) that gives up, exhausts, and re-mints via `handleGiveUpExhausted` "
    + "(never `handleKickoffGiveUpExhausted`) is protected by the SAME `Live.giveUpLineages` mark, because "
    + "both handlers thread the re-mint through the SAME `logicalId`-preserving `enqueueDurableMessage` "
    + "call `submit()` keys its decision on. The re-mint's own first attempt is Enter-only, its own "
    + "redelivery is Enter-only, the second exhaustion PARKS exactly once with exactly one sender notice, "
    + "and the directive body is never physically re-pasted."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
