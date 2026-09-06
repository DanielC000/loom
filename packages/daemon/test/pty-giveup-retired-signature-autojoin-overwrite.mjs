// Regression test for card dbc7ffea's SECOND destructive path — `requeueGiveUpOrigin`'s own `.set()` can
// OVERWRITE a still-LIVE `ambiguousDispatches` entry when a manual resend gets auto-joined
// (`hasAmbiguousMatch`) onto an EXISTING still-ambiguous logicalId and itself later gives up. This is
// documented pre-existing behavior (`capAmbiguousDispatches`'s own doc, card a9e4240f) — a genuinely
// different, CROSS-MESSAGE trigger from `drainPending`'s own delete-at-redrain (the self-retry/exhaustion
// case `pty-giveup-exhausted-remint-purge-decline.mjs` / `pty-giveup-retired-signature-safety.mjs` drive),
// which the production specimen (96c6afb8) cannot reach on its own.
//
// Driven end to end via the REAL auto-join path (`SessionService.messageWorker` -> `enqueueDurableMessage`
// -> `hasAmbiguousMatch`), the same mechanism `pty-giveup-marked-resend-autojoin.mjs` already proves works
// — not a shortcut that hands a resend a `logicalId` directly.
//
// SEQUENCE:
//   1. A gives up ONCE (cycle 1) -> held, `ambiguousDispatches[A]` = its BARE signature, batchId=1.
//   2. A redrains for cycle 2 (`drainPending` archives cycle 1's bare signature — path (1), already
//      covered elsewhere) — cycle 2's OWN signature is the TAGGED (possible-duplicate-framed) text. Cycle 2
//      ALSO gives up; with `GIVE_UP_REQUEUE_LIMIT=2` this is KEPT, not exhausted, so A's TAGGED entry
//      (batchId=2) stays LIVE indefinitely — no cross-remint machinery involved, deliberately, to keep this
//      scenario isolated to the auto-join mechanism alone.
//   3. A manager resend of the PLAIN (untagged) original content arrives. `hasAmbiguousMatch` matches it
//      against A's CURRENT (tagged) entry via the tag-marked comparison — the resend auto-joins: its own
//      fresh message shares A's logicalId.
//   4. The resend's OWN (untagged) physical write also never confirms — `requeueGiveUpOrigin` runs for the
//      resend's own generation, with `origin` sharing A's logicalId. A's cycle-2 TAGGED entry is STILL LIVE
//      at this point (never redrained again) — this `.set()` is a genuine OVERWRITE of live data with a
//      GENUINELY DIFFERENT signature (tagged vs untagged), not merely a fresh create or a batchId-only
//      change.
//   5. THE FIX under test: this overwrite must archive the TAGGED entry (batchId=2) before replacing it —
//      so a late engine confirmation of A's OWN cycle-2 physical write can still purge the resend's own
//      held duplicate (sharing A's logicalId) instead of leaving it to drain as a genuine THIRD physical
//      write.
//
// RUN: `pnpm build` (from packages/daemon) then `node test/pty-giveup-retired-signature-autojoin-overwrite.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil, sleepPast } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-giveup-autojoin-overwrite-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = "20";
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = "150";
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = "2";
const HOLD_MS = 200;
process.env.LOOM_GIVE_UP_HOLD_MS = String(HOLD_MS);
// GIVE_UP_REQUEUE_LIMIT=2 (not the default 1) is deliberate here — this scenario needs A's cycle 2 to be
// KEPT, not exhausted, so its TAGGED entry stays LIVE for the resend's own give-up to genuinely overwrite.
// Exhaustion is exactly the OTHER file's own scenario (drainPending's path); this file isolates path (2).
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "2";

const { PtyHost, framePossibleDuplicate } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const submitLog = [];
const realConsoleLog = console.log.bind(console);
const realConsoleError = console.error.bind(console);
const realConsoleWarn = console.warn.bind(console);
const captureIfRelevant = (args) => { if (typeof args[0] === "string" && (args[0].startsWith("[submit]") || args[0].startsWith("[give-up]"))) submitLog.push(args[0]); };
console.log = (...args) => { captureIfRelevant(args); realConsoleLog(...args); };
console.error = (...args) => { captureIfRelevant(args); realConsoleError(...args); };
console.warn = (...args) => { captureIfRelevant(args); realConsoleWarn(...args); };

class SilentTestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    return Object.assign(base, { write: (d) => { writes.push(d); }, writes });
  }
}
const busyLog = {};
const host = new SilentTestPtyHost({
  onEngineSessionId() {}, onBusy(id, busy) { (busyLog[id] ??= []).push(busy); },
  onContextStats() {}, onRateLimited() {}, onExit() {},
});

const db = new Db();
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const proj = `giveup-autojoin-ow-proj-${sfx}`, agent = `giveup-autojoin-ow-ag-${sfx}`;
db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
const mgrId = `giveup-autojoin-ow-mgr-${sfx}`, wkrId = `giveup-autojoin-ow-wkr-${sfx}`;
db.insertSession({ id: mgrId, projectId: proj, agentId: agent, engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", parentSessionId: null });
db.insertSession({ id: wkrId, projectId: proj, agentId: agent, engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId });

const sessions = new SessionService(db, host, new OrchestrationControl());

host.spawn({ sessionId: wkrId, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
host.deliverHook(wkrId, { hook_event_name: "SessionStart" });

const TEXT = "AUTOJOIN_OVERWRITE_TARGET_MESSAGE";
const FRAMED = `[loom:from-manager]\n${TEXT}`;

try {
  // ===== A: cycle 1 (give up, held) then redrain into cycle 2 (TAGGED, KEPT — not exhausted) ==============
  const rA = sessions.messageWorker(mgrId, wkrId, TEXT);
  check("(setup) A delivered immediately, busy armed", rA.delivered === true && busyLog[wkrId]?.at(-1) === true);
  await sharedWaitUntil(() => busyLog[wkrId]?.at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
  const aEntries1 = host.getPendingEntries(wkrId);
  check("(setup) A's cycle 1 gave up, requeued, held", aEntries1.length === 1 && aEntries1[0].text === FRAMED);

  await sleepPast(HOLD_MS + 150, HOLD_MS, "past GIVE_UP_HOLD_MS (A's cycle 1 hold)");
  host.reconcile(); // redrains A for cycle 2 — drainPending archives A's cycle-1 bare signature (path 1)
  await sharedWaitUntil(() => busyLog[wkrId]?.at(-1) === true, { timeoutMs: 10_000, intervalMs: 2 });
  await sharedWaitUntil(() => busyLog[wkrId]?.at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
  const aEntries2 = host.getPendingEntries(wkrId);
  check("(setup) A's cycle 2 ALSO gave up and is KEPT (limit=2, not exhausted) — A's TAGGED entry stays LIVE",
    aEntries2.length === 1 && aEntries2[0].giveUpGen !== undefined);

  // ===== the resend: PLAIN (untagged) content, auto-joined via hasAmbiguousMatch onto A's LIVE tagged =====
  // ===== entry (the SAME mechanism pty-giveup-marked-resend-autojoin.mjs already proves) ===================
  submitLog.length = 0;
  const rResend = sessions.messageWorker(mgrId, wkrId, TEXT);
  const autoJoinLine = submitLog.find((l) => l.includes("[give-up]") && l.includes("auto-matched still-ambiguous"));
  check("(setup) the resend auto-joined A's still-live (tagged) chain", typeof autoJoinLine === "string");
  check("(setup) the resend was delivered immediately (worker was idle after A's cycle-2 give-up)",
    rResend.delivered === true && busyLog[wkrId]?.at(-1) === true);
  // `getPendingEntries` deliberately strips `logicalId` (UI-facing projection) — recover the ACTUAL resolved
  // value from the auto-join log line itself (`enqueueDurableMessage`'s own `[give-up] ... logicalId=<id>`),
  // rather than assuming it (this IS A's own logicalId, since that's what "auto-joined" means, but the log
  // line is the ground truth, not an inference).
  const A_LOGICAL_ID = autoJoinLine?.match(/logicalId=([^\s—-]+)/)?.[1];
  check("(setup) A's (shared, auto-joined) logicalId was recovered from the log", typeof A_LOGICAL_ID === "string" && A_LOGICAL_ID.length > 0);
  // The TAGGED text cycle 2's OWN signature reflects — reconstructed the SAME way `annotatedMessageText`
  // does for a single-member, giveUpGen-tagged origin (mirrors pty-giveup-exhausted-remint-purge-decline.mjs's
  // own helper).
  const A_CYCLE2_TAGGED_TEXT = framePossibleDuplicate(FRAMED, A_LOGICAL_ID);

  // ===== THE OVERWRITE: the resend's OWN (untagged) write also never confirms — requeueGiveUpOrigin =====
  // ===== overwrites A's still-live TAGGED entry with the resend's own (untagged, batchId-distinct) one ====
  await sharedWaitUntil(() => busyLog[wkrId]?.at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
  // `QueuedMessage.text` is NEVER mutated by requeueGiveUpOrigin's kept branch (only bookkeeping fields
  // are) — the TAG exists only in the SIGNATURE computed at give-up time, never in the stored `.text`. So
  // both A's own kept cycle-2 copy AND the resend's own kept copy carry the SAME pristine `FRAMED` text;
  // `getPendingEntries` also strips `logicalId` (see above), so there is no per-entry field left here to
  // tell them apart by identity — only their COUNT and that both have given up at least once.
  const afterOverwrite = host.getPendingEntries(wkrId);
  check("(setup) the resend ALSO gave up and is KEPT — pending now holds TWO give-up-tagged copies (A's own cycle-2 entry + the resend's own), both sharing the pristine FRAMED text",
    afterOverwrite.length === 2 && afterOverwrite.every((m) => m.text === FRAMED && m.giveUpGen !== undefined));

  // ===== THE FIX: a late hook reports A's own CYCLE-2 TAGGED text — the exact signature that was just =====
  // ===== overwritten (not archived, pre-fix) by the resend's own give-up. It must still content-match =====
  // ===== via the archive, and purge EVERY still-queued duplicate sharing that (shared, auto-joined) =========
  // ===== logicalId — both A's own tagged copy AND the resend's own plain copy are the SAME logical =========
  // ===== message by this point, so a genuine confirmation of ANY cycle resolves the WHOLE chain. ============
  submitLog.length = 0;
  host.deliverHook(wkrId, { hook_event_name: "UserPromptSubmit", prompt: A_CYCLE2_TAGGED_TEXT });
  check("(1) THE FIX: A's overwritten (now-archived) cycle-2 signature content-matches this late hook",
    submitLog.some((l) => l.includes("CONFIRMED logicalId=") && l.includes("content-matched")));
  check("(1) BOTH still-queued duplicates sharing the auto-joined logicalId were purged — nothing left to drain a THIRD physical write",
    host.getPendingEntries(wkrId).length === 0);

  try { host.stop(wkrId, "hard"); } catch { /* ignore */ }
  db.close();
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card dbc7ffea's archive-before-overwrite in requeueGiveUpOrigin genuinely covers the " +
    "auto-joined-resend path (card a9e4240f): a still-live entry overwritten by an auto-joined resend's " +
    "own give-up is archived first, so a late confirmation of the ORIGINAL (overwritten) write can still " +
    "purge a still-queued duplicate sharing that logicalId."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
