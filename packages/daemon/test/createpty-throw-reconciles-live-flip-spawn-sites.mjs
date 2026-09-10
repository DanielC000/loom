import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 8b194419 (Code Review finding #1 on 6ca4155f): coverage gap — every 6ca4155f/fa1b77c1 test that
// exercises the "live-flip then synchronous throw" invariant injects a PRE-pty throw (monkeypatching a
// statement that runs BEFORE pty.spawn, e.g. resolveCodescapeInjectionStatus/stampProjectMemoryDigest).
// None of them makes pty.spawn/createPty ITSELF throw — the real-world Windows `error code: 206` class
// (card bc91e86c) the reconcileFailedSpawn helper's own doc names. For FIVE live-flip spawn sites —
// startAuditor, startWorkspaceAuditor, startSetup, startOperator, startRun — the try wraps ONLY the
// pty.spawn call (plus, for startRun, composeRunStartupPrompt's own JSON.stringify/trim, which cannot
// throw for the plain string/schema inputs used below): there is NO OTHER pre-pty statement a
// "pre-pty-throw" test could monkeypatch, so a createPty-itself throw is the ONLY way to reach these
// catches at all. This file drives all five through a seam host whose createPty() throws once per call.
//
// recyclePlatformLead is DELIBERATELY NOT included here, despite being named in the card body's list of
// six: platform-lead-recycle-prespawn-throw-restores-old.mjs (added in the SAME commit as this card's
// dependency, 37e87a6e) already drives recyclePlatformLead's own spawn through a genuine createPty()
// throw (its own header says so explicitly: "recyclePlatformLead's try wraps ONLY the pty.spawn call
// itself — no other synchronous pre-pty step exists at this site to patch instead"). Re-deriving that
// coverage here would duplicate an existing, already-passing test rather than close a real gap — the
// card body's own list was evidently written against an earlier state of the 6ca4155f branch, before
// that file existed; verified by reading the test file itself and its own commit, not assumed.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: a REAL Db + SessionService driven against a FAKE
// pty (createPty() seam) and a real temp git repo (startRun's createRunSnapshot needs a real HEAD to
// snapshot). The throw is forced by a `throwOnNextSpawn` latch consumed by createPty on its NEXT call —
// each entry point below performs exactly one pty.spawn call, so this reaches precisely that call.
//
// Run: 1) build (turbo builds shared first), 2) node test/createpty-throw-reconciles-live-flip-spawn-sites.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpHome = path.join(os.tmpdir(), `loom-cpts-${Date.now()}-${process.pid}`);
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
const { runSnapshotDir } = await import("../dist/runs/snapshot.js");

const repo = path.join(os.tmpdir(), `loom-cpts-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# createpty-throw-reconciles-live-flip-spawn-sites test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=cpts@loom -c user.name=cpts");

const now = new Date().toISOString();
const db = new Db();

const INJECTED_MESSAGE = "injected createPty throw (createpty-throw-reconciles-live-flip-spawn-sites test)";
let throwOnNextSpawn = false;
// Card 8b194419 (Code Review follow-up #3 on this same card): captured the INSTANT createPty is invoked,
// synchronously, so a poll further down can't race it — proves the snapshot dir genuinely existed at
// throw time, so the later `!fs.existsSync(...)` assertion can't pass VACUOUSLY (a dir that never existed
// looks identical to one that was successfully GC'd).
let cwdExistedAtThrow;
class SeamHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    if (throwOnNextSpawn) {
      throwOnNextSpawn = false;
      cwdExistedAtThrow = fs.existsSync(opts.cwd);
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

db.insertProject({ id: "pX", name: "X", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agentAudit", projectId: "pX", name: "Audit", startupPrompt: "AUDIT", position: 0, profileId: null });
db.insertAgent({ id: "agentWsAudit", projectId: "pX", name: "WsAudit", startupPrompt: "WSAUDIT", position: 1, profileId: null });
db.insertAgent({ id: "agentSetup", projectId: "pX", name: "Setup", startupPrompt: "SETUP", position: 2, profileId: null });
db.insertAgent({ id: "agentOperator", projectId: "pX", name: "Operator", startupPrompt: "OPERATOR", position: 3, profileId: null });
db.insertAgent({ id: "agentRun", projectId: "pX", name: "Run", startupPrompt: "RUN_DOCTRINE", position: 4, profileId: null, endpoint: true, ioSchema: null });

/** Drive one synchronous start* entry point through a forced createPty throw and return its session row. */
function driveSyncEntry(label, agentId, fn) {
  throwOnNextSpawn = true;
  let err;
  try { fn(); } catch (e) { err = e; }
  check(`(setup precondition) [${label}] the injected createPty throw actually propagated out`,
    !!err && String(err.message).includes(INJECTED_MESSAGE));
  check(`(setup precondition) [${label}] throwOnNextSpawn was consumed (fired exactly once, at this entry's own spawn)`,
    throwOnNextSpawn === false);
  const rows = db.listSessions(agentId);
  check(`(setup precondition) [${label}] exactly one session row was created despite the throw`, rows.length === 1);
  const row = rows[0];
  check(`[${label}] session row ends processState:'exited', NOT stranded 'live', after a createPty throw`,
    row?.processState === "exited");
  check(`[${label}] session row's lastError carries the injected throw's own message`,
    typeof row?.lastError === "string" && row.lastError.includes(INJECTED_MESSAGE));
  return row;
}

try {
  driveSyncEntry("startAuditor", "agentAudit", () => svc.startAuditor("agentAudit"));
  driveSyncEntry("startWorkspaceAuditor", "agentWsAudit", () => svc.startWorkspaceAuditor("agentWsAudit"));
  driveSyncEntry("startSetup", "agentSetup", () => svc.startSetup("agentSetup"));
  driveSyncEntry("startOperator", "agentOperator", () => svc.startOperator("agentOperator"));

  // startRun is async and additionally owns a RUN row + a disposable snapshot dir (card 8b194419, item 4)
  // — neither of which reconcileFailedSpawn touches (it only knows about the SESSION row). A real
  // keyId+idempotencyKey is seeded (not left null, as a bare startRun call would default it) so the
  // per-key in-flight slot and idempotency-replay assertions below exercise the REAL query paths
  // (countInFlightRunsForKey/getRunByIdempotency), rather than a vacuously-true `?? null` fallback.
  const RUN_KEY_ID = "cpts-key-1";
  const RUN_IDEMPOTENCY_KEY = "cpts-idem-1";
  throwOnNextSpawn = true;
  let runErr;
  let runId, sessionId;
  try {
    await svc.startRun({ agentId: "agentRun", input: { q: "ping" }, schema: null, keyId: RUN_KEY_ID, idempotencyKey: RUN_IDEMPOTENCY_KEY });
  } catch (e) {
    runErr = e;
  }
  check("(setup precondition) [startRun] the injected createPty throw actually propagated out",
    !!runErr && String(runErr.message).includes(INJECTED_MESSAGE));
  check("(setup precondition) [startRun] throwOnNextSpawn was consumed (fired exactly once, at this entry's own spawn)",
    throwOnNextSpawn === false);
  const sessionRows = db.listSessions("agentRun");
  check("(setup precondition) [startRun] exactly one session row was created despite the throw", sessionRows.length === 1);
  sessionId = sessionRows[0]?.id;
  check("[startRun] session row ends processState:'exited', NOT stranded 'live', after a createPty throw",
    sessionRows[0]?.processState === "exited");
  check("[startRun] session row's lastError carries the injected throw's own message",
    typeof sessionRows[0]?.lastError === "string" && sessionRows[0].lastError.includes(INJECTED_MESSAGE));

  const runRows = db.listRuns("pX");
  check("(setup precondition) [startRun] exactly one run row was created despite the throw", runRows.length === 1);
  runId = runRows[0]?.id;
  check("[startRun] run row ends status:'failed', NOT stranded 'starting' (item 4's own fix)",
    db.getRun(runId)?.status === "failed");
  check("[startRun] run row's error carries the injected throw's own message",
    typeof db.getRun(runId)?.error === "string" && db.getRun(runId).error.includes(INJECTED_MESSAGE));
  check("(setup precondition) [startRun] the run row actually carries the seeded keyId + idempotencyKey (proves the two checks below exercise the REAL key, not a null/absent no-op)",
    runRows[0]?.keyId === RUN_KEY_ID && runRows[0]?.idempotencyKey === RUN_IDEMPOTENCY_KEY);
  check("[startRun] the in-flight-runs count for this run's key no longer holds a phantom slot",
    db.countInFlightRunsForKey(RUN_KEY_ID) === 0);
  check("[startRun] an idempotency replay for this (key, idempotencyKey) pair no longer returns the dead run",
    db.getRunByIdempotency(RUN_KEY_ID, RUN_IDEMPOTENCY_KEY) === undefined);

  // the disposable snapshot dir was created (createRunSnapshot ran, BEFORE the forced throw — proven by
  // cwdExistedAtThrow, captured synchronously inside createPty itself, so the poll below can't trivially
  // pass against a dir that never existed) then best-effort GC'd by the catch (item 4's own
  // `void removeRunSnapshot(...)` — async, so poll briefly for it).
  check("(setup precondition) [startRun] the snapshot dir genuinely existed at the instant of the throw (createRunSnapshot ran first)",
    cwdExistedAtThrow === true);
  let gone = false;
  // TIMING-GUARD-SAFE: bounded poll of a real observable condition (fs.existsSync), not a guessed sleep
  // duration — the identical, pre-existing shape agent-runs-primitive.mjs's own snapshot-GC polls use.
  for (let i = 0; i < 40 && !gone; i++) { if (!fs.existsSync(runSnapshotDir(sessionId))) gone = true; else await sleep(25); }
  check("[startRun] the disposable snapshot dir was GC'd immediately by the catch, ahead of the next boot sweep", gone);
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a synchronous createPty (not just a pre-pty statement) throw at startAuditor/startWorkspaceAuditor/startSetup/startOperator/startRun each reconciles their session row to 'exited' (not phantom-live); startRun additionally fails its run row immediately and GCs its snapshot dir instead of leaking both until next boot."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
