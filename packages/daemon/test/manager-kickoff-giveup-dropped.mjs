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
// RED-BEFORE-GREEN (this project's own standing verification posture): run against the PRE-FIX
// `handleKickoffGiveUpExhausted` (role==="manager" still falling into the generic bail) — (A)'s
// `manager_kickoff_dropped` event assertion fails (nothing is ever recorded for a manager), and so do
// (B)/(C)/(D)/(E), which all depend on that event/the Lead-escalation call ever firing at all. Run against
// ROUND-1 code (the manager carve-out ungated by `lateConfirmation`) — (G)/(H) fail: a board task IS
// filed and the Lead IS nudged for a session that only confirmed late. Run against ROUND-2 code (the
// manager carve-out gated by `lateConfirmation` but with no `withinKickoffConfirmWindow` check at all,
// this round's own CR finding #2) — (I) fails: its "deferred, NOT dropped on the first exhaustion"
// assertion is false, since round-2 drops immediately regardless of the window.
//
// RUN: pnpm build (from packages/daemon) then `node test/manager-kickoff-giveup-dropped.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

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

  db.close();
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card ab3c965d: a MANAGER's turn-1 kickoff give-up-exhaustion now records a durable manager_kickoff_dropped event (role/parentNudged honest, always parentNudged:false) with no re-mint, and gets a best-effort Platform-Lead escalation (board task + live-nudge, generalized via notifyLeadOfParentlessManagerIssue) mirroring handleClaudeBootDialogStuck's own parentless-manager resolution — event-only with no platform-tier home (A), a durable board task even with no live Lead (B), a live-nudge to a live+past-boot Lead while the dropped manager itself NEVER gets a self-nudge (C), dedup across repeated episodes for the same session id (D), both LOOM_DEV states resolving the correct home (E), a worker's own kickoff-drop path is completely unaffected (F), late confirmation (via the pty hook (G) and a real transcript (H)) suppresses the drop, and (round 3) a still-within-window exhaustion defers the drop rather than firing it immediately — suppressed by a late confirmation (I), fired exactly once at the recheck when still unconfirmed (J), and an outside-the-window exhaustion still drops immediately as before (K)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
