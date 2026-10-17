import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 8882e2ca (c): `worker_stop`'s result carries an ADVISORY `kickoffConfirmPendingWarning` when the
// stopped worker's turn-1 kickoff was still unconfirmed and inside its size-aware plausible-confirm
// window — the exact race this card's own investigation specimen hit (a real engine confirmation landing
// ~487ms AFTER a worker_stop call). It is advisory only: it never refuses the stop, and `stopped` keeps
// its existing honest meaning (card dde0ce24) regardless of whether the warning fires.
//
// (A) POSITIVE: a worker with turnSeq:0 and a LARGE composerDirtyLen (above the size threshold
//     kickoffConfirmWindowMs scales from) gets the warning, naming the char count and the window.
// (B) NEGATIVE CONTROL 1: the IDENTICAL worker, but with turnSeq already > 0 (it completed a turn) —
//     NOT a turn-1-kickoff-pending case at all — gets NO warning.
// (C) NEGATIVE CONTROL 2: turnSeq:0 but an ORDINARY-sized (or unset) composerDirtyLen — never earns an
//     extended window — gets NO warning. This is the common case: stopping a healthy, already-confirmed,
//     or genuinely-broken worker must stay byte-identical (no new key at all) to before this card.
// (D) The warning is purely ADDITIVE: `stopped`/`reason` are unaffected by whether it fires either way.
//
// Run: 1) build daemon (pnpm build from packages/daemon), 2) node test/worker-stop-kickoff-confirm-pending-warning.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-stop-kickoff-pending-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { kickoffConfirmWindowMs } = await import("../dist/pty/host.js");

const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const db = new Db();
const proj = `wskp-proj-${sfx}`, agent = `wskp-ag-${sfx}`;
db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });

/** Minimal PtyStub — just enough for stopWorker's own call shape (isAlive/stop/getComposerDirtyLen/
 *  liveStartedAt, the two reads withinKickoffConfirmWindow needs) plus whatever
 *  `cancelWorkerGateThenSweep`/`retireWorkerSession` touch (wakes/gate lookups, all empty here). */
class PtyStub {
  constructor() { this.live = new Set(); this.stopped = []; this.composerDirtyLen = new Map(); this.liveStartedAtMap = new Map(); }
  setLive(id, on = true) { if (on) this.live.add(id); else this.live.delete(id); }
  isAlive(id) { return this.live.has(id); }
  stop(id, mode) { this.live.delete(id); this.stopped.push({ id, mode }); }
  getComposerDirtyLen(id) { return this.composerDirtyLen.has(id) ? this.composerDirtyLen.get(id) : undefined; }
  setLiveStartedAt(id, ms) { this.liveStartedAtMap.set(id, ms); }
  liveStartedAt(id) { return this.liveStartedAtMap.has(id) ? this.liveStartedAtMap.get(id) : null; }
}

// Card: `insertSession`'s own INSERT statement has no `turn_seq` column at all — every fresh row starts
// at the DB column default (0) regardless of what's passed in the literal. `incrementTurnSeq` (the real
// production setter, fired on turn completion) is the only way to actually raise it for a test fixture.
const mkSession = (o) => {
  db.insertSession({
    id: o.id, projectId: proj, agentId: agent, engineSessionId: `eng-${o.id}`, title: null, cwd: os.tmpdir(),
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "worker", parentSessionId: o.parentSessionId, taskId: null,
    worktreePath: null, branch: null,
  });
  for (let i = 0; i < (o.turnSeq ?? 0); i++) db.incrementTurnSeq(o.id);
};

try {
  const mgr = `wskp-mgr-${sfx}`;
  db.insertSession({
    id: mgr, projectId: proj, agentId: agent, engineSessionId: `eng-${mgr}`, title: null, cwd: os.tmpdir(),
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });

  // (A) POSITIVE: turnSeq:0, large composerDirtyLen.
  {
    const wkr = `wskp-a-${sfx}`;
    mkSession({ id: wkr, parentSessionId: mgr, turnSeq: 0 });
    const pty = new PtyStub();
    pty.setLive(wkr);
    const LARGE = 69_000;
    pty.composerDirtyLen.set(wkr, LARGE);
    pty.setLiveStartedAt(wkr, Date.now() - 97_000); // realistic PARK-time elapsed for a kickoff this size
    check("(A) sanity: this size genuinely earns a non-zero window", kickoffConfirmWindowMs(LARGE) > 0);
    const sessions = new SessionService(db, pty, new OrchestrationControl());

    const result = await sessions.stopWorker(mgr, wkr, "graceful");
    check("(A) stopped:true (a live pty genuinely existed)", result.stopped === true);
    check("(A) THE FIX: kickoffConfirmPendingWarning is present", typeof result.kickoffConfirmPendingWarning === "string");
    check("(A) names the char count", result.kickoffConfirmPendingWarning.includes(`${LARGE} chars`));
    check("(A) is advisory, not a refusal — explicitly says it did not block the stop",
      /did not block the stop/.test(result.kickoffConfirmPendingWarning));
  }

  // (B) NEGATIVE CONTROL: same large composerDirtyLen, but turnSeq already > 0 (not a turn-1 case at all).
  {
    const wkr = `wskp-b-${sfx}`;
    mkSession({ id: wkr, parentSessionId: mgr, turnSeq: 3 });
    const pty = new PtyStub();
    pty.setLive(wkr);
    pty.composerDirtyLen.set(wkr, 69_000);
    const sessions = new SessionService(db, pty, new OrchestrationControl());

    const result = await sessions.stopWorker(mgr, wkr, "graceful");
    check("(B) NEGATIVE CONTROL: turnSeq > 0 -> no warning even with a large composerDirtyLen reading",
      result.kickoffConfirmPendingWarning === undefined);
  }

  // (C) NEGATIVE CONTROL: turnSeq:0, but ORDINARY-sized (unset) composerDirtyLen — the common case.
  // Code Review 6a497b53 Minor (a): liveStartedAt MUST be set to a RECENT, measured time here — leaving
  // it unset (as this test originally did) makes the predicate return null via the unrelated
  // "unmeasurable" branch, which would pass even WITHOUT the "extended window only" fix this scenario
  // exists to prove. Setting it genuinely exercises "ordinary size, well within the flat floor -> null".
  {
    const wkr = `wskp-c-${sfx}`;
    mkSession({ id: wkr, parentSessionId: mgr, turnSeq: 0 });
    const pty = new PtyStub();
    pty.setLive(wkr);
    pty.setLiveStartedAt(wkr, Date.now() - 10_000); // recent, measured — well inside the flat 60s floor
    // composerDirtyLen left unset -> undefined -> treated as size 0 (never earns an extended window)
    const sessions = new SessionService(db, pty, new OrchestrationControl());

    const result = await sessions.stopWorker(mgr, wkr, "graceful");
    check("(C) NEGATIVE CONTROL: ordinary-sized kickoff, WELL WITHIN the flat floor -> no warning (byte-identical to pre-card)",
      result.kickoffConfirmPendingWarning === undefined);
    check("(C) the result shape otherwise matches the pre-card contract exactly (only stopped, no reason since it was alive)",
      Object.keys(result).sort().join(",") === "stopped");
  }

  // (D) Code Review 6a497b53 Minor (b): the original (D) here fabricated an IMPOSSIBLE production
  // state — `PtyHost.liveStartedAt` (pty/host.ts) returns null whenever `!live.alive`, unconditionally,
  // so a not-live session can NEVER have a measured liveStartedAt in the real PtyHost. Dropped (not
  // rewritten — there is no meaningful not-live-but-measured state to construct); this IS the only
  // not-live case that can ever occur in production: a worker that never started, or already exited,
  // always reads liveStartedAt:null, so the warning can never fire on the `stopped:false` path at all.
  {
    const wkr = `wskp-d-${sfx}`;
    mkSession({ id: wkr, parentSessionId: mgr, turnSeq: 0 });
    const pty = new PtyStub();
    pty.composerDirtyLen.set(wkr, 69_000); // even with a large reading sitting around
    // deliberately NOT marked live AND liveStartedAt left unset — the ONLY reachable not-live shape
    const sessions = new SessionService(db, pty, new OrchestrationControl());

    const result = await sessions.stopWorker(mgr, wkr, "graceful");
    check("(D) ADDITIVE: stopped:false path is unaffected by the warning computation",
      result.stopped === false && result.reason === "no live pty for this session");
    check("(D) NEGATIVE CONTROL: not-live (liveStartedAt structurally null) -> no warning, even with a large composerDirtyLen reading",
      result.kickoffConfirmPendingWarning === undefined);
  }
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 8882e2ca (c): worker_stop's result carries an ADVISORY kickoffConfirmPendingWarning " +
    "exactly when the stopped worker's turn-1 kickoff earned an EXTENDED plausible-confirm window (A); " +
    "absent once the worker completed a turn (B) or for an ordinary-sized kickoff even well within its " +
    "own flat floor (C, Code Review 6a497b53's own decision — the byte-identical common case, no extra " +
    "key at all); and the warning never changes the pre-existing stopped/reason contract, with no warning " +
    "on the only not-live shape that can ever occur in production (liveStartedAt structurally null, D)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
