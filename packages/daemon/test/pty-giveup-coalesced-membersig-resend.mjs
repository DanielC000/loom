// Regression test for card ee56a894 — "give hasAmbiguousMatch a per-member signature so a manual resend
// still auto-joins after a coalesced give-up."
//
// FILED BY: taskless Code Reviewer ffa77a0c (Finding 4 of 5), evidence grade READ ONLY (a source trace,
// never executed — the reviewer said so explicitly). This suite closes that evidence gap FIRST (the RED
// half, section (1)) before any fix is trusted, per the card's own DoD-2.
//
// ROOT CAUSE: `Live.ambiguousDispatches` has TWO consumers with DIFFERENT signature shapes.
//   - `purgeConfirmedGiveUpRequeue` (host.ts, the engine-echo confirmation path) correctly matches the
//     JOINED text's signature — `requeueGiveUpOrigin` seeds every coalesced member with
//     `textSignature(joinSubmittedText(origin, gen-1))`, and that IS what the engine actually echoes back
//     for a coalesced turn. See pty-giveup-coalesced-content-match.mjs for that half's own regression
//     coverage; this suite does not re-prove it.
//   - `hasAmbiguousMatch` (host.ts, the manual-resend auto-join check called from
//     `enqueueDurableMessage`) matches a SINGLE message's own framed text — but pre-fix it is seeded from
//     the SAME joined signature, which only equals any one member's own text when the batch has exactly
//     one member. Before card 8d4f9a08 introduced same-sender AGENT coalescing, an agent-kind drain was
//     always one entry, so joined === single and this was invisible. Once a batch has 2+ members, a
//     manual resend of ONE member's own text can no longer match anything, and starts a DISCONNECTED
//     chain instead of auto-joining — losing the `[loom:possible-duplicate root:...]` framing that tells
//     the recipient "you may have seen this already."
//
// THE FIX (an ADD, not a swap — the card is explicit that the joined signature must survive untouched for
// the echo-confirmation consumer): `requeueGiveUpOrigin` now ALSO seeds each member's OWN individual
// signature (the exact text `annotatedMessageText` would write for THAT member alone, mirroring
// `joinSubmittedText`'s own per-member transform) alongside the existing joined one, and
// `hasAmbiguousMatch` tries a candidate resend against BOTH shapes.
//
// This suite proves, against a fake pty that never emits output (a genuine drop):
//   (1) RED-FIRST: exercising the DEFAULT same-sender agent-kind coalescing path (card 8d4f9a08's own
//       "65.8% of worker-report deliveries" path, not just the warning-kind/legacy-toggle routes already
//       covered elsewhere), a coalesced 2-member batch gives up, and `hasAmbiguousMatch` against EITHER
//       member's own text alone returns null pre-fix — reproducing the reviewer's finding for real,
//       against real give-up/verify-timeout machinery, not merely trusting the source trace.
//   (2) THE FIX: the same calls return a real (non-null) logicalId post-fix, and the two members resolve
//       to DIFFERENT logicalIds — proving per-member discrimination, not a blanket "anything matches now."
//   (3) CONTROL (unaffected consumer): the JOINED text — what the engine's real echo carries — still
//       matches, proving this is additive, not a swap that would break the echo-confirmation path.
//   (4) CONTROL (negative): genuinely unrelated text still matches nothing.
//   (5) END-TO-END: driven through the REAL production call path (`SessionService.messageWorker`, the
//       same call a manager uses to resend after a scary notice) — a resend of one coalesced member's own
//       text auto-joins (submitLog shows "auto-matched still-ambiguous"), and the original's own late
//       confirmation (the joined-text echo) purges BOTH the original's lingering requeue AND the
//       auto-joined resend — proving the join is functionally meaningful, not just logged.
//
// RUN (no daemon needed): node test/pty-giveup-coalesced-membersig-resend.mjs
//   Requires the daemon built first (reads ../dist/*.js): from packages/daemon, run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-giveup-membersig-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = "20";
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = "150";
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = "2";
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "1";
process.env.LOOM_GIVE_UP_HOLD_MS = "5000";

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
const realConsoleWarn = console.warn.bind(console);
console.log = (...args) => { if (typeof args[0] === "string" && (args[0].startsWith("[submit]") || args[0].startsWith("[give-up]"))) submitLog.push(args[0]); realConsoleLog(...args); };
console.error = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleError(...args); };
console.warn = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleWarn(...args); };

const fakes = [];
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
const proj = `gms-proj-${sfx}`, agent = `gms-ag-${sfx}`;
db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
const mgrId = `gms-mgr-${sfx}`, wkrId = `gms-wkr-${sfx}`;
db.insertSession({ id: mgrId, projectId: proj, agentId: agent, engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", parentSessionId: null });
db.insertSession({ id: wkrId, projectId: proj, agentId: agent, engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId });

const sessions = new SessionService(db, host, new OrchestrationControl());

const DRAIN_SEPARATOR = "\n\n────────\n\n"; // mirrors host.ts's own DRAIN_SEPARATOR literal
const TEXT_A = "COALESCED_MEMBER_A_MUST_STILL_AUTOJOIN";
const TEXT_B = "COALESCED_MEMBER_B_MUST_STILL_AUTOJOIN";
const FRAMED_A = `[loom:from-manager]\n${TEXT_A}`;
const FRAMED_B = `[loom:from-manager]\n${TEXT_B}`;
const JOINED_TEXT = FRAMED_A + DRAIN_SEPARATOR + FRAMED_B;
const STOPGAP_TEXT = "UNRELATED_STOPGAP_KEEPS_WORKER_BUSY";

try {
  host.spawn({
    sessionId: wkrId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(wkrId, { hook_event_name: "SessionStart" });

  // ===== SETUP: kickstart turn (gen 1), confirmed cleanly so it never itself gives up =====
  host.enqueueStdin(wkrId, "KICKSTART_TURN", "system", undefined, undefined, "agent");
  check("(setup) kickstart delivered immediately, busy armed", busyLog[wkrId]?.at(-1) === true);
  host.deliverHook(wkrId, { hook_event_name: "UserPromptSubmit", prompt: "KICKSTART_TURN" });
  check("(setup) kickstart confirmed cleanly (turn still running)", busyLog[wkrId]?.at(-1) === true);

  // ===== TWO SAME-SENDER agent-kind directives, from the SAME manager, queued while busy — this is the =====
  // ===== DEFAULT same-sender coalescing path (card 8d4f9a08), not warning-kind/legacy-toggle route-keyed ===
  const rA = sessions.messageWorker(mgrId, wkrId, TEXT_A);
  const rB = sessions.messageWorker(mgrId, wkrId, TEXT_B);
  check("(setup) both same-sender agent directives HELD (busy) — queued to coalesce", rA.delivered === false && rB.delivered === false);

  host.deliverHook(wkrId, { hook_event_name: "Stop" }); // ends kickstart, drains the coalesced pair as ONE turn
  check("(setup) the coalesced drain went out as ONE turn (busy re-armed)", busyLog[wkrId]?.at(-1) === true);
  const writtenSoFar = fakes.at(-1).writes.join("");
  check("(setup) the ACTUAL write contains the JOINED text (both members, separator included) — proves same-sender agent coalescing fired, not two separate turns", writtenSoFar.includes(JOINED_TEXT));

  // ===== let this coalesced generation give up (silent pty never confirms) =====
  await sharedWaitUntil(() => busyLog[wkrId]?.at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
  check("(setup) the coalesced generation genuinely gave up (RECOVERY)", submitLog.some((l) => l.includes("GIVE-UP RECOVERY")));
  const pendingAfterGiveUp = host.getPendingEntries(wkrId);
  check("(setup) BOTH coalesced members are requeued, sitting ambiguous",
    pendingAfterGiveUp.some((m) => m.text === FRAMED_A) && pendingAfterGiveUp.some((m) => m.text === FRAMED_B));

  // ===== (1) RED-FIRST + (2) THE FIX: hasAmbiguousMatch against EACH member's OWN text alone =====
  // Read-only, non-consuming (per its own doc) — safe to call repeatedly without disturbing state.
  const matchA = host.hasAmbiguousMatch(wkrId, FRAMED_A);
  const matchB = host.hasAmbiguousMatch(wkrId, FRAMED_B);
  check("(1)/(2) hasAmbiguousMatch(member A's own text) finds a real logicalId — pre-fix this returns null (only the JOINED text matched); this is the reviewer's finding, reproduced against real give-up machinery",
    matchA !== null);
  check("(1)/(2) hasAmbiguousMatch(member B's own text) finds a real logicalId, same reasoning",
    matchB !== null);
  check("(2) per-member discrimination: A and B resolve to DIFFERENT logicalIds (their own chains), not one blanket match",
    matchA !== null && matchB !== null && matchA !== matchB);

  // ===== (3) CONTROL: the JOINED text — what the engine's real echo actually carries — still matches, =====
  // ===== proving this is an ADD (both shapes now checked), never a swap that would break the =====
  // ===== engine-echo confirmation path (purgeConfirmedGiveUpRequeue, covered by its own suite) ===========
  const matchJoined = host.hasAmbiguousMatch(wkrId, JOINED_TEXT);
  check("(3) CONTROL: hasAmbiguousMatch(the full JOINED text) still matches — the pre-existing echo-shape signature is untouched",
    matchJoined !== null);

  // ===== (4) CONTROL: genuinely unrelated text must not match anything =====
  const matchUnrelated = host.hasAmbiguousMatch(wkrId, "[loom:from-manager]\nCOMPLETELY_UNRELATED_TEXT_NEVER_SENT");
  check("(4) CONTROL: hasAmbiguousMatch(unrelated text) finds nothing", matchUnrelated === null);

  // ===== (5) END-TO-END: the REAL production call path — a manager resending one coalesced member's own =====
  // ===== text, with no id, through SessionService.messageWorker (exactly what a manager does after a =====
  // ===== scary "could not be confirmed delivered" notice) =====
  host.enqueueStdin(wkrId, STOPGAP_TEXT, "system", undefined, undefined, "agent");
  check("(5 setup) stopgap took the immediate path, busy re-armed", busyLog[wkrId]?.at(-1) === true);
  host.deliverHook(wkrId, { hook_event_name: "UserPromptSubmit" }); // confirms the stopgap cleanly — busy stays true (turn running), gen 2's ambiguity undisturbed
  check("(5 setup) stopgap confirmed normally, busy stays true", busyLog[wkrId]?.at(-1) === true);

  submitLog.length = 0; // isolate this scenario's own log assertions
  const rResend = sessions.messageWorker(mgrId, wkrId, TEXT_A);
  check("(5) the resend is HELD (worker busy) — sits in pending, not yet dispatched", rResend.delivered === false);
  check("(5) THE FIX END-TO-END: the auto-join fired through the REAL production path (no resendOf given, content-matched against member A's own still-ambiguous text)",
    submitLog.some((l) => l.includes("[give-up]") && l.includes("auto-matched still-ambiguous")));

  // The original coalesced generation's own late confirmation (the JOINED text — what the engine actually
  // echoes for a coalesced turn) must now purge BOTH the original pair's requeue AND the auto-joined resend.
  host.deliverHook(wkrId, { hook_event_name: "UserPromptSubmit", prompt: JOINED_TEXT });
  const pendingAfterLateHook = host.getPendingEntries(wkrId);
  check("(5) THE FIX END-TO-END: the original's late confirmation purges EVERYTHING sharing its logicalId — member A's own requeue, member B's own requeue, AND the auto-joined resend (proving the join is functionally meaningful, not merely logged)",
    !pendingAfterLateHook.some((m) => m.text === FRAMED_A) && !pendingAfterLateHook.some((m) => m.text === FRAMED_B));

  try { host.stop(wkrId, "hard"); } catch { /* ignore */ }
  db.close();
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — hasAmbiguousMatch now carries a per-member signature alongside the existing joined one, so a manual resend of ONE coalesced member's own text auto-joins that member's still-ambiguous chain (proven both directly and through the real SessionService.messageWorker resend path), while the joined-text echo-confirmation shape the OTHER consumer depends on is untouched — an add, not a swap."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
