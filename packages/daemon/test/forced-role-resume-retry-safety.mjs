import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card aa82caed — retry-safety for resume()'s forced-role-to-claude redirect (resumeForcedRoleAsFreshClaude,
// card 7955458e ruling 1(b)). Before this card, Db.setSessionHarness(undefined) ran BEFORE pty.spawn and
// never cleared the stale codex engineSessionId, so EITHER of two narrow windows left the row permanently
// stranded as resumability:"dead" (both resume()'s own transcript-exists guard AND the independent, earlier
// boot sweepDeadSessions would mark it dead, since BOTH key off `harness=claude paired with a codex engine
// id that doesn't exist under claude's transcript store`):
//   WINDOW 1 — the fresh claude pty.spawn itself throws (reconcileFailedSpawn catches, rethrows).
//   WINDOW 2 — the daemon dies after pty.spawn returns but before the fresh claude session's own
//     SessionStart hook fires and overwrites engineSessionId via Db.setEngineSessionId.
// See docs/decisions/aa82caed-forced-role-resume-retry-safety.md for the full design + rejected alternatives.
//
// RED ON 30fd9249 (the commit named in the card as the pre-fix baseline) — proven directly below by
// checking out db.ts/service.ts at that revision, rebuilding, and confirming WINDOW 1's own check fails,
// before restoring the real (fixed) sources and rebuilding again.
//
// DETERMINISTIC + CLAUDE/CODEX-FREE: a real Db + SessionService against a fake pty (the shared seam
// fixture), mirroring codex-role-force-start-matrix.mjs's own (RESUME) section.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

const tmpHome = path.join(os.tmpdir(), `loom-frrs-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
process.env.LOOM_CODEX_BIN = path.join(tmpHome, "no-such-codex-binary");
// Isolate codex's OWN transcript root too (codex-doctrine.ts's realCodexHome() re-reads CODEX_HOME fresh
// on every call — never cached — so setting it before any dist import below is enough, same pattern as
// transcript-harness-dispatch.mjs). Needed so WINDOW 1's sweepDeadSessions check is a REAL discriminator
// (a genuine codex rollout file resolves true under harness "codex", false under "claude") rather than
// vacuously true either way because no transcript exists under EITHER harness.
const tmpCodexHome = path.join(tmpHome, "codex-home");
fs.mkdirSync(tmpCodexHome, { recursive: true });
process.env.CODEX_HOME = tmpCodexHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { sweepDeadSessions } = await import("../dist/sessions/liveness.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const repo = path.join(os.tmpdir(), `loom-frrs-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# forced-role-resume-retry-safety test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=frrs@loom -c user.name=frrs");

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pX", name: "X", repoPath: repo, vaultPath: repo, config: { orchestration: { maxConcurrentWorkers: 50 }, permission: { startupModeCycles: 0 } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: "aForResume", projectId: "pX", name: "aForResume", startupPrompt: "x", position: 0, profileId: null });

// A SeamHost whose createPty() can be told to throw ONCE (simulating WINDOW 1 — the fresh claude spawn
// itself failing) via `.failNextCreatePty`, then behaves normally afterward.
class SeamHost extends createSeamHost(PtyHost) {
  constructor(events) { super(events); this.spawned = []; this.failNextCreatePty = false; }
  createPty(opts) {
    this.spawned.push({ ...opts, viaCodex: false });
    if (this.failNextCreatePty) { this.failNextCreatePty = false; throw new Error("simulated fresh-claude spawn failure"); }
    return super.createPty(opts);
  }
  createCodexPty() { throw new Error("MUST NEVER REACH createCodexPty in this test"); }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());
const optsFor = (sid) => host.spawned.filter((o) => o.sessionId === sid).pop();
const forcedEvent = (workerSessionId) => db.listEvents(workerSessionId).find((e) => e.kind === "harness_role_forced_claude" && e.workerSessionId === workerSessionId);

const codexConversationId = "window1-codex-conversation-id";
const resumeRow = (id, extra = {}) => db.insertSession({
  id, projectId: "pX", agentId: "aForResume", engineSessionId: codexConversationId, title: null, cwd: repo,
  processState: "exited", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "manager", harness: "codex", gen: 0, ...extra,
});

try {
  // ---------------- WINDOW 1: the fresh claude pty.spawn itself throws ----------------
  const w1 = "window1-manager";
  resumeRow(w1);

  // A REAL codex rollout file for codexConversationId, same confirmed shape
  // transcript-harness-dispatch.mjs's own fixture uses — this is what lets (W1)'s sweepDeadSessions
  // check actually discriminate "harness still codex" (resolves true) from the OLD bug's "harness
  // already claude, paired with this same id" (resolves false — a codex id means nothing to claude's
  // own resolver) rather than being vacuously dead either way.
  const codexDayDir = path.join(tmpCodexHome, "sessions", "2026", "09", "07");
  fs.mkdirSync(codexDayDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDayDir, `rollout-2026-09-07T00-00-00-${codexConversationId}.jsonl`),
    JSON.stringify({ type: "session_meta", payload: { session_id: codexConversationId, cwd: repo, originator: "codex-tui" } }) + "\n",
  );
  host.failNextCreatePty = true;
  let threw = null;
  try { svc.resume(w1); } catch (e) { threw = e; }
  check("(W1) resume() rethrows the simulated spawn failure", threw?.message === "simulated fresh-claude spawn failure");
  check("(W1) row's harness is UNCHANGED (still codex) after the failed attempt", db.getSession(w1).harness === "codex");
  check("(W1) row's engineSessionId is UNCHANGED (still the real codex id) after the failed attempt", db.getSession(w1).engineSessionId === codexConversationId);
  check("(W1) processState reconciled to exited (reconcileFailedSpawn), not left phantom-live", db.getSession(w1).processState === "exited");
  check("(W1) row is NOT marked dead by the failed attempt itself", db.getSession(w1).resumability !== "dead");

  const marked1 = sweepDeadSessions(db);
  check("(W1) boot sweepDeadSessions does NOT mark the row dead either (harness still codex, matching its own stale engine id's harness)", db.getSession(w1).resumability !== "dead");

  // Retry: this time the spawn succeeds — resume() must re-enter the SAME redirect from scratch.
  const resumed1 = svc.resume(w1);
  check("(W1 RETRY) same session id in, same id out", resumed1.id === w1);
  check("(W1 RETRY) re-enters the redirect and boots: harness corrected to claude in the DB", db.getSession(w1).harness === undefined);
  check("(W1 RETRY) returned Session reflects the correction + live", resumed1.harness === undefined && resumed1.processState === "live");
  check("(W1 RETRY) a FRESH spawn via createPty, never createCodexPty, never a --resume of the old codex id", optsFor(w1)?.viaCodex === false && optsFor(w1)?.resumeId === undefined);
  check("(W1 RETRY) harness_role_forced_claude filed with trigger:resume", forcedEvent(w1)?.detail.role === "manager" && forcedEvent(w1)?.detail.trigger === "resume");
  check("(W1 RETRY) row never went dead across the whole throw -> retry cycle", db.getSession(w1).resumability !== "dead");
  // The stale codex engineSessionId must be cleared in the SAME write as the flip (not merely left for a
  // later SessionStart to overwrite) — the seam host's fake pty never fires onEngineSessionId, so nothing
  // else could have cleared or overwritten this field; a non-null value here can only mean the flip ran
  // without the clear.
  check("(W1 RETRY) the stale codex engineSessionId is cleared in the same write as the flip", db.getSession(w1).engineSessionId === null);

  // ---------------- WINDOW 2: daemon dies after a successful spawn, before SessionStart ----------------
  // Manufacture the exact post-flip/pre-SessionStart state the FIXED code leaves behind when this happens:
  // harness already corrected to claude (undefined), but engineSessionId cleared to null (never yet
  // overwritten by the real id, since that only happens once SessionStart fires) — never the OLD bug's
  // state (harness=claude PAIRED WITH the stale codex id), which is what used to get marked dead.
  const w2 = "window2-manager";
  db.insertSession({
    id: w2, projectId: "pX", agentId: "aForResume", engineSessionId: null, title: null, cwd: repo,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager", harness: undefined, gen: 0,
  });
  const marked2 = sweepDeadSessions(db);
  check("(W2) boot sweepDeadSessions does NOT mark a null-engine-id row dead (short-circuits on the falsy id)", db.getSession(w2).resumability !== "dead");
  let threw2 = null;
  try { svc.resume(w2); } catch (e) { threw2 = e; }
  check("(W2) resume() throws the ORDINARY no-engine-id-yet error, never the dead-marking transcript-missing one", /no engine id to resume/.test(threw2?.message ?? ""));
  check("(W2) row is STILL NOT marked dead after that resume() attempt", db.getSession(w2).resumability !== "dead");

  // CONTROL: an ordinary (never-codex) fresh claude manager row that crashed before its own first
  // SessionStart lands in the SAME (harness:claude, engineSessionId:null) shape — proves WINDOW 2's fix
  // doesn't depend on anything codex-specific; it's the SAME pre-existing "no engine id yet" handling.
  const control = "window2-control-ordinary";
  db.insertSession({
    id: control, projectId: "pX", agentId: "aForResume", engineSessionId: null, title: null, cwd: repo,
    processState: "exited", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager", gen: 0,
  });
  let threwControl = null;
  try { svc.resume(control); } catch (e) { threwControl = e; }
  check("(W2 CONTROL) an ordinary never-codex row with no engine id throws the SAME ordinary error", /no engine id to resume/.test(threwControl?.message ?? ""));
} finally {
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the forced-role-to-claude redirect is retry-safe across both the spawn-throws and crash-before-SessionStart windows; neither window strands the row as dead."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
