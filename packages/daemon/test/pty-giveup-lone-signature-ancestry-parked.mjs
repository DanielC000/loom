// Regression test for card 7a64f16b, aggravated PARKED sub-case — sibling to
// `pty-giveup-lone-signature-ancestry.mjs` (scenarios (a)/(b), the core fix). Split into its own file
// because reaching PARKED needs a SMALL `GIVE_UP_HOLD_MS` (bounded redrains, not a long real wait) — an
// env var read into a module-level constant once, at `../dist/pty/host.js`'s own import time, so it
// cannot coexist in one process with the sibling file's generous hold.
//
// THE SCENARIO: L1 is driven all the way to PARKED (its requeue+remint budget exhausted, a
// `[loom:redelivery-parked]` notice already sent to its manager). Reaching PARKED does NOT clear
// PtyHost's own `ambiguousDispatches`/`giveUpLineages` state for that logicalId (neither is touched by
// any PARKED-reaching code path — verified by reading every `ambiguousDispatches.delete`/
// `giveUpLineages.delete` call site in host.ts), so the sibling file's (a)-shaped collision is still
// reachable post-park: a totally separate, self-rooted, never-given-up dispatch whose own text happens to
// be byte-identical to L1's now-parked text. Without this card's content-ancestry fix,
// `sessions.handleGiveUpConfirmed` would fire off that unrelated confirmation and send a FALSE
// `[loom:redelivery-confirmed]` notice claiming the parked message "has now been CONFIRMED delivered" — a
// false all-clear to the manager about a message that was actually never resolved. Driven through a real
// `SessionService` + `Db` rig (not just raw PtyHost), reusing the same `makeRig`/`driveToParked` shape
// `pty-giveup-resend-bypass-unsuppressed-park.mjs` already proves works, since `handleGiveUpConfirmed` is
// a `sessions/service.ts` method, not PtyHost's own.
//
// RUN (daemon must be built first — reads ../dist/*.js): from packages/daemon,
//   pnpm build && node test/pty-giveup-lone-signature-ancestry-parked.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpHome = path.join(os.tmpdir(), `loom-7a64f16b-ancestry-parked-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const HOLD_MS = 10;
const HOLD_WAIT = HOLD_MS + 20;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = "20";
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = "150";
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = "2";
process.env.LOOM_GIVE_UP_HOLD_MS = String(HOLD_MS);
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "1"; // production default
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

class SilentTestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    return { ...base, write: (d) => { writes.push(d); }, writes };
  }
}

function makeRig() {
  const busyLog = {};
  const host = new SilentTestPtyHost({
    onEngineSessionId() {}, onBusy(id, busy) { (busyLog[id] ??= []).push(busy); }, onContextStats() {}, onRateLimited() {}, onExit() {},
  });
  const db = new Db();
  const px = `lsap-${Math.random().toString(36).slice(2, 7)}`;
  const proj = `${px}-proj`, agent = `${px}-ag`;
  db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
  const mgrId = `${px}-mgr`, wkrId = `${px}-wkr`;
  db.insertSession({ id: mgrId, projectId: proj, agentId: agent, engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", parentSessionId: null });
  db.insertSession({ id: wkrId, projectId: proj, agentId: agent, engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId });
  const sessions = new SessionService(db, host, new OrchestrationControl());
  host.spawn({ sessionId: wkrId, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  host.deliverHook(wkrId, { hook_event_name: "SessionStart" });
  return { host, db, sessions, mgrId, wkrId, busyLog };
}

async function waitForBusyFalseAfter(busyLog, sid, sinceLen, label) {
  await sharedWaitUntil(() => busyLog[sid]?.length > sinceLen && busyLog[sid]?.at(-1) === false,
    { timeoutMs: 10_000, intervalMs: 2, label });
}

// Same bounded-redrain shape as pty-giveup-resend-bypass-unsuppressed-park.mjs's own driveToParked.
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
  if (!submitLog.some((l) => l.includes("PARKED after"))) throw new Error(`${label}: never reached PARKED within the bounded redrain loop`);
}

try {
  const { host, db, sessions, mgrId, wkrId, busyLog } = makeRig();
  const COLLISION_TEXT = "ORIGINAL_PARKED_MESSAGE_THAT_A_COINCIDENCE_MUST_NOT_FALSELY_CONFIRM";

  submitLog.length = 0;
  const rL1 = sessions.messageWorker(mgrId, wkrId, COLLISION_TEXT);
  const l1LogicalId = rL1.msgId; // self-rooted: rootMsgId === msgId
  // `sessions.messageWorker` wraps the raw text before it ever reaches PtyHost (a sender tag, etc.) —
  // capture the ACTUAL text `submit()` wrote (synchronously set on the immediate-delivery path, before
  // this call returns), since that — not the raw `COLLISION_TEXT` string — is what gets archived as L1's
  // own (reproducible, un-annotated) FIRST-cycle signature. A later re-mint cycle's own signature bakes in
  // a live mint-time timestamp (`annotateMintStamp`) and can never be reproduced byte-for-byte here, but
  // this first-cycle signature survives, unresolved, in `retiredGiveUpSignatures` even after parking.
  const l1OriginalWrittenText = host.live.get(wkrId).lastPrompt;
  check("(c) setup: captured L1's actual written text", typeof l1OriginalWrittenText === "string" && l1OriginalWrittenText.length > 0);
  await driveToParked(host, busyLog, wkrId, "(c) L1");
  check("(c) setup: L1 reached PARKED", submitLog.some((l) => l.includes("PARKED after")));
  const parkEvents = () => db.listEventsForWorker(wkrId).filter((e) =>
    e.kind === "session_message_gave_up" && e.detail?.rootMsgId === l1LogicalId);
  check("(c) setup: exactly one PARKED event recorded for L1's root", parkEvents().filter((e) => e.detail?.outcome === "parked").length === 1);

  // G3: an entirely separate, self-rooted, never-given-up dispatch whose own text happens to be
  // byte-identical to L1's own original (now-parked, first-cycle) text — dispatched directly through
  // PtyHost (not through enqueueDurableMessage's hasAmbiguousMatch auto-join, which only ever consults the
  // CURRENT `ambiguousDispatches` slot, never `retiredGiveUpSignatures` — see that method's own doc) to
  // reproduce the exact DISJOINT-identity shape pty-giveup-lone-signature-ancestry.mjs's scenario (a)
  // already proves is otherwise mishandled.
  submitLog.length = 0;
  host.enqueueStdin(wkrId, l1OriginalWrittenText, "system", undefined, undefined, "agent");
  host.deliverHook(wkrId, { hook_event_name: "UserPromptSubmit", prompt: l1OriginalWrittenText });

  check("(c) THE FIX: a DECLINED content match log fired, naming L1's logicalId",
    submitLog.some((l) => l.includes("DECLINED content match") && l.includes(l1LogicalId)));
  check("(c) THE FIX: NO new 'confirmed-after-park' event was recorded for L1 — handleGiveUpConfirmed was never even invoked",
    !parkEvents().some((e) => e.detail?.outcome === "confirmed-after-park"));
  check("(c) THE FIX: still exactly ONE 'parked'-outcome event for L1 — no false all-clear appended "
    + "(parkEvents() also carries the earlier, unrelated 'reminted' event for this same root — filter by outcome, not length alone)",
    parkEvents().filter((e) => e.detail?.outcome === "parked").length === 1);

  try { host.stop(wkrId, "hard"); } catch { /* ignore */ }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 7a64f16b: the content-ancestry fix holds even after the stale lineage has "
    + "already been reported PARKED to its manager — no false '[loom:redelivery-confirmed]' all-clear."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
