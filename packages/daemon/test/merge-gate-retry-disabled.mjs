import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Merge-gate retry ENV-DISABLE test (card bcba83a1's env-overridable retry knob; sweep G3 promoted the
// knob itself from a gate-runner.js module constant to a live-resolvable OrchestrationConfig.gateRetry —
// see @loom/shared's resolveConfig). HERMETIC, no daemon. Proves LOOM_GATE_RETRY_ENABLED=0 actually takes
// effect end-to-end: a transient-kill classification that would normally auto-retry (see
// merge-gate-retry.mjs case B) instead reports IMMEDIATELY, with a distinct "auto-retry disabled" outcome
// note, and the gate runner is called exactly ONCE. Sweep G3 note: the env var is now read LIVE inside
// resolveConfig on every confirmWorkerMerge call, not at gate-runner.js's first import, so the historical
// "must set before first import" ordering constraint this file used to be built around no longer applies
// — it stays its own process/file regardless, for isolation from the other gate-retry env-var tests.
// Run: 1) build daemon (pnpm build), 2) node test/merge-gate-retry-disabled.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mgrd-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
process.env.LOOM_GATE_RETRY_ENABLED = "0";

const { resolveConfig } = await import("@loom/shared");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mgrd@loom -c user.name=mgrd";
const now = new Date().toISOString();

// Config-level proof the env var is actually disabling the policy (mirrors the old module-const check,
// but against the now-authoritative resolved config instead of a since-removed gate-runner.js export).
check("(config) resolveConfig reads gateRetry.enabled=false with LOOM_GATE_RETRY_ENABLED=0",
  resolveConfig(undefined).orchestration.gateRetry.enabled === false);

const db = new Db();
const enqueued = [];
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin(...args) { enqueued.push(args); } };
let calls = 0;
const fakeGate = async () => { calls++; return { passed: false, failedStep: "pnpm gate", failedStatus: null, failedSignal: "SIGKILL", failedTimedOut: false, outputTail: "" }; };
const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });

const p = {
  projId: "mgrd-proj", agentId: "mgrd-agent", taskId: "mgrd-task", mgrId: "mgrd-mgr", workerId: "mgrd-wkr",
  repo: path.join(os.tmpdir(), `loom-mgrd-repo-${Date.now()}`), file: "feature.txt",
};

try {
  fs.mkdirSync(p.repo, { recursive: true });
  fs.writeFileSync(path.join(p.repo, "README.md"), "# mgrd\n");
  execSync(`git init -q && git config user.email mgrd@loom && git config user.name mgrd && git add . && git ${GIT_ID} commit -q -m init`, { cwd: p.repo });
  const { worktreePath, branch } = await createWorktree(p.repo, p.projId, p.taskId);
  p.worktreePath = worktreePath; p.branch = branch;
  fs.writeFileSync(path.join(worktreePath, p.file), "work\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "${p.file}"`, { cwd: worktreePath });

  db.insertProject({ id: p.projId, name: "MGRD", repoPath: p.repo, vaultPath: p.repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "MGRD-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });

  const confirm = await sessions.confirmWorkerMerge(p.mgrId, p.workerId);
  check("(disabled) exactly ONE gate call — no retry attempted despite a kill classification", calls === 1);
  check("(disabled) reason still names the kill classification, but notes auto-retry is disabled",
    confirm.reason === "gate killed by SIGKILL (possibly OOM/resource) — auto-retry disabled");
  check("(disabled) NO build_gate_retry_attempt event fired", db.listEvents(p.mgrId).filter((e) => e.kind === "build_gate_retry_attempt").length === 0);
  const rejectMsgs = enqueued.filter((args) => args[0] === p.mgrId && typeof args[1] === "string" && args[1].includes("[loom:merge-rejected]"));
  check("(disabled) the pty text also names 'auto-retry disabled'", rejectMsgs[0]?.[1]?.includes("auto-retry disabled"));
} finally {
  db.close();
  try { if (p.worktreePath) fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — LOOM_GATE_RETRY_ENABLED=0 disables the auto-retry end-to-end: the gate runs exactly once and the rejection names the kill classification with an explicit 'auto-retry disabled' outcome."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
