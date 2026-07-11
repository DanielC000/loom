import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Scoped per-project DEPLOY (design [[Scoped Per-Project Deploy — Design]], 13235b62) — a manager's
// own-project outward-exec primitive, mirroring `gateCommand`'s trust posture exactly. HERMETIC +
// CLAUDE-FREE (real Db + SessionService against a no-op fake pty and an INJECTED `runGate` seam — no
// real host exec — in the style of merge-gate-retry.mjs / mgr-own-project-scope.mjs).
//
// Proves, per the task's DoD:
//   (a) the agent-facing config validator REJECTS orchestration.deployCommand/deployCommandTimeoutMs
//       (human-only), while the human/REST validator accepts + round-trips both.
//   (b) the `deploy` tool (sessions.deployOwnProject) REFUSES when the project has no deployCommand
//       configured — no host exec attempted (runGate never called), no `deploy` audit event emitted.
//   (c) with a deployCommand configured, deploy RUNS the command in the caller's OWN project's repoPath
//       (never a worker worktree, never an agent-supplied path), bounded by deployCommandTimeoutMs, and
//       emits a `deploy` audit event under the calling manager carrying the outcome — both for a
//       SUCCESSFUL run (ok:true) and a FAILED one (ok:false + exitCode/outputTail surfaced back to the
//       caller too).
//   (d) a per-manager-session sliding-window RATE LIMIT caps repeated deploys: the (MAX+1)th attempt
//       inside the window is refused with no host exec and no additional audit event, while an EARLIER
//       manager session (a different sliding window) is unaffected.
//   (e) deploy is a MANAGER-ONLY surface (defense in depth, mirrors requireManager elsewhere) — a worker
//       session is rejected outright.
// Run: 1) build (turbo builds shared first), 2) node test/deploy-own-project.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-deploy-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "45419";
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { validateProjectConfigOverride, validateAgentProjectConfigOverride } = await import("../dist/mcp/platform.js");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { DEPLOY_RATE_LIMIT_MAX, __resetDeployRateLimitState } = await import("../dist/orchestration/deploy.js");

const now = new Date().toISOString();
const eventsOfKind = (db, id, kind) => db.listEvents(id).filter((e) => e.kind === kind);

try {
  // ══════════════════════════ (a) config validator: HUMAN-only ══════════════════════════
  {
    const agentAttempt = validateAgentProjectConfigOverride({ orchestration: { deployCommand: "git push" } });
    check("(a) agent path REJECTS orchestration.deployCommand", agentAttempt.ok === false);
    check("(a) agent-path rejection names deployCommand", agentAttempt.ok === false && /deployCommand/.test(agentAttempt.error));

    const agentTimeoutAttempt = validateAgentProjectConfigOverride({ orchestration: { deployCommandTimeoutMs: 60000 } });
    check("(a) agent path REJECTS orchestration.deployCommandTimeoutMs", agentTimeoutAttempt.ok === false);

    const humanAttempt = validateProjectConfigOverride({ orchestration: { deployCommand: "git push", deployCommandTimeoutMs: 60000 } });
    check("(a) human/REST path ACCEPTS deployCommand + deployCommandTimeoutMs", humanAttempt.ok === true);
    check("(a) human path round-trips deployCommand unchanged",
      humanAttempt.ok && humanAttempt.value.orchestration?.deployCommand === "git push");
    check("(a) human path round-trips deployCommandTimeoutMs unchanged",
      humanAttempt.ok && humanAttempt.value.orchestration?.deployCommandTimeoutMs === 60000);

    // A valid agent override that ALSO carries deployCommand is rejected as a whole (.strict()).
    check("(a) agent path: an otherwise-valid override + deployCommand is rejected wholesale",
      validateAgentProjectConfigOverride({ docLint: false, orchestration: { deployCommand: "curl evil" } }).ok === false);
  }

  // ══════════════════════════ (b)-(e) sessions.deployOwnProject ══════════════════════════
  const db = new Db(path.join(tmpHome, "loom.db"));
  const pty = { enqueueStdin: () => ({ delivered: false }) };

  // The runGate seam: records every invocation and returns whatever `nextResult` currently holds
  // (a hermetic stand-in for runGateSequential — no real process is ever spawned).
  const calls = [];
  let nextResult = { passed: true };
  const fakeRunGate = async (gate, cwd, timeoutMs) => {
    calls.push({ gate, cwd, timeoutMs });
    return nextResult;
  };
  const svc = new SessionService(db, pty, new OrchestrationControl(), { runGate: fakeRunGate });

  const reposRoot = path.join(tmpHome, "repos");
  fs.mkdirSync(reposRoot, { recursive: true });

  // pUnconfigured: a project with NO deployCommand (default config).
  const repoUnconf = path.join(reposRoot, "unconfigured");
  fs.mkdirSync(repoUnconf, { recursive: true });
  db.insertProject({ id: "pUnconf", name: "Unconfigured", repoPath: repoUnconf, vaultPath: repoUnconf, config: {}, createdAt: now, archivedAt: null, reserved: false });
  db.insertAgent({ id: "aUnconf", projectId: "pUnconf", name: "Dev", startupPrompt: "", position: 0, profileId: null });
  db.insertSession({ id: "mUnconf", projectId: "pUnconf", agentId: "aUnconf", engineSessionId: null, title: null, cwd: repoUnconf, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", parentSessionId: null });

  // pDeploy: a project WITH a configured deployCommand.
  const repoDeploy = path.join(reposRoot, "deploy");
  fs.mkdirSync(repoDeploy, { recursive: true });
  db.insertProject({ id: "pDeploy", name: "Deployable", repoPath: repoDeploy, vaultPath: repoDeploy, config: { orchestration: { deployCommand: "echo deploying && git push", deployCommandTimeoutMs: 45000 } }, createdAt: now, archivedAt: null, reserved: false });
  db.insertAgent({ id: "aDeploy", projectId: "pDeploy", name: "Dev", startupPrompt: "", position: 0, profileId: null });
  db.insertSession({ id: "mDeploy", projectId: "pDeploy", agentId: "aDeploy", engineSessionId: null, title: null, cwd: repoDeploy, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", parentSessionId: null });
  // A WORKER in the same project — used for the manager-only gate (e).
  db.insertSession({ id: "wDeploy", projectId: "pDeploy", agentId: "aDeploy", engineSessionId: null, title: null, cwd: repoDeploy, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: "mDeploy" });

  // ── (b) refuses when unconfigured — no host exec, no audit event ──
  const unconf = await svc.deployOwnProject("mUnconf", "test deploy");
  check("(b) refuses when no deployCommand configured", unconf.deployed === false);
  check("(b) refusal reason names deployCommand", /deployCommand/.test(unconf.reason ?? ""));
  check("(b) runGate was NEVER invoked (no host exec attempted)", calls.length === 0);
  check("(b) no 'deploy' audit event was recorded for the refused attempt", eventsOfKind(db, "mUnconf", "deploy").length === 0);

  // ── (c) configured deploy: SUCCESS runs the command in the caller's OWN repoPath + emits the audit event ──
  nextResult = { passed: true };
  const ok1 = await svc.deployOwnProject("mDeploy", "ship it");
  check("(c) deploy SUCCEEDS when configured + green", ok1.deployed === true);
  check("(c) runGate was invoked exactly once", calls.length === 1);
  check("(c) runGate ran the project's configured deployCommand", calls[0].gate === "echo deploying && git push");
  check("(c) runGate ran in the project's OWN repoPath (never a worktree)", calls[0].cwd === repoDeploy);
  check("(c) runGate was bounded by the project's deployCommandTimeoutMs", calls[0].timeoutMs === 45000);
  const deployEvents1 = eventsOfKind(db, "mDeploy", "deploy");
  check("(c) exactly one 'deploy' audit event was recorded", deployEvents1.length === 1);
  check("(c) the audit event carries ok:true + the caller's reason", deployEvents1[0].detail?.ok === true && deployEvents1[0].detail?.reason === "ship it");

  // ── (c cont'd) configured deploy: FAILURE surfaces exitCode/outputTail both to the caller and the audit event ──
  nextResult = { passed: false, failedStatus: 2, outputTail: "remote: rejected\nerror: failed to push" };
  const fail1 = await svc.deployOwnProject("mDeploy", "ship it again");
  check("(c) a failed run reports deployed:false", fail1.deployed === false);
  check("(c) a failed run's reason is 'deploy command failed'", fail1.reason === "deploy command failed");
  check("(c) a failed run surfaces the exit code to the caller", fail1.exitCode === 2);
  check("(c) a failed run surfaces the output tail to the caller", /rejected/.test(fail1.outputTail ?? ""));
  const deployEvents2 = eventsOfKind(db, "mDeploy", "deploy");
  check("(c) the failed attempt ALSO emits a 'deploy' audit event (ok:false)", deployEvents2.length === 2 && deployEvents2[1].detail?.ok === false);
  check("(c) the failed audit event carries the exit code", deployEvents2[1].detail?.exitCode === 2);

  // ── (d) rate limit: this manager session has now deployed twice; drive it to the cap ──
  nextResult = { passed: true };
  for (let i = calls.length /* already 2 real attempts counted */; i < DEPLOY_RATE_LIMIT_MAX; i++) {
    // eslint-disable-next-line no-await-in-loop
    const r = await svc.deployOwnProject("mDeploy", `fill ${i}`);
    check(`(d) attempt ${i + 1}/${DEPLOY_RATE_LIMIT_MAX} within the window still succeeds`, r.deployed === true);
  }
  const callsBeforeCap = calls.length;
  const evtsBeforeCap = eventsOfKind(db, "mDeploy", "deploy").length;
  check(`(d) exactly ${DEPLOY_RATE_LIMIT_MAX} real deploy attempts have run so far`, callsBeforeCap === DEPLOY_RATE_LIMIT_MAX);
  const capped = await svc.deployOwnProject("mDeploy", "one too many");
  check("(d) the (MAX+1)th attempt within the window is REFUSED", capped.deployed === false);
  check("(d) the rate-limit refusal names the cap", /rate limit/.test(capped.reason ?? ""));
  check("(d) the rate-limited attempt did NOT reach runGate (no host exec)", calls.length === callsBeforeCap);
  check("(d) the rate-limited attempt emits NO additional 'deploy' audit event",
    eventsOfKind(db, "mDeploy", "deploy").length === evtsBeforeCap);

  // A DIFFERENT manager session (its own sliding window) is unaffected by mDeploy's cap.
  db.insertSession({ id: "mDeploy2", projectId: "pDeploy", agentId: "aDeploy", engineSessionId: null, title: null, cwd: repoDeploy, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", parentSessionId: null });
  const otherMgr = await svc.deployOwnProject("mDeploy2", "unrelated manager, fresh window");
  check("(d) a DIFFERENT manager session's own rate-limit window is unaffected", otherMgr.deployed === true);

  __resetDeployRateLimitState();

  // ── (e) manager-only surface — a worker is rejected, no host exec, no write ──
  const callsBeforeWorkerAttempt = calls.length;
  let workerMsg = null;
  try {
    await svc.deployOwnProject("wDeploy", "worker trying to deploy");
  } catch (e) {
    workerMsg = e instanceof Error ? e.message : String(e);
  }
  check("(e) a WORKER session is REJECTED (deploy is manager-only)", workerMsg !== null && /manager-only/.test(workerMsg));
  check("(e) the rejected worker attempt never reached runGate (no host exec)", calls.length === callsBeforeWorkerAttempt);

  db.close();
} finally {
  __resetDeployRateLimitState();
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* retry (WAL handle) */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — deployCommand/deployCommandTimeoutMs are HUMAN-only on the agent validator; the `deploy` tool refuses with no host exec when unconfigured, runs the project's OWN deployCommand in its OWN repoPath + emits a `deploy` audit event on both success and failure, is capped by a per-manager-session sliding-window rate limit (unaffected by an unrelated manager's own window), and is a manager-only surface."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
