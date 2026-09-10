import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// recyclePlatformLead PHANTOM-DOUBLE-EXITED on a pre-pty synchronous throw (card 6ca4155f, Code Review
// follow-up).
//
// recyclePlatformLead's own "ATOMIC LINEAGE HANDOFF" comment retires the OLD Lead row to 'exited' FIRST,
// then inserts + flips the FRESH successor row 'live', THEN calls pty.spawn — but the old Lead's real
// PTY PROCESS is not stopped until a deferred 3s setTimeout further below, reached only on a SUCCESSFUL
// spawn. So if pty.spawn throws synchronously (createPty itself, e.g. a Windows CreateProcess failure),
// the fresh row is correctly reconciled to 'exited' by reconcileFailedSpawn (card 6ca4155f) — but the OLD
// row is ALSO left 'exited', while its real process is genuinely still alive and running. Both DB rows
// then read 'exited' for a lineage with one real live process: the Code Reviewer flagged this as a
// second defect the shared helper alone doesn't cover — the catch must also restore the old row to
// 'live' before rethrowing, since the old pty was never actually touched.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: a REAL Db + SessionService driven against a FAKE
// pty (createPty()/stop() seam, mirroring platform-lead-recycle.mjs's proven harness). The throw is
// forced by making createPty itself throw for the RECYCLE's spawn only (the predecessor's own initial
// spawn, via startPlatformLead, succeeds normally) — the most faithful reproduction of the real defect
// class (a synchronous createPty failure), since recyclePlatformLead's try wraps ONLY the pty.spawn call
// itself (no other synchronous pre-pty step exists at this site to patch instead).
//
// Run: 1) build (turbo builds shared first), 2) node test/platform-lead-recycle-prespawn-throw-restores-old.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-lprt-${Date.now()}-${process.pid}`);
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

const repo = path.join(os.tmpdir(), `loom-lprt-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# platform-lead-recycle-prespawn-throw-restores-old test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=lprt@loom -c user.name=lprt");

const now = new Date().toISOString();
const db = new Db();

const INJECTED_MESSAGE = "injected createPty throw (platform-lead-recycle-prespawn-throw-restores-old test)";
let throwOnNextSpawn = false;
class SeamHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    if (throwOnNextSpawn) {
      throwOnNextSpawn = false;
      throw new Error(INJECTED_MESSAGE);
    }
    return super.createPty(opts);
  }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

db.insertProject({ id: "pHome", name: "Loom Platform", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: true });
db.insertAgent({ id: "agentLead", projectId: "pHome", name: "Platform", startupPrompt: "LEAD WARMUP", position: 0, profileId: null });

try {
  // The predecessor's OWN initial spawn must succeed (throwOnNextSpawn is false) — it's the RECYCLE's
  // spawn that must fail, to isolate the defect to that path.
  const pred = svc.startPlatformLead("agentLead");
  check("(setup precondition) the predecessor Lead is live before recycle", pred.processState === "live");

  // card 08320d02: a pending wake on the PREDECESSOR, scheduled before the recycle attempt — proves the
  // catch does NOT cancel it (unlike recycleWorker's): the old Lead's pty is never stopped before a
  // pre-spawn throw here (the atomic handoff's own row-flip back to 'live', asserted below, is the
  // proof its process was never touched), so its wakes must keep firing normally.
  db.insertWake({ id: "wakeOldLead1", sessionId: pred.id, wakeAt: now, note: "self-note", createdAt: now });

  throwOnNextSpawn = true;
  let recycleError;
  try {
    await svc.recyclePlatformLead(pred.id, "HANDOFF: forcing a pre-spawn throw on the recycle's own spawn");
  } catch (e) {
    recycleError = e;
  }

  check("(setup precondition) the injected createPty throw actually propagated out of recyclePlatformLead",
    !!recycleError && String(recycleError.message).includes(INJECTED_MESSAGE));
  check("(setup precondition) throwOnNextSpawn was consumed (the throw fired exactly once, at the recycle's own spawn)",
    throwOnNextSpawn === false);

  // The fresh successor row exists (insertSession ran before the throw, per the atomic-handoff ordering)
  // — find it via listAllSessionsIncludingArchived rather than db.getSuccessor (card 4be56c33:
  // reconcileFailedSpawn now NULLS the failed row's own recycled_from, so a post-failure
  // getSuccessor(pred.id) no longer finds it — that's the fix under test, not a regression) or
  // listSessions(agentId) — card 08320d02 now archives this same failed row (see the item-1 assertion
  // below), and listSessions filters archived_at IS NULL.
  const successor = db.listAllSessionsIncludingArchived().find((s) => s.agentId === "agentLead" && s.id !== pred.id);
  check("(setup precondition) a fresh successor row was created for the predecessor despite the throw", !!successor);

  check("successor row ends processState:'exited', NOT stranded 'live', after the pre-spawn throw (reconcileFailedSpawn)",
    successor?.processState === "exited");
  check("successor row's lastError carries the injected throw's own message",
    typeof successor?.lastError === "string" && successor.lastError.includes(INJECTED_MESSAGE));
  check("successor row's own recycledFrom is NULLED by the catch (card 4be56c33's fix's third effect)",
    successor?.recycledFrom === null);
  check("the OLD Lead is no longer hasSuccessor()-superseded once its failed successor is unlinked",
    db.hasSuccessor(pred.id) === false);

  // --- card 08320d02, item 1: the failed successor is archived off the live rail ---
  check("(1) the failed successor is archived (archivedAt set)", !!successor?.archivedAt);
  check("(1) listSessions(agentLead) no longer shows the archived, failed successor",
    !db.listSessions("agentLead").some((s) => s.id === successor?.id));

  // --- card 08320d02, item 2: a recycle_failed audit event, filed under the PREDECESSOR (still live) ---
  const failedEvents = db.listEventsForSession(pred.id).filter((e) => e.kind === "recycle_failed");
  check("(2) exactly one recycle_failed event was appended, filed under the predecessor", failedEvents.length === 1);
  const failedDetail = failedEvents[0]?.detail ?? {};
  check("(2) recycle_failed.detail.recycledFrom names the predecessor", failedDetail.recycledFrom === pred.id);
  check("(2) recycle_failed.detail.failedSuccessorId names the dead successor",
    failedDetail.failedSuccessorId === successor?.id);
  check("(2) recycle_failed.detail.error carries the injected error message",
    typeof failedDetail.error === "string" && failedDetail.error.includes(INJECTED_MESSAGE));

  // --- card 08320d02, item 3 (negative): UNLIKE recycleWorker, the predecessor's own pending wake is
  // NOT cancelled here — its process never stopped, so the wake is a real, still-relevant reminder. ---
  check("(3) the predecessor's pending wake is UNTOUCHED (its process was never stopped)",
    db.listWakesForSession(pred.id).length === 1);

  // THE DEFECT THIS TEST GUARDS: the old Lead's row was flipped 'exited' by the atomic handoff BEFORE
  // the throw — but its real pty was NEVER stopped (recyclePlatformLead only schedules that 3s-deferred
  // setTimeout on a SUCCESSFUL spawn, never reached here). Restoring it to 'live' is the honest rollback.
  const predRow = db.getSession(pred.id);
  check("predecessor (old Lead) row is restored to processState:'live' — its real pty was never touched",
    predRow?.processState === "live");
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a synchronous createPty throw during recyclePlatformLead's own spawn leaves the fresh successor row 'exited' (reconcileFailedSpawn) AND restores the old Lead's row to 'live', matching its real, never-stopped pty — never leaving the lineage showing zero live Leads while one is genuinely still running."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
