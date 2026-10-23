import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
// Card ab3c965d — a MANAGER's turn-1 kickoff exhausting its give-up requeue budget used to hit
// `handleKickoffGiveUpExhausted`'s generic bail (sessions/service.ts) with only a `console.error` — no
// durable event, no notification anywhere, unlike a worker's own kickoff (bounded re-mint + park + a
// sender notice, card 7772176d). Investigated at source (project memory `5748425f-kickoff-remint-two-
// mechanisms`, decisions `a8f8a8f2`/`7772176d`): the documented reason managers are excluded is about the
// NOTIFY step lacking a natural recipient for a top-level session, never a finding that RE-MINT itself
// would duplicate for a manager — so this fix deliberately does NOT extend re-mint to managers, only the
// record/notify gap.
//
// THE FIX: a manager-role session is now carved out BEFORE the generic bail, into a dedicated
// `handleManagerKickoffDropped` — mirrors `handleClaudeBootDialogStuck`'s own parentless-manager
// resolution (card e2a3c613) exactly: a durable `manager_kickoff_dropped` event (parentNudged:false,
// always — a manager never has a parentSessionId) PLUS a best-effort Platform-Lead escalation via the
// newly-generalized `notifyLeadOfParentlessManagerIssue` (extracted from the single-purpose
// `notifyLeadOfStuckManager`) — never either/or, never a self-nudge into the dropped session itself.
// `companion/attention-push.ts`'s `classify()` gates this into the owner-attention surfaces on the same
// `parentNudged === false` condition `claude_boot_dialog_stuck` already uses (covered by a unit test in
// `attention-push.mjs`-shaped coverage is out of scope here — this file covers the service layer only).
//
// Proves:
//   (A) a MANAGER kickoff give-up-exhaustion ALWAYS records a durable `manager_kickoff_dropped` event,
//       detail carries { msgId, rootMsgId, role:"manager", parentNudged:false }, even with no platform-
//       tier home resolvable at all (leadNotified:false, no leadBoardTaskId, ZERO enqueueStdin calls).
//   (B) LOOM_DEV ON, a platform-tier home exists but NO live Lead: a durable board task IS filed (so an
//       offline Lead sees it later), leadNotified:false, ZERO enqueueStdin calls.
//   (C) LOOM_DEV ON, a LIVE + past-boot Lead exists: best-effort live-nudge (ONE enqueueStdin call to the
//       Lead, naming the dropped manager session), a board task filed, leadNotified:true — and the
//       DROPPED MANAGER ITSELF still gets ZERO enqueueStdin calls (no self-nudge into a session whose
//       first turn never started).
//   (D) dedup: a SECOND drop for the SAME manager session id reuses the EXISTING board task (never a
//       second insertTask) while the live-nudge-to-Lead itself fires again (not deduped) — mirrors
//       claude-boot-dialog-stuck-no-self-nudge.mjs's own (M5).
//   (E) LOOM_DEV OFF (the shipped, non-dev path): `resolveLiveLeadHome` resolves the end-user "Platform"
//       setup home instead of the dev "Loom Platform" home — the board task lands there, proving the fix
//       is wired through BOTH env states, not just the dev one.
//   (F) THE SCOPE BOUNDARY: a WORKER's own kickoff give-up-exhaustion is COMPLETELY UNAFFECTED by this
//       change — no `manager_kickoff_dropped` event is ever recorded for a worker, and its existing
//       `[loom:worker-spawn-broken]` parent-notice path (kickoff-giveup-exhausted.mjs's own (S1)-(S16))
//       fires exactly as before.
//   (G) Code Review 5f95e7a1 (round 2, BLOCKING): a MANAGER whose kickoff genuinely landed but confirmed
//       LATE (pty reports hasFirstTurnStarted:true) must produce NO event, NO board task, and NO nudge to
//       the Lead — round 1 ran the manager carve-out BEFORE this discriminator, so it filed the full drop
//       treatment for a session that wasn't actually dropped.
//   (H) The SAME late-confirmation case (G) proves via the pty hook, proven independently via a REAL,
//       non-empty on-disk transcript (mirrors kickoff-giveup-exhausted.mjs's own (S9) for the worker path)
//       — hasFirstTurnStarted is never set, the transcript alone must suppress: NO event, NO task, NO nudge.
//   (I) ROUND 3 (card ab3c965d): still WITHIN the plausible-confirm window (`withinKickoffConfirmWindow`,
//       the SAME predicate the worker park path already consults) at the FIRST exhaustion — the drop is
//       DEFERRED (no event/task/enqueue yet), and a confirmation (a real transcript) landing BEFORE the
//       recheck timer fires suppresses it entirely: still no event/task/enqueue once the timer fires.
//   (J) ROUND 3: still WITHIN the window at call time, but STILL UNCONFIRMED when the recheck timer
//       fires — the full drop treatment fires exactly once, at the recheck, never at the first exhaustion.
//   (K) ROUND 3: OUTSIDE the window at call time (`withinKickoffConfirmWindow` returns null) — drops
//       immediately, byte-identical to (A)-(H)'s own behavior; proves the new window check doesn't
//       regress the ordinary (unmeasurable-or-elapsed) case.
//
// Card 5c2f8108 widens the above from manager-only to ALSO cover role "platform" (the Platform Lead has
// no Lead above it either, so its own dropped kickoff fell into the same generic bail), and adds a RESOLVE
// half (`manager_kickoff_dropped_resolved`, fired on the session's own first completed turn):
//   (L) a PLATFORM kickoff drop records the SAME durable event (role:"platform", parentNudged:false) but
//       NEVER attempts a Lead escalation — leadNotified:false, no leadBoardTaskId, ZERO enqueueStdin calls
//       — even with a LIVE + past-boot Lead present (unlike (C), which proves a manager's drop DOES reach
//       that same Lead); there is no higher session to escalate a Lead's own drop to.
//   (M) a PLATFORM kickoff that confirmed LATE (hasFirstTurnStarted:true) is suppressed exactly like (G).
//   (N) a PLATFORM kickoff still WITHIN the plausible-confirm window defers, then fires exactly once (with
//       role:"platform") at the recheck if still unconfirmed — mirrors (J).
//   (O) a PLATFORM kickoff OUTSIDE the window drops immediately — mirrors (K).
//   (P) `handleKickoffDroppedResolved`: a no-op with no prior unpaired `manager_kickoff_dropped` event.
//   (Q) `handleKickoffDroppedResolved` REQUIRES its `confirmedRootMsgId` to match the unpaired drop's own
//       recorded `rootMsgId` — a mismatch is a no-op, a match resolves it, and a repeat call once already
//       resolved is idempotent.
//   (R) the SAME resolve method pairs against a PLATFORM drop too (from (L)'s own session), keyed on ITS
//       OWN rootMsgId — the pairing is session id + rootMsgId, never session id alone.
//
// Card 5c2f8108 ROUND 2 (Code Review ba4d1e14) replaced the generic "first completed turn resolves it"
// trigger with a real delivery proof — an IdleWatcher nudge, a boot continuation note, ordinary chat, or
// even a StopFailure can all complete a turn with the dropped kickoff's own brief never having landed, so
// "turn-1 completed" was never actually proof of THIS kickoff's delivery:
//   (S) THE REAL WIRING, AT SESSIONSERVICE LEVEL: `handleGiveUpConfirmed` (the method PtyHost's own live
//       content-match hook actually calls — never a direct call to the resolve method alone) resolves a
//       dropped manager kickoff when the confirmed logicalId matches its own rootMsgId. Calls
//       `handleGiveUpConfirmed` directly, not through a real PtyHost; a host-level test is a separate,
//       not-yet-built follow-up.
//   (T) NEGATIVE: an unrelated confirmation (a different logicalId on the same session) does NOT resolve
//       a still-open drop.
//
// RED-BEFORE-GREEN (this project's own standing verification posture): run against the PRE-FIX
// `handleKickoffGiveUpExhausted` (role==="manager" still falling into the generic bail) — (A)'s
// `manager_kickoff_dropped` event assertion fails (nothing is ever recorded for a manager), and so do
// (B)/(C)/(D)/(E), which all depend on that event/the Lead-escalation call ever firing at all. Run against
// ROUND-1 code (the manager carve-out ungated by `lateConfirmation`) — (G)/(H) fail: a board task IS
// filed and the Lead IS nudged for a session that only confirmed late. Run against ROUND-2 code (the
// manager carve-out gated by `lateConfirmation` but with no `withinKickoffConfirmWindow` check at all,
// this round's own CR finding #2) — (I) fails: its "deferred, NOT dropped on the first exhaustion"
// assertion is false, since round-2 drops immediately regardless of the window. Run against PRE-5c2f8108
// code (role==="manager" only, no resolve method at all) — (L)-(O) fail (a platform drop falls into the
// generic bail, same as (A)'s pre-fix shape), and (P)-(R) fail (`handleKickoffDroppedResolved` doesn't
// exist). Run against 5c2f8108-ROUND-1 code (the resolve method exists but takes only `sessionId`, with
// no `confirmedRootMsgId` match at all) — (Q)'s mismatch assertion fails (it resolves on ANY call
// regardless of rootMsgId), and (T) fails (nothing stops an unrelated confirmation from resolving it,
// since round 1's trigger was keyed on `onTurnCompleted`/turnSeq, not on a specific rootMsgId at all).
//
// RUN: pnpm build (from packages/daemon) then `node test/manager-kickoff-giveup-dropped.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";
// Card 062fa934, Code Review CRITICAL — every resumeFleetOnBoot call below must inject this explicitly
// (deploy-staleness-fixture-guard.mjs enforces it); see that fixture's own doc for why.
const { CLEAN_STALENESS } = await import("./_deploy-staleness-fixture.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
// resumeFleetOnBoot's OWN continuation nudges are deferred behind PtyHost.waitForMcpSeen — a real async
// hop. A macrotask flush after each resumeFleetOnBoot call (mirrors kickoff-confirm-boot-rearm.mjs's own
// identical need) guarantees those settle before db.close() runs.
const flush = () => new Promise((r) => setTimeout(r, 0));

const tmpHome = path.join(os.tmpdir(), `loom-mkgd-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
// Round 3 (card ab3c965d, CR b0cc737e BLOCKING): scenario (H) writes a REAL transcript via
// `engineTranscriptPath`, which resolves off `os.homedir()` — sandbox HOME/USERPROFILE to a dir under
// `tmpHome` BEFORE the `../dist` import below (mirrors kickoff-giveup-exhausted.mjs's own convention),
// or this leaks a real file into the owner's actual `~/.claude/projects/...` on every run.
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");
const { withinKickoffConfirmWindow } = await import("../dist/pty/host.js");

const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/** Writes a real transcript JSONL to the (sandboxed) `~/.claude/projects/...` path `readTranscript`
 *  resolves — mirrors kickoff-giveup-exhausted.mjs's own `writeLiveTranscript` fixture helper. */
function writeLiveTranscript(cwd, engineSessionId, turnTexts) {
  const file = engineTranscriptPath(cwd, engineSessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, turnTexts.map((t, i) =>
    JSON.stringify({ type: i % 2 === 0 ? "user" : "assistant", message: { content: [{ type: "text", text: t }] } })
  ).join("\n") + "\n");
}

/** Round 4 (card 3d72900f): appends the durable `session_message_gave_up(outcome:"deferred")` marker
 *  `handleKickoffGiveUpExhausted`'s manager/platform `pending` branch now writes before arming the
 *  in-memory recheck timer — mirrors kickoff-confirm-boot-rearm.mjs's own `appendParkedChain` helper for
 *  the worker-side `outcome:"parked"` shape. */
function appendDeferredMarker(db, sessionId, taskId, msgId, rootMsgId, role) {
  db.appendEvent({
    id: `evt-deferred-${rootMsgId}`, ts: now, managerSessionId: sessionId, workerSessionId: sessionId,
    taskId: taskId ?? null, kind: "session_message_gave_up",
    detail: { msgId, rootMsgId, outcome: "deferred", origin: "kickoff", role },
  });
}

/** Minimal hermetic PtyStub — records every enqueueStdin call by recipient id. Mirrors
 *  kickoff-giveup-exhausted.mjs's own PtyStub (the tail-object `enqueueStdin` overload
 *  `enqueueDurableMessage`/`enqueueSystemNudge` actually use) plus `isLiveAndPreBoot`
 *  (claude-boot-dialog-stuck-no-self-nudge.mjs's own shape), since this path needs both. */
class PtyStub {
  constructor() {
    this.live = new Set();
    this.busy = new Set();
    this.pastBoot = new Set();
    this.firstTurnStarted = new Set(); // (F) needs this — the worker branch reads it before the manager carve-out ever applies
    this.sent = []; // { id, text }
    // Round 3 (card ab3c965d): (I)/(J)/(K) need per-id liveStartedAt/composerDirtyLen so
    // withinKickoffConfirmWindow can read BOTH "still within the plausible-confirm window" and "window
    // already elapsed" for different sessions in the SAME run — a shared, unset default (below) stays
    // the "unmeasurable" path (A)-(H) rely on.
    this.liveStartedAtMap = new Map();
    this.composerDirtyLenMap = new Map();
  }
  setLive(id, on = true) { if (on) this.live.add(id); else this.live.delete(id); }
  setBusy(id, on = true) { if (on) this.busy.add(id); else this.busy.delete(id); }
  setPastBoot(id, on = true) { if (on) this.pastBoot.add(id); else this.pastBoot.delete(id); }
  isLiveAndPreBoot(id) { return this.live.has(id) && !this.pastBoot.has(id); }
  hasFirstTurnStarted(id) { return this.firstTurnStarted.has(id); }
  // Round 4 (card 3d72900f): the end-to-end resumeFleetOnBoot scenarios need these two — the requester's
  // own "code is live" flow (unconditional in resumeFleetOnBoot's final block) calls both.
  isAlive(id) { return this.live.has(id); }
  waitForMcpSeen() { return Promise.resolve(true); }
  setLiveStartedAt(id, ms) { this.liveStartedAtMap.set(id, ms); }
  setComposerDirtyLen(id, n) { this.composerDirtyLenMap.set(id, n); }
  // (F)'s worker-path terminal branch also calls withinKickoffConfirmWindow, which reads these two —
  // unset (null/undefined) is the "unmeasurable" path (mirrors kickoff-giveup-exhausted.mjs's own
  // PtyStub default), which resolves to the SAME terminal outcome (F) asserts.
  liveStartedAt(id) { return this.liveStartedAtMap.has(id) ? this.liveStartedAtMap.get(id) : null; }
  getComposerDirtyLen(id) { return this.composerDirtyLenMap.has(id) ? this.composerDirtyLenMap.get(id) : undefined; }
  enqueueStdin(id, text, _source = "system", _onDeliver, _route, _kind, _questionId, _ownerText, _proactive, _senderId, _tail) {
    this.sent.push({ id, text });
    if (!this.live.has(id)) return { delivered: false, reason: "session-dead", queued: false };
    if (!this.busy.has(id)) return { delivered: true };
    return { delivered: false, position: 1, queued: true };
  }
  getPendingEntries() { return []; }
}

const db = new Db();
const proj = `mkgd-proj-${sfx}`, agent = `mkgd-ag-${sfx}`;
db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
const mkSession = (o) => db.insertSession({
  id: o.id, projectId: proj, agentId: agent, engineSessionId: `eng-${o.id}`, title: null, cwd: os.tmpdir(),
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: o.role ?? null, parentSessionId: o.parentSessionId ?? null, taskId: o.taskId ?? null,
  worktreePath: null, branch: null,
});

try {
  // ===================== (A) no platform-tier home at all — event-only, ZERO enqueueStdin calls ========
  {
    delete process.env.LOOM_DEV;
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `mkgd-a-mgr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    pty.setLive(mgr);

    sessions.handleKickoffGiveUpExhausted(mgr, `msg-a-${sfx}`, `root-a-${sfx}`, `kickoff-a-${sfx}`);

    const events = db.listEventsForWorker(mgr).filter((e) => e.kind === "manager_kickoff_dropped");
    check("(A) a durable manager_kickoff_dropped event IS recorded for a manager-role kickoff drop", events.length === 1);
    check("(A) detail carries msgId/rootMsgId/role/parentNudged honestly",
      events[0]?.detail?.msgId === `msg-a-${sfx}` && events[0]?.detail?.rootMsgId === `root-a-${sfx}`
      && events[0]?.detail?.role === "manager" && events[0]?.detail?.parentNudged === false);
    check("(A) leadNotified:false — no platform-tier home resolves, no Lead escalation attempted", events[0]?.detail?.leadNotified === false);
    check("(A) no leadBoardTaskId — no board task was filed", events[0]?.detail?.leadBoardTaskId === undefined);
    check("(A) ZERO enqueueStdin calls anywhere — no Lead, and no self-nudge into the dropped manager either", pty.sent.length === 0);
    check("(A) the event is filed under the manager itself (managerSessionId AND workerSessionId)",
      events[0]?.managerSessionId === mgr && events[0]?.workerSessionId === mgr);
  }

  // The dev "Loom Platform" reserved home — mirrors claude-boot-dialog-stuck-no-self-nudge.mjs's own setup.
  const home = `mkgd-platform-home-${sfx}`;
  db.insertProject({ id: home, name: "Loom Platform", repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null, reserved: true });
  const setupHome = `mkgd-setup-home-${sfx}`;
  db.insertProject({ id: setupHome, name: "Platform", repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null, reserved: true });

  // ===================== (B) LOOM_DEV ON, home exists, NO live Lead: board task filed, leadNotified:false
  {
    process.env.LOOM_DEV = "1";
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `mkgd-b-mgr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    pty.setLive(mgr);

    sessions.handleKickoffGiveUpExhausted(mgr, `msg-b-${sfx}`, `root-b-${sfx}`, `kickoff-b-${sfx}`);

    const events = db.listEventsForWorker(mgr).filter((e) => e.kind === "manager_kickoff_dropped");
    check("(B) leadNotified:false — LOOM_DEV is on but no Lead is live", events[0]?.detail?.leadNotified === false);
    const taskId = events[0]?.detail?.leadBoardTaskId;
    check("(B) a leadBoardTaskId IS carried — a durable task was filed despite no live Lead", typeof taskId === "string");
    const task = typeof taskId === "string" ? db.getTask(taskId) : undefined;
    check("(B) the filed task lives on the reserved Platform home project", task?.projectId === home);
    check("(B) the filed task names the dropped manager session", !!task && task.body.includes(mgr));
    check("(B) ZERO enqueueStdin calls anywhere — no Lead is live to receive one", pty.sent.length === 0);
  }

  // ===================== (C) LOOM_DEV ON, a LIVE + past-boot Lead: best-effort live-nudge + board task ===
  {
    process.env.LOOM_DEV = "1";
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `mkgd-c-mgr-${sfx}`, lead = `mkgd-c-lead-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: lead, role: "platform" });
    pty.setLive(mgr); pty.setLive(lead); pty.setPastBoot(lead);

    sessions.handleKickoffGiveUpExhausted(mgr, `msg-c-${sfx}`, `root-c-${sfx}`, `kickoff-c-${sfx}`);

    const events = db.listEventsForWorker(mgr).filter((e) => e.kind === "manager_kickoff_dropped");
    check("(C) leadNotified:true — a live, past-boot Lead was nudged", events[0]?.detail?.leadNotified === true);
    check("(C) a leadBoardTaskId is still carried", typeof events[0]?.detail?.leadBoardTaskId === "string");
    const toLead = pty.sent.filter((s) => s.id === lead);
    check("(C) exactly ONE enqueueStdin call reaches the Lead", toLead.length === 1);
    check("(C) the Lead's nudge names the dropped manager session", new RegExp(mgr).test(toLead[0]?.text ?? ""));
    check("(C) the dropped manager itself still gets ZERO enqueueStdin calls — no self-nudge into a session whose first turn never started",
      pty.sent.filter((s) => s.id === mgr).length === 0);
    db.setProcessState(lead, "exited"); // hygiene — a stale lead from an earlier scenario must never leak into the next one's liveLead lookup
  }

  // ===================== (D) dedup: a SECOND drop for the SAME manager reuses the EXISTING board task ====
  {
    process.env.LOOM_DEV = "1";
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `mkgd-d-mgr-${sfx}`, lead = `mkgd-d-lead-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: lead, role: "platform" });
    pty.setLive(mgr); pty.setLive(lead); pty.setPastBoot(lead);

    const tasksBefore = db.listTasks(home).length;
    sessions.handleKickoffGiveUpExhausted(mgr, `msg-d1-${sfx}`, `root-d1-${sfx}`, `kickoff-d-${sfx}`);
    const firstTaskId = db.listEventsForWorker(mgr).find((e) => e.kind === "manager_kickoff_dropped")?.detail?.leadBoardTaskId;
    check("(D) (setup) the first drop filed exactly one new task", db.listTasks(home).length === tasksBefore + 1);

    sessions.handleKickoffGiveUpExhausted(mgr, `msg-d2-${sfx}`, `root-d2-${sfx}`, `kickoff-d-${sfx}`);
    const secondEvents = db.listEventsForWorker(mgr).filter((e) => e.kind === "manager_kickoff_dropped");
    check("(D) exactly TWO durable events now exist for this session id (one per episode)", secondEvents.length === 2);
    const secondTaskId = secondEvents[secondEvents.length - 1]?.detail?.leadBoardTaskId;
    check("(D) the SECOND episode's event carries the SAME leadBoardTaskId as the first — reused, not re-filed", secondTaskId === firstTaskId);
    check("(D) NO new task was filed for the second episode", db.listTasks(home).length === tasksBefore + 1);
    const toLead = pty.sent.filter((s) => s.id === lead);
    check("(D) the live-nudge-to-Lead itself is NOT deduped — it fires once per episode (TWO calls total)", toLead.length === 2);
    db.setProcessState(lead, "exited");
  }

  // ===================== (E) LOOM_DEV OFF: resolveLiveLeadHome resolves the END-USER Platform home =======
  {
    delete process.env.LOOM_DEV;
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `mkgd-e-mgr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    pty.setLive(mgr);

    sessions.handleKickoffGiveUpExhausted(mgr, `msg-e-${sfx}`, `root-e-${sfx}`, `kickoff-e-${sfx}`);

    const events = db.listEventsForWorker(mgr).filter((e) => e.kind === "manager_kickoff_dropped");
    const taskId = events[0]?.detail?.leadBoardTaskId;
    check("(E) a leadBoardTaskId IS carried under LOOM_DEV=off too", typeof taskId === "string");
    const task = typeof taskId === "string" ? db.getTask(taskId) : undefined;
    check("(E) the filed task lands on the END-USER setup home, never the dev 'Loom Platform' home", task?.projectId === setupHome);
  }

  // ===================== (F) THE SCOPE BOUNDARY: a WORKER's kickoff drop is completely unaffected ========
  {
    delete process.env.LOOM_DEV;
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `mkgd-f-mgr-${sfx}`, wkr = `mkgd-f-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr, taskId: `tk-mkgd-f-${sfx}` });
    pty.setLive(mgr);
    // TERMINAL_CHAIN_DEPTH (1, mirrors kickoff-giveup-exhausted.mjs's own named local) — exercises the
    // worker's terminal park+notify branch directly, without needing to drive the re-mint step first.
    sessions.handleKickoffGiveUpExhausted(wkr, `msg-f-${sfx}`, `root-f-${sfx}`, `kickoff-f-${sfx}`, 1);

    check("(F) NO manager_kickoff_dropped event is ever recorded for a worker's own kickoff drop",
      db.listEventsForWorker(wkr).filter((e) => e.kind === "manager_kickoff_dropped").length === 0);
    check("(F) the worker's existing [loom:worker-spawn-broken] parent-notice path still fires, unchanged",
      pty.sent.some((s) => s.id === mgr && s.text.includes("[loom:worker-spawn-broken]")));
  }

  // ===================== (G) Code Review 5f95e7a1: hasFirstTurnStarted:true suppresses EVERYTHING =======
  // LOOM_DEV ON + a LIVE/past-boot Lead present (same shape as (C)) so that, if round 1's bug were still
  // live, we'd see exactly the full drop treatment (C) proved — this proves instead that NONE of it fires.
  {
    process.env.LOOM_DEV = "1";
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `mkgd-g-mgr-${sfx}`, lead = `mkgd-g-lead-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: lead, role: "platform" });
    pty.setLive(mgr); pty.setLive(lead); pty.setPastBoot(lead);
    pty.firstTurnStarted.add(mgr); // the discriminator: this manager already confirmed a turn

    const tasksBefore = db.listTasks(home).length;
    sessions.handleKickoffGiveUpExhausted(mgr, `msg-g-${sfx}`, `root-g-${sfx}`, `kickoff-g-${sfx}`);

    check("(G) NO manager_kickoff_dropped event is recorded for a late-confirmed manager",
      db.listEventsForWorker(mgr).filter((e) => e.kind === "manager_kickoff_dropped").length === 0);
    check("(G) NO board task was filed", db.listTasks(home).length === tasksBefore);
    check("(G) ZERO enqueueStdin calls anywhere — no Lead nudge, no self-nudge", pty.sent.length === 0);
    db.setProcessState(lead, "exited");
  }

  // ===================== (H) Code Review 5f95e7a1: a REAL non-empty transcript ALSO suppresses =========
  // Same shape as (G), but hasFirstTurnStarted is never set — the on-disk transcript alone must carry it
  // (mirrors kickoff-giveup-exhausted.mjs's own (S9) for the worker path).
  {
    process.env.LOOM_DEV = "1";
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `mkgd-h-mgr-${sfx}`, lead = `mkgd-h-lead-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: lead, role: "platform" });
    pty.setLive(mgr); pty.setLive(lead); pty.setPastBoot(lead);
    writeLiveTranscript(os.tmpdir(), `eng-${mgr}`, ["manager's real turn-1 output", "continuing the brief"]);

    const tasksBefore = db.listTasks(home).length;
    sessions.handleKickoffGiveUpExhausted(mgr, `msg-h-${sfx}`, `root-h-${sfx}`, `kickoff-h-${sfx}`);

    check("(H) NO manager_kickoff_dropped event is recorded when a real transcript exists",
      db.listEventsForWorker(mgr).filter((e) => e.kind === "manager_kickoff_dropped").length === 0);
    check("(H) NO board task was filed", db.listTasks(home).length === tasksBefore);
    check("(H) ZERO enqueueStdin calls anywhere — no Lead nudge, no self-nudge", pty.sent.length === 0);
    db.setProcessState(lead, "exited");
  }

  // ===================== (I) Round 3 (card ab3c965d): STILL WITHIN the plausible-confirm window — the
  // drop is DEFERRED (not fired on the first exhaustion), and a confirmation landing BEFORE the recheck
  // timer fires suppresses it entirely: no event, no board task, no enqueue — ever.
  {
    process.env.LOOM_DEV = "1";
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `mkgd-i-mgr-${sfx}`, lead = `mkgd-i-lead-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: lead, role: "platform" });
    pty.setLive(mgr); pty.setLive(lead); pty.setPastBoot(lead);

    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    try {
      pty.setLiveStartedAt(mgr, Date.now() - 1_000); // well within BROKEN_SPAWN_HOLDOFF_MS (60s)
      const pending = withinKickoffConfirmWindow(pty, mgr, 0);
      check("(I) (setup) the manager reads as still within its plausible confirm window", pending !== null);

      sessions.handleKickoffGiveUpExhausted(mgr, `msg-i-${sfx}`, `root-i-${sfx}`, `kickoff-i-${sfx}`);
      check("(I) deferred, NOT dropped on the first exhaustion: NO manager_kickoff_dropped event yet",
        db.listEventsForWorker(mgr).filter((e) => e.kind === "manager_kickoff_dropped").length === 0);
      check("(I) deferred, NOT dropped: ZERO enqueueStdin calls yet", pty.sent.length === 0);

      // The confirmation lands BEFORE the recheck timer fires — a real, non-empty transcript.
      writeLiveTranscript(os.tmpdir(), `eng-${mgr}`, ["manager's real turn-1 output, confirmed late"]);
      mock.timers.tick(pending.windowMs - pending.sinceMs + 1_000);

      check("(I) the late confirmation suppresses the drop entirely: still NO event",
        db.listEventsForWorker(mgr).filter((e) => e.kind === "manager_kickoff_dropped").length === 0);
      check("(I) still ZERO enqueueStdin calls anywhere — no Lead nudge, no self-nudge", pty.sent.length === 0);
    } finally {
      mock.timers.reset();
    }
    db.setProcessState(lead, "exited");
  }

  // ===================== (J) Round 3: STILL WITHIN the window at call time, but STILL UNCONFIRMED when
  // the recheck fires — the full drop treatment fires exactly once, at the recheck, not before. ========
  {
    process.env.LOOM_DEV = "1";
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `mkgd-j-mgr-${sfx}`, lead = `mkgd-j-lead-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: lead, role: "platform" });
    pty.setLive(mgr); pty.setLive(lead); pty.setPastBoot(lead);

    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    try {
      pty.setLiveStartedAt(mgr, Date.now() - 1_000);
      const pending = withinKickoffConfirmWindow(pty, mgr, 0);
      sessions.handleKickoffGiveUpExhausted(mgr, `msg-j-${sfx}`, `root-j-${sfx}`, `kickoff-j-${sfx}`);
      check("(J) deferred, NOT dropped on the first exhaustion: NO manager_kickoff_dropped event yet",
        db.listEventsForWorker(mgr).filter((e) => e.kind === "manager_kickoff_dropped").length === 0);

      mock.timers.tick(pending.windowMs - pending.sinceMs + 1_000);

      const events = db.listEventsForWorker(mgr).filter((e) => e.kind === "manager_kickoff_dropped");
      check("(J) still unconfirmed at the recheck: the full drop fires exactly once", events.length === 1);
      check("(J) leadNotified:true — a live, past-boot Lead was nudged", events[0]?.detail?.leadNotified === true);
      const toLead = pty.sent.filter((s) => s.id === lead);
      check("(J) exactly ONE enqueueStdin call reaches the Lead", toLead.length === 1);
      check("(J) the dropped manager itself still gets ZERO enqueueStdin calls — no self-nudge",
        pty.sent.filter((s) => s.id === mgr).length === 0);
    } finally {
      mock.timers.reset();
    }
    db.setProcessState(lead, "exited");
  }

  // ===================== (K) Round 3: OUTSIDE the plausible-confirm window at call time — drops
  // immediately, exactly as before this round. ============================================================
  {
    process.env.LOOM_DEV = "1";
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `mkgd-k-mgr-${sfx}`, lead = `mkgd-k-lead-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: lead, role: "platform" });
    pty.setLive(mgr); pty.setLive(lead); pty.setPastBoot(lead);

    pty.setLiveStartedAt(mgr, Date.now() - 61_000); // past BROKEN_SPAWN_HOLDOFF_MS (60s) — window elapsed
    check("(K) (setup) the manager reads as OUTSIDE its plausible confirm window",
      withinKickoffConfirmWindow(pty, mgr, 0) === null);

    sessions.handleKickoffGiveUpExhausted(mgr, `msg-k-${sfx}`, `root-k-${sfx}`, `kickoff-k-${sfx}`);

    const events = db.listEventsForWorker(mgr).filter((e) => e.kind === "manager_kickoff_dropped");
    check("(K) outside the window: drops immediately, exactly once", events.length === 1);
    check("(K) leadNotified:true — a live, past-boot Lead was nudged", events[0]?.detail?.leadNotified === true);
    db.setProcessState(lead, "exited");
  }

  // ===================== (L) Card 5c2f8108: a PLATFORM kickoff drop — SAME event, NEVER escalated =======
  // Mirrors (C)'s setup (a LIVE + past-boot Lead present) so a leaked escalation would be visible — this
  // proves the Lead-escalation branch is structurally skipped for role:"platform", not merely untriggered
  // for lack of a Lead to notify.
  let platformEvent;
  {
    process.env.LOOM_DEV = "1";
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const leadSelf = `mkgd-l-lead-${sfx}`, otherLead = `mkgd-l-other-lead-${sfx}`;
    mkSession({ id: leadSelf, role: "platform" });
    mkSession({ id: otherLead, role: "platform" });
    pty.setLive(leadSelf); pty.setLive(otherLead); pty.setPastBoot(otherLead);

    const tasksBefore = db.listTasks(home).length;
    sessions.handleKickoffGiveUpExhausted(leadSelf, `msg-l-${sfx}`, `root-l-${sfx}`, `kickoff-l-${sfx}`);

    const events = db.listEventsForWorker(leadSelf).filter((e) => e.kind === "manager_kickoff_dropped");
    check("(L) a durable manager_kickoff_dropped event IS recorded for a platform-role kickoff drop", events.length === 1);
    platformEvent = events[0];
    check("(L) detail carries role:\"platform\" and parentNudged:false",
      platformEvent?.detail?.role === "platform" && platformEvent?.detail?.parentNudged === false);
    check("(L) leadNotified:false — a Platform Lead's own drop NEVER escalates, even with a live+past-boot Lead present",
      platformEvent?.detail?.leadNotified === false);
    check("(L) no leadBoardTaskId — no board task was filed for the Lead's own drop", platformEvent?.detail?.leadBoardTaskId === undefined);
    check("(L) NO board task was filed at all (not even a reused/pre-existing one)", db.listTasks(home).length === tasksBefore);
    check("(L) ZERO enqueueStdin calls anywhere — no Lead escalation, and no self-nudge into the dropped Lead itself", pty.sent.length === 0);
    db.setProcessState(otherLead, "exited");
    // Round 4 (card 3d72900f) hygiene: leadSelf stays a DB-level "live" platform session otherwise —
    // (R) only needs its id (handleKickoffDroppedResolved is DB-only, no liveness requirement), but a
    // later scenario's OWN notifyLeadOfParentlessManagerIssue lookup (`listAllSessions().find(role===
    // "platform" && processState==="live")`) would silently pick this stale row over its intended
    // target, sending a real Lead nudge to a session absent from that scenario's own fresh PtyStub.
    db.setProcessState(leadSelf, "exited");
  }

  // ===================== (M) Card 5c2f8108: a PLATFORM kickoff that confirmed LATE is suppressed =========
  {
    process.env.LOOM_DEV = "1";
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const lead = `mkgd-m-lead-${sfx}`;
    mkSession({ id: lead, role: "platform" });
    pty.setLive(lead);
    pty.firstTurnStarted.add(lead); // the discriminator: this Lead already confirmed a turn

    sessions.handleKickoffGiveUpExhausted(lead, `msg-m-${sfx}`, `root-m-${sfx}`, `kickoff-m-${sfx}`);

    check("(M) NO manager_kickoff_dropped event is recorded for a late-confirmed Platform Lead",
      db.listEventsForWorker(lead).filter((e) => e.kind === "manager_kickoff_dropped").length === 0);
    check("(M) ZERO enqueueStdin calls anywhere", pty.sent.length === 0);
    db.setProcessState(lead, "exited"); // hygiene — see (L)'s own fix note for why this must not leak
  }

  // ===================== (N) Card 5c2f8108: a PLATFORM kickoff still WITHIN the window defers, then =====
  // =====================     fires exactly once (role:"platform") at the recheck if still unconfirmed ===
  {
    process.env.LOOM_DEV = "1";
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const lead = `mkgd-n-lead-${sfx}`;
    mkSession({ id: lead, role: "platform" });
    pty.setLive(lead);

    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    try {
      pty.setLiveStartedAt(lead, Date.now() - 1_000);
      const pending = withinKickoffConfirmWindow(pty, lead, 0);
      sessions.handleKickoffGiveUpExhausted(lead, `msg-n-${sfx}`, `root-n-${sfx}`, `kickoff-n-${sfx}`);
      check("(N) deferred, NOT dropped on the first exhaustion: NO manager_kickoff_dropped event yet",
        db.listEventsForWorker(lead).filter((e) => e.kind === "manager_kickoff_dropped").length === 0);

      mock.timers.tick(pending.windowMs - pending.sinceMs + 1_000);

      const events = db.listEventsForWorker(lead).filter((e) => e.kind === "manager_kickoff_dropped");
      check("(N) still unconfirmed at the recheck: the full drop fires exactly once", events.length === 1);
      check("(N) detail carries role:\"platform\"", events[0]?.detail?.role === "platform");
      check("(N) leadNotified:false — never escalated", events[0]?.detail?.leadNotified === false);
      check("(N) ZERO enqueueStdin calls anywhere", pty.sent.length === 0);
    } finally {
      mock.timers.reset();
    }
    db.setProcessState(lead, "exited"); // hygiene — see (L)'s own fix note for why this must not leak
  }

  // ===================== (O) Card 5c2f8108: a PLATFORM kickoff OUTSIDE the window drops immediately =====
  {
    process.env.LOOM_DEV = "1";
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const lead = `mkgd-o-lead-${sfx}`;
    mkSession({ id: lead, role: "platform" });
    pty.setLive(lead);
    pty.setLiveStartedAt(lead, Date.now() - 61_000); // past BROKEN_SPAWN_HOLDOFF_MS (60s) — window elapsed
    check("(O) (setup) the Lead reads as OUTSIDE its plausible confirm window",
      withinKickoffConfirmWindow(pty, lead, 0) === null);

    sessions.handleKickoffGiveUpExhausted(lead, `msg-o-${sfx}`, `root-o-${sfx}`, `kickoff-o-${sfx}`);

    const events = db.listEventsForWorker(lead).filter((e) => e.kind === "manager_kickoff_dropped");
    check("(O) outside the window: drops immediately, exactly once", events.length === 1);
    check("(O) detail carries role:\"platform\", leadNotified:false", events[0]?.detail?.role === "platform" && events[0]?.detail?.leadNotified === false);
    db.setProcessState(lead, "exited"); // hygiene — see (L)'s own fix note for why this must not leak
  }

  // ===================== (P) Card 5c2f8108 round 2: handleKickoffDroppedResolved — no-op, no prior drop ==
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const noHistory = `mkgd-p-nohist-${sfx}`;
    mkSession({ id: noHistory, role: "manager" });

    sessions.handleKickoffDroppedResolved(noHistory, `root-p-whatever-${sfx}`);
    check("(P) no-op: calling handleKickoffDroppedResolved with no prior drop history appends nothing",
      db.listEventsForWorker(noHistory).filter((e) => e.kind === "manager_kickoff_dropped_resolved").length === 0);
  }

  // ===================== (Q) Card 5c2f8108 round 2: handleKickoffDroppedResolved REQUIRES the confirmed ===
  // =====================     rootMsgId to match (A)'s own drop — a mismatch is a no-op, a match resolves, ==
  // =====================     and a repeat call once already resolved is idempotent. ========================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    // Reuse (A)'s own dropped manager session id/rootMsgId verbatim — literal values minted at (A)'s scope.
    const mgrASessionId = `mkgd-a-mgr-${sfx}`;
    const mgrARootMsgId = `root-a-${sfx}`;
    const before = db.listEventsForWorker(mgrASessionId).filter((e) => e.kind === "manager_kickoff_dropped");
    check("(Q) (setup) exactly one unpaired manager_kickoff_dropped event exists for (A)'s manager",
      before.length === 1 && db.listEventsForWorker(mgrASessionId).filter((e) => e.kind === "manager_kickoff_dropped_resolved").length === 0);

    // Round 2's own new requirement: a confirmation of a DIFFERENT message must NOT resolve this alert —
    // without this, a generic "something confirmed" signal would be indistinguishable from the dropped
    // kickoff's own delivery, exactly the defect this round exists to close.
    sessions.handleKickoffDroppedResolved(mgrASessionId, `root-UNRELATED-${sfx}`);
    check("(Q) a mismatched rootMsgId does NOT resolve the alert",
      db.listEventsForWorker(mgrASessionId).filter((e) => e.kind === "manager_kickoff_dropped_resolved").length === 0);

    sessions.handleKickoffDroppedResolved(mgrASessionId, mgrARootMsgId);
    const resolved = db.listEventsForWorker(mgrASessionId).filter((e) => e.kind === "manager_kickoff_dropped_resolved");
    check("(Q) the MATCHING rootMsgId resolves it: exactly one resolved event appended", resolved.length === 1);
    check("(Q) the resolved event is filed under the SAME managerSessionId/taskId as the paired drop",
      resolved[0]?.managerSessionId === before[0]?.managerSessionId && resolved[0]?.taskId === before[0]?.taskId);
    check("(Q) the resolved event names the affected session as its workerSessionId", resolved[0]?.workerSessionId === mgrASessionId);

    sessions.handleKickoffDroppedResolved(mgrASessionId, mgrARootMsgId);
    check("(Q) idempotent: a second matching call once already resolved appends no second resolved event",
      db.listEventsForWorker(mgrASessionId).filter((e) => e.kind === "manager_kickoff_dropped_resolved").length === 1);
  }

  // ===================== (R) Card 5c2f8108 round 2: the SAME resolve method pairs against (L)'s PLATFORM ==
  // =====================     drop too, keyed on ITS OWN rootMsgId (root-l-${sfx}), not (A)'s. ==============
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const leadSelfId = platformEvent?.workerSessionId;
    const leadRootMsgId = `root-l-${sfx}`;
    check("(R) (setup) (L)'s platform drop event is available", typeof leadSelfId === "string");
    check("(R) (setup) (L)'s drop was recorded under its OWN rootMsgId", platformEvent?.detail?.rootMsgId === leadRootMsgId);

    sessions.handleKickoffDroppedResolved(leadSelfId, leadRootMsgId);
    const resolved = db.listEventsForWorker(leadSelfId).filter((e) => e.kind === "manager_kickoff_dropped_resolved");
    check("(R) the SAME resolve method pairs against a PLATFORM drop too — exactly one resolved event appended", resolved.length === 1);
  }

  // ===================== (S) Card 5c2f8108 round 2: THE REAL WIRING, AT SESSIONSERVICE LEVEL — ============
  // =====================     handleGiveUpConfirmed (the live content-match entry point PtyHost actually ===
  // =====================     calls) is what resolves a dropped kickoff, not a direct call to ==============
  // =====================     handleKickoffDroppedResolved alone. Called directly here, not through a real =
  // =====================     PtyHost — a host-level test is a separate, not-yet-built follow-up. ==========
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `mkgd-s-mgr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    pty.setLive(mgr);
    const rootMsgId = `root-s-${sfx}`;

    sessions.handleKickoffGiveUpExhausted(mgr, `msg-s-${sfx}`, rootMsgId, `kickoff-s-${sfx}`);
    check("(S) (setup) the kickoff drop was recorded",
      db.listEventsForWorker(mgr).filter((e) => e.kind === "manager_kickoff_dropped").length === 1);

    // The REAL path: PtyHost's own late content-match fires onGiveUpConfirmed(sessionId, logicalId, ms),
    // which the daemon wires straight to handleGiveUpConfirmed — never a direct call to the resolve method.
    sessions.handleGiveUpConfirmed(mgr, rootMsgId, 12_345);
    const resolved = db.listEventsForWorker(mgr).filter((e) => e.kind === "manager_kickoff_dropped_resolved");
    check("(S) a late content-match confirmation of the dropped kickoff's OWN rootMsgId resolves it, at SessionService level",
      resolved.length === 1);
  }

  // ===================== (T) Card 5c2f8108 round 2: NEGATIVE — an unrelated confirmation (an idle-nudge- ==
  // =====================     shaped turn's own give-up chain, or any other message's logicalId) must =====
  // =====================     NOT resolve a still-open drop for a DIFFERENT session. =========================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `mkgd-t-mgr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    pty.setLive(mgr);
    const rootMsgId = `root-t-${sfx}`;

    sessions.handleKickoffGiveUpExhausted(mgr, `msg-t-${sfx}`, rootMsgId, `kickoff-t-${sfx}`);
    check("(T) (setup) the kickoff drop was recorded",
      db.listEventsForWorker(mgr).filter((e) => e.kind === "manager_kickoff_dropped").length === 1);

    // An unrelated confirmation on the SAME session — e.g. an idle-nudge or ordinary chat message's own
    // give-up/content-match chain confirming with a DIFFERENT logicalId — must not be read as proof THIS
    // kickoff landed. This is the exact gap round 1's bare "first completed turn" trigger had.
    sessions.handleGiveUpConfirmed(mgr, `root-UNRELATED-idle-nudge-${sfx}`, 999);
    check("(T) an unrelated confirmation does NOT resolve the still-open drop",
      db.listEventsForWorker(mgr).filter((e) => e.kind === "manager_kickoff_dropped_resolved").length === 0);
  }

  // ===================== ROUND 4 (card 3d72900f): escalateDeferredManagerKickoffAtBoot ===================
  // (U) the deferred marker now actually gets written in the `pending` branch, and (V)/(W)/(X)-(DD) prove
  // the new boot consumer that reads it. =====================================================================
  {
    process.env.LOOM_DEV = "1";
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `mkgd-u-mgr-${sfx}`, lead = `mkgd-u-lead-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: lead, role: "platform" });
    pty.setLive(mgr); pty.setLive(lead); pty.setPastBoot(lead);

    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    try {
      pty.setLiveStartedAt(mgr, Date.now() - 1_000);
      const pending = withinKickoffConfirmWindow(pty, mgr, 0);
      check("(U) (setup) the manager reads as still within its plausible confirm window", pending !== null);

      sessions.handleKickoffGiveUpExhausted(mgr, `msg-u-${sfx}`, `root-u-${sfx}`, `kickoff-u-${sfx}`);
      const deferred = db.listEventsForWorker(mgr).filter((e) =>
        e.kind === "session_message_gave_up" && e.detail?.outcome === "deferred" && e.detail?.origin === "kickoff");
      check("(U) THE FIX: a durable outcome:\"deferred\" marker IS recorded before the in-memory timer is armed",
        deferred.length === 1);
      check("(U) the marker carries msgId/rootMsgId/role honestly",
        deferred[0]?.detail?.msgId === `msg-u-${sfx}` && deferred[0]?.detail?.rootMsgId === `root-u-${sfx}` && deferred[0]?.detail?.role === "manager");
      check("(U) still no manager_kickoff_dropped event yet — the marker records the DEFERRAL, not the drop",
        db.listEventsForWorker(mgr).filter((e) => e.kind === "manager_kickoff_dropped").length === 0);
    } finally {
      mock.timers.reset();
    }
    db.setProcessState(lead, "exited");
  }

  // ===================== (V) escalateDeferredManagerKickoffAtBoot: each discriminator stands down ========
  {
    process.env.LOOM_DEV = "1";
    const mkDeferredFixture = (label) => {
      const pty = new PtyStub();
      const sessions = new SessionService(db, pty, new OrchestrationControl());
      const mgr = `mkgd-v-${label}-mgr-${sfx}`, lead = `mkgd-v-${label}-lead-${sfx}`;
      mkSession({ id: mgr, role: "manager" });
      mkSession({ id: lead, role: "platform" });
      pty.setLive(mgr); pty.setLive(lead); pty.setPastBoot(lead);
      const rootMsgId = `root-v-${label}-${sfx}`, msgId = `msg-v-${label}-${sfx}`;
      appendDeferredMarker(db, mgr, null, msgId, rootMsgId, "manager");
      return { pty, sessions, mgr, lead, rootMsgId };
    };

    {
      // Round 5 (card 3d72900f, N-4): made REAL — a worker session carrying an ACTUAL deferred-shaped
      // marker (never appended before this fix, so the role check could never be distinguished from
      // "nothing to escalate anyway") must still never be escalated via this manager/platform-only path.
      const pty = new PtyStub();
      const sessions = new SessionService(db, pty, new OrchestrationControl());
      const plainMgr = `mkgd-v-role-mgr-${sfx}`, plainWkr = `mkgd-v-role-wkr-${sfx}`;
      mkSession({ id: plainMgr, role: "manager" });
      mkSession({ id: plainWkr, role: "worker", parentSessionId: plainMgr });
      appendDeferredMarker(db, plainWkr, null, `msg-v-role-${sfx}`, `root-v-role-${sfx}`, "manager");
      const fired = sessions.escalateDeferredManagerKickoffAtBoot(plainWkr, false, false);
      check("(V-role) a non-manager/platform session id is never escalated, even WITH a real deferred marker present", fired === false);
      check("(V-role) NO manager_kickoff_dropped event was recorded",
        db.listEventsForWorker(plainWkr).filter((e) => e.kind === "manager_kickoff_dropped").length === 0);
    }
    {
      const { sessions, mgr, lead, rootMsgId } = mkDeferredFixture("turnseq");
      db.incrementTurnSeq(mgr); // real completed-turn marker — the kickoff confirmed and ran to completion
      check("(V-turnSeq) (setup) turnSeq is now > 0", (db.getSession(mgr)?.turnSeq ?? 0) > 0);
      const fired = sessions.escalateDeferredManagerKickoffAtBoot(mgr, false, false);
      check("(V-turnSeq) persisted turnSeq > 0 stands down — the kickoff confirmed before this restart", fired === false);
      check("(V-turnSeq) NO manager_kickoff_dropped event was recorded",
        db.listEventsForWorker(mgr).filter((e) => e.kind === "manager_kickoff_dropped" && e.detail?.rootMsgId === rootMsgId).length === 0);
      db.setProcessState(lead, "exited");
    }
    {
      const { sessions, mgr, lead, rootMsgId } = mkDeferredFixture("busy");
      db.setBusy(mgr, true); // PERSISTED busy — still mid-turn as of the last write before this restart
      const fired = sessions.escalateDeferredManagerKickoffAtBoot(mgr, false, false);
      check("(V-busy) the PERSISTED busy flag stands down", fired === false);
      check("(V-busy) NO manager_kickoff_dropped event was recorded",
        db.listEventsForWorker(mgr).filter((e) => e.kind === "manager_kickoff_dropped" && e.detail?.rootMsgId === rootMsgId).length === 0);
      db.setProcessState(lead, "exited");
    }
    {
      const { sessions, mgr, lead } = mkDeferredFixture("busyat");
      const fired = sessions.escalateDeferredManagerKickoffAtBoot(mgr, false, true); // hasBusyAtCapture=true
      check("(V-busyAtCapture) the CAPTURED busy-at-capture flag stands down", fired === false);
      check("(V-busyAtCapture) NO manager_kickoff_dropped event was recorded",
        db.listEventsForWorker(mgr).filter((e) => e.kind === "manager_kickoff_dropped").length === 0);
      db.setProcessState(lead, "exited");
    }
    {
      const { sessions, mgr, lead } = mkDeferredFixture("pending");
      const fired = sessions.escalateDeferredManagerKickoffAtBoot(mgr, true, false); // hasQueuedPending=true
      check("(V-queuedPending) queued pending direction about to replay stands down", fired === false);
      check("(V-queuedPending) NO manager_kickoff_dropped event was recorded",
        db.listEventsForWorker(mgr).filter((e) => e.kind === "manager_kickoff_dropped").length === 0);
      db.setProcessState(lead, "exited");
    }
    {
      const { sessions, mgr, lead, rootMsgId } = mkDeferredFixture("transcript");
      writeLiveTranscript(os.tmpdir(), `eng-${mgr}`, ["the manager's real turn-1 output"]);
      const fired = sessions.escalateDeferredManagerKickoffAtBoot(mgr, false, false);
      check("(V-transcript) a non-empty on-disk transcript stands down — a turn genuinely ran", fired === false);
      check("(V-transcript) NO manager_kickoff_dropped event was recorded for this rootMsgId",
        db.listEventsForWorker(mgr).filter((e) => e.kind === "manager_kickoff_dropped" && e.detail?.rootMsgId === rootMsgId).length === 0);
      db.setProcessState(lead, "exited");
    }
  }

  // ===================== (W) escalateDeferredManagerKickoffAtBoot: the POSITIVE case fires exactly once,
  // for BOTH roles, and is the SAME terminal action the live timer uses (leadNotified honest per role). ===
  {
    process.env.LOOM_DEV = "1";
    for (const role of ["manager", "platform"]) {
      const pty = new PtyStub();
      const sessions = new SessionService(db, pty, new OrchestrationControl());
      const subj = `mkgd-w-${role}-${sfx}`, lead = `mkgd-w-${role}-lead-${sfx}`;
      mkSession({ id: subj, role });
      mkSession({ id: lead, role: "platform" });
      pty.setLive(subj); pty.setLive(lead); pty.setPastBoot(lead);
      const rootMsgId = `root-w-${role}-${sfx}`, msgId = `msg-w-${role}-${sfx}`;
      appendDeferredMarker(db, subj, null, msgId, rootMsgId, role);

      const fired = sessions.escalateDeferredManagerKickoffAtBoot(subj, false, false);
      check(`(W-${role}) all discriminators clear: the boot consumer escalates exactly once`, fired === true);
      const events = db.listEventsForWorker(subj).filter((e) => e.kind === "manager_kickoff_dropped" && e.detail?.rootMsgId === rootMsgId);
      check(`(W-${role}) a durable manager_kickoff_dropped event was recorded, carrying the deferred marker's own msgId/rootMsgId/role`,
        events.length === 1 && events[0]?.detail?.msgId === msgId && events[0]?.detail?.role === role);
      check(`(W-${role}) leadNotified matches the role rule (manager: escalated; platform: never)`,
        events[0]?.detail?.leadNotified === (role === "manager"));
      // A second call for the SAME session must never double-fire (the "already dropped" guard).
      const firedAgain = sessions.escalateDeferredManagerKickoffAtBoot(subj, false, false);
      check(`(W-${role}) a repeat call for the SAME already-dropped session never fires again`, firedAgain === false);
      check(`(W-${role}) still exactly ONE manager_kickoff_dropped event`,
        db.listEventsForWorker(subj).filter((e) => e.kind === "manager_kickoff_dropped" && e.detail?.rootMsgId === rootMsgId).length === 1);
      db.setProcessState(lead, "exited");
      // Hygiene (same reasoning as (L)'s fix above): the platform-role iteration's own `subj` is itself
      // a DB-level "live" platform session and must not leak into a later scenario's liveLead lookup.
      if (role === "platform") db.setProcessState(subj, "exited");
    }
  }

  // ===================== (X) the live timer already dropped it BEFORE a restart — the boot consumer must
  // stand down via the "already dropped" guard, never a double-fire across the two mechanisms. ============
  {
    process.env.LOOM_DEV = "1";
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `mkgd-x-mgr-${sfx}`, lead = `mkgd-x-lead-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: lead, role: "platform" });
    pty.setLive(mgr); pty.setLive(lead); pty.setPastBoot(lead);

    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    let pending;
    try {
      pty.setLiveStartedAt(mgr, Date.now() - 1_000);
      pending = withinKickoffConfirmWindow(pty, mgr, 0);
      sessions.handleKickoffGiveUpExhausted(mgr, `msg-x-${sfx}`, `root-x-${sfx}`, `kickoff-x-${sfx}`);
      // The live timer fires (still unconfirmed) — this is `handleManagerKickoffDropped` running from
      // `armKickoffConfirmRecheck`'s own callback, exactly as (J) already proves; simulating "pre-restart".
      mock.timers.tick(pending.windowMs - pending.sinceMs + 1_000);
    } finally {
      mock.timers.reset();
    }
    const beforeBoot = db.listEventsForWorker(mgr).filter((e) => e.kind === "manager_kickoff_dropped");
    check("(X) (setup) the live timer already dropped it", beforeBoot.length === 1);

    // Now simulate a restart hitting AFTER the live drop — the boot consumer must see the already-dropped
    // event and stand down, never calling handleManagerKickoffDropped a second time.
    const fired = sessions.escalateDeferredManagerKickoffAtBoot(mgr, false, false);
    check("(X) the boot consumer stands down — a LATER manager_kickoff_dropped already exists for this rootMsgId", fired === false);
    check("(X) still exactly ONE manager_kickoff_dropped event — never a double-fire across the two mechanisms",
      db.listEventsForWorker(mgr).filter((e) => e.kind === "manager_kickoff_dropped").length === 1);
    db.setProcessState(lead, "exited");
  }

  // ===================== (Y) THE TRAP — end-to-end via resumeFleetOnBoot: the boot consumer fires INSTEAD
  // OF (never alongside) the ordinary continuation nudge, since it runs BEFORE that nudge is composed.
  // Round 5 (card 3d72900f, SF-2): the subject is now NEVER a plain bystander — hadUnsentDraft:true is a
  // REAL nudge-forcing condition (`if (draftNote || capNote) this.enqueueDurableNudge(...)` in the no-op
  // branch), so (Y-with-marker)'s "no nudge" result is actually caused by the escalation, not merely by
  // the subject being a no-op bystander that would have gotten nothing regardless — proven by (Y-without-
  // marker) below, the SAME fixture shape with no marker, which DOES get the draft-loss nudge. ===========
  {
    process.env.LOOM_DEV = "1";
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const reqMgr = `mkgd-y-reqmgr-${sfx}`, subj = `mkgd-y-subj-${sfx}`, lead = `mkgd-y-lead-${sfx}`;
    mkSession({ id: reqMgr, role: "manager" });
    mkSession({ id: subj, role: "manager" });
    mkSession({ id: lead, role: "platform" });
    pty.setLive(reqMgr); pty.setLive(subj); pty.setLive(lead); pty.setPastBoot(lead);
    const rootMsgId = `root-y-${sfx}`, msgId = `msg-y-${sfx}`;
    appendDeferredMarker(db, subj, null, msgId, rootMsgId, "manager");

    const resumeSet = [
      { sessionId: reqMgr, role: "manager", parentSessionId: null },
      { sessionId: subj, role: "manager", parentSessionId: null, hadUnsentDraft: true },
    ];
    const intent = { reason: "deploy merged daemon code", managerSessionId: reqMgr, resume: resumeSet, pending: {}, requestedAt: now };
    sessions.resumeFleetOnBoot(intent, { resumeOne: () => true, deployStaleness: CLEAN_STALENESS });
    await flush();

    const dropped = db.listEventsForWorker(subj).filter((e) => e.kind === "manager_kickoff_dropped" && e.detail?.rootMsgId === rootMsgId);
    check("(Y-with-marker) THE TRAP: escalateDeferredManagerKickoffAtBoot fired via the real resumeFleetOnBoot path", dropped.length === 1);
    check("(Y-with-marker) the drop's own notice names the lost draft (hadUnsentDraft forwarded, N-6)",
      typeof dropped[0]?.detail?.leadBoardTaskId !== "string" || (() => {
        const task = db.getTask(dropped[0].detail.leadBoardTaskId);
        return !!task && task.body.includes("unsent composer draft");
      })());
    const subjNudges = pty.sent.filter((s) => s.id === subj);
    check("(Y-with-marker) the subject's OWN queue gets NOTHING AT ALL — not even the draft-loss nudge that hadUnsentDraft would otherwise force — the escalation ran INSTEAD of the whole no-op branch, not alongside it",
      subjNudges.length === 0);
    db.setProcessState(lead, "exited");
  }

  // ===================== (Y-without-marker): the SAME fixture shape as (Y-with-marker) but with NO
  // deferred marker at all — proves the "no nudge" result above is caused by the escalation firing, not
  // by the subject being some other kind of no-op the nudge-forcing condition couldn't reach anyway. =====
  {
    process.env.LOOM_DEV = "1";
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const reqMgr = `mkgd-y2-reqmgr-${sfx}`, subj = `mkgd-y2-subj-${sfx}`;
    mkSession({ id: reqMgr, role: "manager" });
    mkSession({ id: subj, role: "manager" });
    pty.setLive(reqMgr); pty.setLive(subj);

    const resumeSet = [
      { sessionId: reqMgr, role: "manager", parentSessionId: null },
      { sessionId: subj, role: "manager", parentSessionId: null, hadUnsentDraft: true },
    ];
    const intent = { reason: "deploy merged daemon code", managerSessionId: reqMgr, resume: resumeSet, pending: {}, requestedAt: now };
    sessions.resumeFleetOnBoot(intent, { resumeOne: () => true, deployStaleness: CLEAN_STALENESS });
    await flush();

    check("(Y-without-marker) NO manager_kickoff_dropped event — there was no marker to escalate",
      db.listEventsForWorker(subj).filter((e) => e.kind === "manager_kickoff_dropped").length === 0);
    const subjNudges = pty.sent.filter((s) => s.id === subj);
    check("(Y-without-marker) WITHOUT the escalation, the subject DOES get the draft-loss nudge — same fixture, same hadUnsentDraft, proving (Y-with-marker)'s silence was the escalation's doing",
      subjNudges.length === 1 && /unsent/i.test(subjNudges[0]?.text ?? ""));
  }

  // ===================== (Z) RESTART TWICE: two simulated boots in a row must record exactly ONE
  // manager_kickoff_dropped event + ONE Lead nudge — proves handleManagerKickoffDropped's Lead-notify is
  // wrapped so the terminal event always lands, keeping the "already dropped" dedup check sound. ==========
  {
    process.env.LOOM_DEV = "1";
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const reqMgr = `mkgd-z-reqmgr-${sfx}`, subj = `mkgd-z-subj-${sfx}`, lead = `mkgd-z-lead-${sfx}`;
    mkSession({ id: reqMgr, role: "manager" });
    mkSession({ id: subj, role: "manager" });
    mkSession({ id: lead, role: "platform" });
    pty.setLive(reqMgr); pty.setLive(subj); pty.setLive(lead); pty.setPastBoot(lead);
    const rootMsgId = `root-z-${sfx}`, msgId = `msg-z-${sfx}`;
    appendDeferredMarker(db, subj, null, msgId, rootMsgId, "manager");

    const resumeSet = [
      { sessionId: reqMgr, role: "manager", parentSessionId: null },
      { sessionId: subj, role: "manager", parentSessionId: null },
    ];

    sessions.resumeFleetOnBoot({ reason: "boot 1", managerSessionId: reqMgr, resume: resumeSet, pending: {}, requestedAt: now }, { resumeOne: () => true, deployStaleness: CLEAN_STALENESS });
    await flush();
    check("(Z) boot #1 drops exactly once",
      db.listEventsForWorker(subj).filter((e) => e.kind === "manager_kickoff_dropped" && e.detail?.rootMsgId === rootMsgId).length === 1);

    // Boot #2 — the SAME session, nothing resolved in between (simulates another restart before anyone acted).
    sessions.resumeFleetOnBoot({ reason: "boot 2", managerSessionId: reqMgr, resume: resumeSet, pending: {}, requestedAt: now }, { resumeOne: () => true, deployStaleness: CLEAN_STALENESS });
    await flush();
    const afterBoot2 = db.listEventsForWorker(subj).filter((e) => e.kind === "manager_kickoff_dropped" && e.detail?.rootMsgId === rootMsgId);
    check("(Z) NO-DOUBLE-FIRE: boot #2 does NOT record a second manager_kickoff_dropped event", afterBoot2.length === 1);
    const toLead = pty.sent.filter((s) => s.id === lead);
    check("(Z) NO-DOUBLE-NOTICE: the Lead was nudged exactly once across both boots, not once per boot", toLead.length === 1);
    db.setProcessState(lead, "exited"); // hygiene — a stale live lead must never leak into a later scenario's liveLead lookup
  }

  // ===================== (CC) Round 5 (card 3d72900f, SF-3): Lead-notify THROWS — the terminal event must
  // still land. Reworded from the Round-4 record's own "crash" language: this proves resilience against a
  // THROW inside Lead-notify (a DB fault, a dispatch error) — what the try/catch actually buys is that no
  // uncaught exception can escape the live armKickoffConfirmRecheck setTimeout callback (or this boot
  // consumer) with the terminal event never written; it does NOT cover a genuine OS-level process death
  // in the narrow window between a successful Lead-notify and the appendEvent call below it — that
  // residual is real and named, not closed, by this fix (see the record). ==================================
  // (CC1) insertTask itself throws — the EARLIEST step, before any leadBoardTaskId exists to carry.
  {
    process.env.LOOM_DEV = "1";
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `mkgd-cc1-mgr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    pty.setLive(mgr);
    const rootMsgId = `root-cc1-${sfx}`, msgId = `msg-cc1-${sfx}`;
    appendDeferredMarker(db, mgr, null, msgId, rootMsgId, "manager");

    const realInsertTask = db.insertTask.bind(db);
    db.insertTask = () => { throw new Error("(CC1) synthetic insertTask failure"); };
    let fired;
    try {
      fired = sessions.escalateDeferredManagerKickoffAtBoot(mgr, false, false);
    } finally {
      db.insertTask = realInsertTask;
    }
    check("(CC1) the escalation still reports fired — the terminal event write is never gated on Lead-notify succeeding", fired === true);
    const events = db.listEventsForWorker(mgr).filter((e) => e.kind === "manager_kickoff_dropped" && e.detail?.rootMsgId === rootMsgId);
    check("(CC1) THE FIX: manager_kickoff_dropped still lands even though insertTask threw", events.length === 1);
    check("(CC1) leadNotified:false, no leadBoardTaskId — nothing was ever filed for a throw this early",
      events[0]?.detail?.leadNotified === false && events[0]?.detail?.leadBoardTaskId === undefined);
  }

  // (CC2) insertTask SUCCEEDS (a real leadBoardTaskId is minted) but the nudge-send step throws — must
  // carry the leadBoardTaskId into the event anyway (Code Review's own explicit requirement). ============
  {
    process.env.LOOM_DEV = "1";
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `mkgd-cc2-mgr-${sfx}`, lead = `mkgd-cc2-lead-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: lead, role: "platform" });
    pty.setLive(mgr); pty.setLive(lead); pty.setPastBoot(lead);
    const rootMsgId = `root-cc2-${sfx}`, msgId = `msg-cc2-${sfx}`;
    appendDeferredMarker(db, mgr, null, msgId, rootMsgId, "manager");

    const realEnqueueStdin = pty.enqueueStdin.bind(pty);
    pty.enqueueStdin = (id, ...rest) => {
      if (id === lead) throw new Error("(CC2) synthetic enqueueStdin failure");
      return realEnqueueStdin(id, ...rest);
    };
    const fired = sessions.escalateDeferredManagerKickoffAtBoot(mgr, false, false);
    check("(CC2) the escalation still reports fired", fired === true);
    const events = db.listEventsForWorker(mgr).filter((e) => e.kind === "manager_kickoff_dropped" && e.detail?.rootMsgId === rootMsgId);
    check("(CC2) THE FIX: manager_kickoff_dropped still lands even though the nudge-send threw", events.length === 1);
    check("(CC2) leadNotified:false (the send failed) but leadBoardTaskId IS carried — insertTask had already succeeded before the throw",
      events[0]?.detail?.leadNotified === false && typeof events[0]?.detail?.leadBoardTaskId === "string");
    const task = typeof events[0]?.detail?.leadBoardTaskId === "string" ? db.getTask(events[0].detail.leadBoardTaskId) : undefined;
    check("(CC2) the board task genuinely exists — insertTask's own success is independently verifiable, not just claimed by the event", !!task);
    db.setProcessState(lead, "exited");
  }

  // ===================== (AA) item 3 (Code Review 3f198d0c): archiveOnExit clears the recheck timer
  // BEFORE it fires — never a drop for an exited session. Round 5 (card 3d72900f, N-5): this characterizes
  // PRE-EXISTING behavior (archiveOnExit's clearKickoffConfirmRecheckTimer call predates round 4 — see
  // decision 8882e2ca — round 3 only widened WHICH sessions can hold a timer entry there); round 4 built
  // nothing new here, this scenario just confirms that pre-existing mechanism also covers the manager/
  // platform + deferred-marker shape correctly. =============================================================
  {
    process.env.LOOM_DEV = "1";
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `mkgd-aa-mgr-${sfx}`, lead = `mkgd-aa-lead-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: lead, role: "platform" });
    pty.setLive(mgr); pty.setLive(lead); pty.setPastBoot(lead);

    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    try {
      pty.setLiveStartedAt(mgr, Date.now() - 1_000);
      const pending = withinKickoffConfirmWindow(pty, mgr, 0);
      sessions.handleKickoffGiveUpExhausted(mgr, `msg-aa-${sfx}`, `root-aa-${sfx}`, `kickoff-aa-${sfx}`);
      check("(AA) (setup) the deferral marker was recorded",
        db.listEventsForWorker(mgr).some((e) => e.kind === "session_message_gave_up" && e.detail?.outcome === "deferred"));

      // The session exits (archiveOnExit) BEFORE the recheck timer ever fires.
      sessions.archiveOnExit(db.getSession(mgr));
      mock.timers.tick(pending.windowMs - pending.sinceMs + 1_000);

      check("(AA) archiveOnExit cleared the timer — no manager_kickoff_dropped event is ever recorded",
        db.listEventsForWorker(mgr).filter((e) => e.kind === "manager_kickoff_dropped").length === 0);
    } finally {
      mock.timers.reset();
    }
    db.setProcessState(lead, "exited");
  }

  // ===================== (BB) item 3 / item 2 (Code Review 3f198d0c): a turn started by something OTHER
  // than the kickoff's own confirmation (e.g. human typing, a Lead session_message) permanently suppresses
  // the drop — the SAME accepted residual b03e636c already documents for the worker boot path. ============
  {
    process.env.LOOM_DEV = "1";
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `mkgd-bb-mgr-${sfx}`, lead = `mkgd-bb-lead-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: lead, role: "platform" });
    pty.setLive(mgr); pty.setLive(lead); pty.setPastBoot(lead);

    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    try {
      pty.setLiveStartedAt(mgr, Date.now() - 1_000);
      const pending = withinKickoffConfirmWindow(pty, mgr, 0);
      sessions.handleKickoffGiveUpExhausted(mgr, `msg-bb-${sfx}`, `root-bb-${sfx}`, `kickoff-bb-${sfx}`);

      // Something OTHER than the kickoff's own confirmation starts a turn mid-window (no real transcript
      // written — this is NOT a late confirmation of the kickoff itself, just unrelated activity).
      pty.firstTurnStarted.add(mgr);
      mock.timers.tick(pending.windowMs - pending.sinceMs + 1_000);

      check("(BB) the generic stand-down fires on hasFirstTurnStarted alone — no manager_kickoff_dropped event, even though the kickoff itself never actually confirmed",
        db.listEventsForWorker(mgr).filter((e) => e.kind === "manager_kickoff_dropped").length === 0);
    } finally {
      mock.timers.reset();
    }
    db.setProcessState(lead, "exited");
  }

  // ===================== (DD) Round 5 (card 3d72900f, SF-1): THE REAL BOOT PATH — recoverCrashOrphanedWorkers.
  // index.ts runs this method, NEVER resumeFleetOnBoot, whenever no RestartIntent was captured (card
  // 9fc41af5) — the ONLY path a non-self-host install, and the end-user Platform Lead, actually takes.
  // `deriveCrashOrphanedManagers` never filters on turnSeq, so a manager/Lead whose kickoff never landed
  // reaches the SAME unconditional per-manager summary nudge (SF-2's own shape) unless this escalation
  // intercepts it first. The manager also carries a REAL crash-orphaned worker candidate so its own
  // `computeWakeImpact` is forced non-no-op (liveWorkersResumed>0) — otherwise a solo manager with ZERO
  // worker candidates would already be a silent bystander regardless of the escalation (card c9e51581),
  // making the "no nudge" result vacuous exactly like (Y)'s own original defect. ========================
  {
    process.env.LOOM_DEV = "1";
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `mkgd-dd-mgr-${sfx}`, wkr = `mkgd-dd-wkr-${sfx}`, lead = `mkgd-dd-lead-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr, taskId: null });
    mkSession({ id: lead, role: "platform" });
    pty.setLive(mgr); pty.setLive(wkr); pty.setLive(lead); pty.setPastBoot(lead);
    const rootMsgId = `root-dd-${sfx}`, msgId = `msg-dd-${sfx}`;
    appendDeferredMarker(db, mgr, null, msgId, rootMsgId, "manager");

    const candidates = [{ workerSessionId: wkr, managerSessionId: mgr, reportedState: null, awaitingReview: false }];
    const result = sessions.recoverCrashOrphanedWorkers(candidates, { resumeOne: () => ({ ok: true }) });
    // enqueueDurableNudge defers a worker/manager-role nudge via pty.waitForMcpSeen().then(dispatch) — a
    // microtask hop; flush before reading pty.sent (same reasoning as every resumeFleetOnBoot test above).
    await flush();

    check("(DD) THE FIX: escalateDeferredManagerKickoffAtBoot fired via the REAL recoverCrashOrphanedWorkers path",
      db.listEventsForWorker(mgr).filter((e) => e.kind === "manager_kickoff_dropped" && e.detail?.rootMsgId === rootMsgId).length === 1);
    check("(DD) the worker was still resumed normally — the escalation only skips the MANAGER-level summary, not the per-worker loop",
      result.resumed.includes(wkr));
    const workerNudges = pty.sent.filter((s) => s.id === wkr);
    check("(DD) the worker still got its own continuation nudge", workerNudges.length === 1);
    const mgrSummaryNudges = pty.sent.filter((s) => s.id === mgr && /^\[loom:(crash-recovered|daemon-restarted)\]/.test(s.text));
    check("(DD) the MANAGER's own summary nudge is SUPPRESSED ENTIRELY — the escalation ran INSTEAD of it, not alongside it",
      mgrSummaryNudges.length === 0);
    db.setProcessState(lead, "exited");
  }

  // (DD-without-marker): the SAME fixture shape (a real worker candidate forcing non-no-op impact) but
  // with NO deferred marker — proves (DD)'s suppressed summary nudge was the escalation's doing, not some
  // other reason a solo-with-one-worker manager might stay silent. ==========================================
  {
    process.env.LOOM_DEV = "1";
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `mkgd-dd2-mgr-${sfx}`, wkr = `mkgd-dd2-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr, taskId: null });
    pty.setLive(mgr); pty.setLive(wkr);

    const candidates = [{ workerSessionId: wkr, managerSessionId: mgr, reportedState: null, awaitingReview: false }];
    sessions.recoverCrashOrphanedWorkers(candidates, { resumeOne: () => ({ ok: true }) });
    await flush();

    check("(DD-without-marker) NO manager_kickoff_dropped event — there was no marker to escalate",
      db.listEventsForWorker(mgr).filter((e) => e.kind === "manager_kickoff_dropped").length === 0);
    const mgrSummaryNudges = pty.sent.filter((s) => s.id === mgr && /^\[loom:(crash-recovered|daemon-restarted)\]/.test(s.text));
    check("(DD-without-marker) WITHOUT the escalation, the manager DOES get its summary nudge — same fixture, proving (DD)'s silence was the escalation's doing",
      mgrSummaryNudges.length === 1);
  }

  // (EE) Round 5 (card 3d72900f)'s own crash-path busy-capture correction: `db.getSession(mgr)?.busy` is
  // ALWAYS false by the time recoverCrashOrphanedWorkers runs in production (recoverStaleSessions() zeroes
  // it first, in index.ts's runBootRecoveryPrefix, well before this method ever runs) — so the PERSISTED
  // row is left false here (simulating that reality), and ONLY the `busyAtCrashByManagerId` map (the
  // pre-flip capture `index.ts` builds from recoverStaleSessions()'s own pre-UPDATE `recovered` snapshot)
  // carries the real pre-crash busy state through. If this method wrongly read the live persisted row
  // instead, it would see `false` and NOT stand down — RED under the pre-fix code that read
  // `db.getSession(managerId)?.busy` directly. ================================================================
  {
    process.env.LOOM_DEV = "1";
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `mkgd-ee-mgr-${sfx}`, wkr = `mkgd-ee-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" }); // persisted busy stays FALSE — recoverStaleSessions() already zeroed it
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr, taskId: null });
    pty.setLive(mgr); pty.setLive(wkr);
    const rootMsgId = `root-ee-${sfx}`, msgId = `msg-ee-${sfx}`;
    appendDeferredMarker(db, mgr, null, msgId, rootMsgId, "manager");

    const candidates = [{ workerSessionId: wkr, managerSessionId: mgr, reportedState: null, awaitingReview: false }];
    sessions.recoverCrashOrphanedWorkers(candidates, {
      resumeOne: () => ({ ok: true }),
      busyAtCrashByManagerId: new Map([[mgr, true]]), // the PRE-flip capture: this manager WAS busy at crash time
    });

    check("(EE) the PRE-FLIP captured busy flag stands the crash-path escalation down — no event, even though the PERSISTED row reads false",
      db.listEventsForWorker(mgr).filter((e) => e.kind === "manager_kickoff_dropped").length === 0);
    check("(EE) (sanity) the persisted row really is false — the stand-down above cannot be credited to a live busy read",
      db.getSession(mgr)?.busy === false);
  }

  // (EE-without-capture): the SAME fixture as (EE) but with NO `busyAtCrashByManagerId` map passed at all
  // — proves (EE)'s stand-down was the CAPTURED value's doing, not some fixture-wide default (a map
  // omitted entirely must behave as "not busy at crash", so the escalation fires normally here). =========
  {
    process.env.LOOM_DEV = "1";
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `mkgd-ee2-mgr-${sfx}`, wkr = `mkgd-ee2-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr, taskId: null });
    pty.setLive(mgr); pty.setLive(wkr);
    const rootMsgId = `root-ee2-${sfx}`, msgId = `msg-ee2-${sfx}`;
    appendDeferredMarker(db, mgr, null, msgId, rootMsgId, "manager");

    const candidates = [{ workerSessionId: wkr, managerSessionId: mgr, reportedState: null, awaitingReview: false }];
    sessions.recoverCrashOrphanedWorkers(candidates, { resumeOne: () => ({ ok: true }) }); // no busyAtCrashByManagerId at all

    check("(EE-without-capture) WITHOUT a captured busy map, the SAME fixture escalates normally — proving (EE)'s silence was the captured value's doing",
      db.listEventsForWorker(mgr).filter((e) => e.kind === "manager_kickoff_dropped" && e.detail?.rootMsgId === rootMsgId).length === 1);
  }

  // (EE-queued): the crash path's OTHER discriminator, hasQueuedPending — read LIVE from the real
  // `listUnresolvedQueuedMessagesForWorker` store (never a captured snapshot; this field has no
  // "already zeroed" hazard the way busy does). A real unresolved `session_message_queued` row for the
  // manager stands the escalation down. ======================================================================
  {
    process.env.LOOM_DEV = "1";
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `mkgd-ee3-mgr-${sfx}`, wkr = `mkgd-ee3-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr, taskId: null });
    pty.setLive(mgr); pty.setLive(wkr);
    const rootMsgId = `root-ee3-${sfx}`, msgId = `msg-ee3-${sfx}`;
    appendDeferredMarker(db, mgr, null, msgId, rootMsgId, "manager");
    db.appendEvent({
      id: `evt-queued-ee3-${sfx}`, ts: now, managerSessionId: mgr, workerSessionId: mgr, taskId: null,
      kind: "session_message_queued", detail: { msgId: `queued-ee3-${sfx}` },
    });

    const candidates = [{ workerSessionId: wkr, managerSessionId: mgr, reportedState: null, awaitingReview: false }];
    sessions.recoverCrashOrphanedWorkers(candidates, { resumeOne: () => ({ ok: true }) });

    check("(EE-queued) a real unresolved session_message_queued row stands the crash-path escalation down — no event",
      db.listEventsForWorker(mgr).filter((e) => e.kind === "manager_kickoff_dropped").length === 0);
  }

  // (EE-queued-without-marker): the SAME fixture as (EE-queued) but with NO queued row — proves the
  // stand-down above was the queued row's doing, not a property of the fixture. ============================
  {
    process.env.LOOM_DEV = "1";
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `mkgd-ee4-mgr-${sfx}`, wkr = `mkgd-ee4-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr, taskId: null });
    pty.setLive(mgr); pty.setLive(wkr);
    const rootMsgId = `root-ee4-${sfx}`, msgId = `msg-ee4-${sfx}`;
    appendDeferredMarker(db, mgr, null, msgId, rootMsgId, "manager");

    const candidates = [{ workerSessionId: wkr, managerSessionId: mgr, reportedState: null, awaitingReview: false }];
    sessions.recoverCrashOrphanedWorkers(candidates, { resumeOne: () => ({ ok: true }) });

    check("(EE-queued-without-marker) WITHOUT the queued row, the SAME fixture escalates normally — proving (EE-queued)'s silence was the queued row's doing",
      db.listEventsForWorker(mgr).filter((e) => e.kind === "manager_kickoff_dropped" && e.detail?.rootMsgId === rootMsgId).length === 1);
  }

  db.close();
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card ab3c965d: a MANAGER's turn-1 kickoff give-up-exhaustion now records a durable manager_kickoff_dropped event (role/parentNudged honest, always parentNudged:false) with no re-mint, and gets a best-effort Platform-Lead escalation (board task + live-nudge, generalized via notifyLeadOfParentlessManagerIssue) mirroring handleClaudeBootDialogStuck's own parentless-manager resolution — event-only with no platform-tier home (A), a durable board task even with no live Lead (B), a live-nudge to a live+past-boot Lead while the dropped manager itself NEVER gets a self-nudge (C), dedup across repeated episodes for the same session id (D), both LOOM_DEV states resolving the correct home (E), a worker's own kickoff-drop path is completely unaffected (F), late confirmation (via the pty hook (G) and a real transcript (H)) suppresses the drop, and (round 3) a still-within-window exhaustion defers the drop rather than firing it immediately — suppressed by a late confirmation (I), fired exactly once at the recheck when still unconfirmed (J), and an outside-the-window exhaustion still drops immediately as before (K). Card 5c2f8108 widens this to role \"platform\" — the SAME event, but NEVER escalated to a Lead (L), suppressed by late confirmation (M), deferred-then-fired-once-unconfirmed (N), and dropped immediately outside the window (O) — plus the RESOLVE half (manager_kickoff_dropped_resolved), round 2: a no-op with no prior drop (P), REQUIRES the confirmed rootMsgId to match (Q), pairs against a PLATFORM drop too keyed on its own rootMsgId (R), and is driven by the REAL handleGiveUpConfirmed wiring, at SessionService level (S) with an unrelated confirmation proven NOT to resolve it (T). Round 4 (card 3d72900f) closes the restart-survival gap the deferred (within-window) branch left open: the pending branch now durably records an outcome:\"deferred\" marker before arming the timer (U); the new escalateDeferredManagerKickoffAtBoot boot consumer stands down on role/turnSeq/busy/busyAtCapture/queuedPending/transcript (V) and fires exactly once for either role when every discriminator clears, never twice for an already-dropped session (W); it also stands down when the live timer already dropped it pre-restart (X); it fires INSTEAD OF (never alongside) the ordinary continuation nudge via the real resumeFleetOnBoot path (Y); two simulated boots in a row record exactly one event and nudge the Lead exactly once, proving handleManagerKickoffDropped's Lead-notify is crash-safe (Z); and the live-path residuals are covered too — archiveOnExit clearing the timer before it fires (AA), and an unrelated turn-start permanently suppressing the drop, the SAME accepted shape b03e636c already documents for the worker boot path (BB). Round 5 (a Code Review of round 4) fixes: (V-role) now carries a real deferred marker so the role check is proven against something, not a vacuous no-op (V-role); (Y)/(Y-without-marker) give the subject a genuine hadUnsentDraft nudge-forcing condition instead of an already-silent bystander, proving the escalation (not mere bystander status) suppresses the nudge; (CC1)/(CC2) prove the Lead-notify try/catch against a REAL throw at both the insertTask and nudge-send stages, carrying leadBoardTaskId through the latter; and (DD)/(DD-without-marker) prove the SAME escalation, ordering, and discriminators through the REAL recoverCrashOrphanedWorkers path — the one every non-self-host install and the end-user Platform Lead actually boot through — which round 4 never wired at all. (EE)/(EE-without-capture) prove the crash path's hasBusyAtCapture correctly reads the PRE-FLIP busy value recoverStaleSessions() captures before zeroing the persisted row (round 5's own FIRST attempt at this read the already-zeroed persisted row instead, making the discriminator dead code — a real RED/GREEN regression caught and fixed in this same round), and (EE-queued)/(EE-queued-without-marker) prove hasQueuedPending still reads live from the real queued-message store on this same path."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
