// Card 40738f24 (round 2 finding #1 on 72c58b1c) — reconcileFailedSpawn must never mark a session row
// 'exited' while `this.pty` still has a genuinely LIVE process for that id.
//
// THE BUG: when PtyHost.spawn() throws AFTER createPty has already registered the live process (this.live
// holds alive:true for the id) — e.g. a post-spawn step that isn't (or isn't yet) made non-fatal —
// SessionService's catch calls reconcileFailedSpawn, which used to unconditionally write
// processState:'exited' with no regard for whether a real process was still running behind that row. That
// strands an ORPHAN live pty under a dead row: the session looks gone to every DB-driven view, but the
// process (and whatever it's doing) keeps running unsupervised until a human notices and kills it by hand.
// 72c58b1c fixed the one KNOWN trigger (onBusy persistence, via persistBusy) — this fix is in the SHARED
// reconcileFailedSpawn helper itself, so it holds for any throw occurring once pty.onExit(cb) has already
// been registered inside PtyHost.spawn() (true for every realistic post-spawn step) — see the helper's
// own doc comment (@decision 40738f24) for the one narrower window this does NOT cover.
//
// THE FIX: reconcileFailedSpawn now checks `this.pty.isAlive(sessionId)` first and, if true, hard-kills it
// (best-effort — a kill() throw must never mask the original spawn failure) before writing 'exited' — so
// "reconcileFailedSpawn ran" keeps meaning "no live session resulted" for every caller, never leaving a
// live orphan process behind a dead row.
//
// REPRO SHAPE: a SeamHost subclass whose spawn() calls the REAL PtyHost.spawn() (so this.live genuinely
// gets set — a real fake-pty "process" is alive) and THEN throws (via a consumed-once throwOnNextSpawn
// latch, armed only around the ONE call meant to hit it) — reproducing "spawn throws after createPty
// already handed back a live process" without depending on any one specific (and since-fixed) trigger.
// Proven RED on the pre-fix reconcileFailedSpawn (temporarily reverted) and GREEN after — see this card's
// own worker_report for the RED/GREEN transcript.
//
// N1 (Code Review 5d6b0561, pinned permanently): the reviewer's own probe proving reconcileFailedSpawn's
// safety precondition — resume() short-circuits on isAlive BEFORE the live-flip, so it never reaches
// pty.spawn() for an already-alive session, and the kill above can therefore never hit a PRE-EXISTING pty
// belonging to a different attempt. A second session is spawned normally, the NEXT spawn is armed to
// throw, then resume()d: no throw, the pty stays alive, zero new exits, the armed throw is never consumed,
// and the row stays 'live' throughout.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: a REAL Db + SessionService driven against the
// shared fake-pty seam (_seam-host-fixture.mjs), which genuinely flips alive->false on kill().
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-rfsko-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const repo = path.join(os.tmpdir(), `loom-rfsko-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# reconcile-failed-spawn-kills-live-orphan test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=rfsko@loom -c user.name=rfsko");

const INJECTED_MESSAGE = "injected post-spawn throw (reconcile-failed-spawn-kills-live-orphan test)";

// Consumed-once latch (mirrors createpty-throw-reconciles-live-flip-spawn-sites.mjs's own
// throwOnNextSpawn technique): armed by the test immediately before the ONE call it's meant to hit, so a
// later, unrelated call (e.g. resume() on an already-alive session, which must never even reach spawn())
// can be proven to have left it untouched.
let throwOnNextSpawn = false;
// The real PtyHost.spawn() runs to completion (this.live genuinely gets set, alive:true, backed by the
// shared fake-pty seam) BEFORE the injected throw — reproducing "spawn throws after createPty already
// handed back a live process" without depending on the (now-fixed) onBusy trigger specifically.
class SeamHost extends createSeamHost(PtyHost) {
  spawn(opts) {
    super.spawn(opts);
    if (throwOnNextSpawn) {
      throwOnNextSpawn = false;
      throw new Error(INJECTED_MESSAGE);
    }
  }
}

const now = new Date().toISOString();
const db = new Db();
let onExitCalls = 0;
const host = new SeamHost({
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { onExitCalls++; db.setProcessState(id, "exited"); db.setBusy(id, false); },
});
const svc = new SessionService(db, host, new OrchestrationControl());

db.insertProject({ id: "pR", name: "R", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agentR", projectId: "pR", name: "R", startupPrompt: "PLAIN_DOCTRINE", position: 0, profileId: null });

try {
  let spawnError;
  let session;
  throwOnNextSpawn = true;
  try {
    session = svc.startNew("agentR");
  } catch (e) {
    spawnError = e;
  }

  check("(setup precondition) the injected post-spawn throw actually propagated out of startNew",
    !!spawnError && String(spawnError.message).includes(INJECTED_MESSAGE));
  check("(setup precondition) startNew returned no session on a throw", session === undefined);

  const rows = db.listSessions("agentR");
  check("(setup precondition) exactly one session row was created despite the throw", rows.length === 1);
  const row = rows[0];

  check("session row ends processState:'exited', NOT stranded 'live'", row?.processState === "exited");
  check("session row's lastError carries the injected throw's own message",
    typeof row?.lastError === "string" && row.lastError.includes(INJECTED_MESSAGE));

  // THE CORE ASSERTION: the pty that super.spawn() genuinely registered as alive must actually be dead
  // now — reconcileFailedSpawn must have killed it, not just written 'exited' over a still-running process.
  check("the pty is genuinely DEAD, not an orphan still alive behind the 'exited' row", host.isAlive(row?.id) === false);
  check("the fake pty's onExit fired exactly once (reconcileFailedSpawn's kill actually reached it)", onExitCalls === 1);

  // ===================== N1 (Code Review 5d6b0561) — the reviewer's own probe, pinned permanently =====
  // reconcileFailedSpawn's safety precondition depends on resume() NEVER reaching pty.spawn() at all for
  // an already-alive session (its isAlive short-circuit runs BEFORE the live-flip, synchronously — see
  // resume()'s own comment). Prove it directly: start a SECOND session normally (genuinely alive), arm
  // the NEXT spawn to throw, then resume() it — the armed throw must never fire (resume() never reaches
  // spawn()), so: no throw, the pty stays alive, zero NEW exits, and the row stays 'live' throughout.
  const session2 = svc.startNew("agentR"); // throwOnNextSpawn is already false (consumed above) — a plain, successful spawn
  const onExitCallsAfterSession2Spawn = onExitCalls;
  check("(N1 setup) a second session spawned normally is genuinely alive", host.isAlive(session2.id) === true);

  throwOnNextSpawn = true; // arm the NEXT spawn — must never actually fire for the resume() below
  let resumeError;
  let resumed;
  try {
    resumed = svc.resume(session2.id);
  } catch (e) {
    resumeError = e;
  }

  check("(N1) resume() on an already-alive session does NOT throw", !resumeError);
  check("(N1) ...and returns the (unchanged) session", resumed?.id === session2.id);
  check("(N1) ...and the armed throw was NEVER consumed — resume() never reached pty.spawn() at all", throwOnNextSpawn === true);
  check("(N1) ...and the pty is STILL alive (never killed, never respawned)", host.isAlive(session2.id) === true);
  check("(N1) ...and NO additional exit fired for this session (0 new exits since it spawned)", onExitCalls === onExitCallsAfterSession2Spawn);
  check("(N1) ...and the DB row is STILL 'live' (reconcileFailedSpawn was never reached, let alone killed anything)",
    db.getSession(session2.id)?.processState === "live");

  throwOnNextSpawn = false; // disarm before cleanup below stops session2 for real
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a spawn() throw AFTER createPty already handed back a live process is reconciled by killing that orphan process, not just marking the row 'exited' over it."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
