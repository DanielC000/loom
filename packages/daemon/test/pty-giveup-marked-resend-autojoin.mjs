// Regression test for card 78e4b3f2 — a manual PLAIN resend must still auto-join a still-ambiguous chain
// even once that chain's OWN stored signature reflects a possible-duplicate-TAGGED write, not the pristine
// original.
//
// WHY THIS IS A DISTINCT SCENARIO FROM session-resend-auto-join.mjs: that suite's resend is tested against
// a chain that has given up EXACTLY ONCE (its stored `Live.ambiguousDispatches` signature is still the
// PLAIN, un-tagged text — `requeueGiveUpOrigin` seeds it from `joinSubmittedText`, and `giveUpGen` is only
// assigned to the kept entry AFTER that signature is computed, so a single give-up's own seed is always
// unmarked). THIS suite drives the SAME logical message through a SECOND give-up — the physical write that
// second time IS marked (`giveUpGen` was already set going in), so the signature `requeueGiveUpOrigin`
// re-seeds from it is now the TAGGED text's signature. A human/agent reacting to a parked notice has no way
// to know about the internal tag (the notice's own head preview is deliberately tag-STRIPPED — see
// stripPossibleDuplicateFrame's own doc) — they resend the plain original content. Before this card's fix
// to `hasAmbiguousMatch`, that plain resend's signature would NOT match the stored (tagged) one, and the
// resend would self-root a disconnected new chain instead of joining — a real regression the marking
// feature would otherwise introduce into card 4a0af485's auto-join guarantee.
//
// RUN (no daemon needed): node test/pty-giveup-marked-resend-autojoin.mjs
//   Requires the daemon built first (reads ../dist/*.js): from packages/daemon, run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(predicate, timeoutMs = 10_000) {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitUntil: timed out after ${timeoutMs}ms`);
    await sleep(2);
  }
}

const tmpHome = path.join(os.tmpdir(), `loom-marked-resend-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const ENTER_DELAY = 20;
const VERIFY_TIMEOUT = 150;
const MAX_ATTEMPTS = 2;
const HOLD_MS = 10; // short — this suite WANTS the requeued entry to actually redrain (unlike session-resend-auto-join.mjs, which deliberately holds it forever)
const HOLD_WAIT = HOLD_MS + 20;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_GIVE_UP_HOLD_MS = String(HOLD_MS);
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "1";
process.env.LOOM_GIVE_UP_REMINT_LIMIT = "1";

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

const submitLog = [];
const realConsoleLog = console.log.bind(console);
const realConsoleWarn = console.warn.bind(console);
const captureIfRelevant = (args) => { if (typeof args[0] === "string" && (args[0].startsWith("[submit]") || args[0].startsWith("[give-up]"))) submitLog.push(args[0]); };
console.log = (...args) => { captureIfRelevant(args); realConsoleLog(...args); };
// The "re-minted as" line (handleGiveUpExhausted, sessions/service.ts) logs via console.warn, not
// console.log — must be intercepted too, or this suite's own log-based assertions silently see nothing.
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
const proj = `pmra-proj-${sfx}`, agent = `pmra-ag-${sfx}`;
db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
const mgrId = `pmra-mgr-${sfx}`, wkrId = `pmra-wkr-${sfx}`;
db.insertSession({ id: mgrId, projectId: proj, agentId: agent, engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", parentSessionId: null });
db.insertSession({ id: wkrId, projectId: proj, agentId: agent, engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId });

const sessions = new SessionService(db, host, new OrchestrationControl());

host.spawn({
  sessionId: wkrId, cwd: tmpHome,
  permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
  geometry: { cols: 120, rows: 40 }, sessionEnv: {},
});
host.deliverHook(wkrId, { hook_event_name: "SessionStart" });

const TEXT = "TWICE_GIVEN_UP_BEFORE_ANY_RESEND";
const FRAMED = `[loom:from-manager]\n${TEXT}`;
const STOPGAP_TEXT = "UNRELATED_STOPGAP_KEEPS_WORKER_BUSY";

try {
  // ===== SETUP: gen A — idle → immediate delivery → genuinely gives up (silent pty) → requeued/kept =====
  const rA = sessions.messageWorker(mgrId, wkrId, TEXT);
  check("(setup) gen A delivered immediately, busy armed", rA.delivered === true && busyLog[wkrId]?.at(-1) === true);
  await waitUntil(() => busyLog[wkrId]?.at(-1) === false);
  check("(setup) gen A requeued after its first give-up, NOT yet marked (its own seed predates giveUpGen)",
    host.getPendingEntries(wkrId).some((m) => m.text === FRAMED && m.giveUpGen !== undefined));

  // ===== gen B: reconcile redrains the once-requeued entry — THIS physical write IS the marked one — and =====
  // ===== it ALSO gives up, so requeueGiveUpOrigin re-seeds ambiguousDispatches from the MARKED text =========
  await sleep(HOLD_WAIT);
  host.reconcile();
  await waitUntil(() => busyLog[wkrId]?.at(-1) === true);
  await waitUntil(() => busyLog[wkrId]?.at(-1) === false);
  // Phrased as a pure PRESENCE check (never "not parked") — GIVE_UP_REMINT_LIMIT=1 means chainDepth 0 is
  // still below the limit, so this generation re-mints rather than parking; the assertion itself only
  // confirms the re-mint log line is present, so it reads correctly to fixed-wait-negative-guard.mjs too.
  check("(setup) gen A's SECOND give-up exhausted its in-session budget: RE-MINTED (chainDepth 0 sits below GIVE_UP_REMINT_LIMIT=1)",
    submitLog.some((l) => l.includes("re-minted as")));

  // Keep the worker busy with an unrelated turn so the resend below HOLDS (queues) instead of racing the
  // immediate-submit path — same technique session-resend-auto-join.mjs uses.
  host.enqueueStdin(wkrId, STOPGAP_TEXT, "system", undefined, undefined, "agent");
  host.deliverHook(wkrId, { hook_event_name: "UserPromptSubmit" });

  submitLog.length = 0; // isolate this scenario's own log assertion
  // ===== THE ACTUAL TEST: a human/agent types the PLAIN original content (exactly what a redelivery-parked =====
  // ===== notice's own tag-STRIPPED head preview would show) — no idea a possible-duplicate tag exists =========
  const rResend = sessions.messageWorker(mgrId, wkrId, TEXT);
  check("(1) THE FIX: a PLAIN (unmarked) manual resend STILL auto-joins a chain whose stored ambiguousDispatches signature is now the TAGGED text",
    submitLog.some((l) => l.includes("[give-up]") && l.includes("auto-matched still-ambiguous")));
  check("(1) the resend was HELD (worker busy), sitting in pending as its own entry", rResend.delivered === false);

  // POSITIVE CONTROL: without the hasAmbiguousMatch fix, a plain resend against a marked-signature chain
  // would NOT auto-join — confirm the auto-join log line is genuinely absent for a text that does NOT
  // content-match anything (proves the check above isn't vacuously true for every resend regardless of
  // content).
  submitLog.length = 0;
  sessions.messageWorker(mgrId, wkrId, "COMPLETELY_UNRELATED_TEXT_NO_MATCH_ANYWHERE");
  check("(2) POSITIVE CONTROL: a genuinely unrelated resend does NOT auto-join (the check above is not vacuous)",
    !submitLog.some((l) => l.includes("[give-up]") && l.includes("auto-matched still-ambiguous")));

  try { host.stop(wkrId, "hard"); } catch { /* ignore */ }
  db.close();
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 78e4b3f2's possible-duplicate marking does not regress card 4a0af485's manual-resend auto-join: a plain resend still content-matches a chain whose stored ambiguity signature has itself become the TAGGED text (because the chain redrained a second time before the resend arrived)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
