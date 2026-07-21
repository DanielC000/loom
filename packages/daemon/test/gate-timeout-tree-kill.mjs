import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Gate-timeout process-TREE kill (card 3564fd1e — the 2026-07-21 fleet-wide gate-timeout-SIGKILL leak: a
// hanging vitest test's gate got killed on timeout, but only the SHELL died — the vitest fork-pool
// grandchildren survived every kill/retry, and enough immortal survivors accumulated to saturate the host
// into a fleet-wide gate death spiral). REAL spawn test throughout: this is a subprocess/OS-boundary
// feature — a mocked exec would never exercise the actual cross-platform tree-kill.
//
// Proves, in two tiers:
//   (tree-kill)     runGateStep (gate-runner.ts): a gate step that spawns a real grandchild and then hangs
//                   forever itself is killed by our own `timeoutMs` bound — and the GRANDCHILD, not just
//                   the shell, is ACTUALLY GONE afterward (win32: `taskkill /pid <child.pid> /T /F`;
//                   posix: `detached:true` + a process-group `SIGKILL`).
//   (no-fratricide) SessionService.confirmWorkerMerge, end-to-end with a REAL gateCommand that genuinely
//                   times out in a REAL worktree (card 3564fd1e refinement A): a "worker-lookalike"
//                   process rooted in that SAME worktree (standing in for the confirming worker's own
//                   live claude pty, excluded via the stubbed `pty.getPid`) SURVIVES the whole confirm,
//                   while a genuinely STRAY process — also rooted in the worktree, NOT excluded, NOT part
//                   of the gate's own process tree at all — is swept.
// Run: 1) build daemon (pnpm build), 2) node test/gate-timeout-tree-kill.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawn as spawnProcess } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-gtk-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { runGateStep } = await import("../dist/orchestration/gate-runner.js");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitUntil = async (cond, timeoutMs, stepMs = 100) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await sleep(stepMs);
  }
  return cond();
};
const GIT_ID = "-c user.email=gtk@loom -c user.name=gtk";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const q = (p) => `"${p}"`; // quote a path for both cmd.exe and posix sh

// ============================== (tree-kill) real hanging gate step + a real grandchild ==============================
{
  const scratchDir = path.join(os.tmpdir(), `loom-gtk-scratch-${sfx}`);
  fs.mkdirSync(scratchDir, { recursive: true });
  const pidFile = path.join(scratchDir, "grandchild.pid");
  // The "gate step": spawns a plain (non-detached — mirrors a real vitest fork-pool worker, which does
  // NOT detach) grandchild that writes its own pid to a file then hangs, then hangs FOREVER ITSELF too —
  // the two-level shape of the real incident (shell -> pnpm -> vitest fork-pool), collapsed to shell ->
  // node -> node for a deterministic, fast-to-verify test.
  const parentScript = path.join(scratchDir, "parent.cjs");
  fs.writeFileSync(parentScript, [
    'const { spawn } = require("node:child_process");',
    'const fs = require("node:fs");',
    `const gc = spawn(${JSON.stringify(process.execPath)}, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });`,
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(gc.pid));`,
    "setInterval(() => {}, 1000);",
  ].join("\n"));
  const command = `${q(process.execPath)} ${q(parentScript)}`;
  const timeoutMs = 1000;
  const started = Date.now();
  const result = await runGateStep(command, scratchDir, timeoutMs);
  const elapsed = Date.now() - started;
  check("(tree-kill) our own timeout bound fires: timedOut:true", result.timedOut === true);
  check("(tree-kill) the settled-race resolves promptly (well under 10x the timeout bound, never hangs the test)",
    elapsed < timeoutMs * 10);

  await waitUntil(() => fs.existsSync(pidFile), 5000);
  const grandchildPid = Number(fs.readFileSync(pidFile, "utf8").trim());
  check("(tree-kill) the grandchild pid file was actually written (the grandchild really started)",
    Number.isFinite(grandchildPid) && grandchildPid > 0);
  const gcGone = await waitUntil(() => !isAlive(grandchildPid), 5000);
  check("(tree-kill) the GRANDCHILD is ACTUALLY GONE after the timeout kill — not just the shell (the bug this fixes)", gcGone);

  try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
}

// ============================== (no-fratricide) end-to-end via SessionService.confirmWorkerMerge ==============================
{
  const repo = path.join(os.tmpdir(), `loom-gtk-repo-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# gtk\n");
  execSync(`git init -q && git config user.email gtk@loom && git config user.name gtk && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });

  const projId = `gtk-proj-${sfx}`, agentId = `gtk-agent-${sfx}`, taskId = `gtk-task-${sfx}`, mgrId = `gtk-mgr-${sfx}`, workerId = `gtk-wkr-${sfx}`;
  const db = new Db();
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);

  // The gateCommand itself hangs forever (same shape as tier 1's parent.cjs, minus the grandchild —
  // that's already proven above; here the point is proving the SERVICE layer's excludePids wiring).
  const gateCommand = `${q(process.execPath)} -e "setInterval(()=>{},1000)"`;
  db.insertProject({ id: projId, name: "GTK", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand, gateCommandTimeoutMs: 1200 } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "GTK-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  fs.writeFileSync(path.join(worktreePath, "feature.txt"), "work\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "feature.txt"`, { cwd: worktreePath });
  db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

  // "worker-lookalike": a REAL process rooted in the SAME worktree — standing in for the confirming
  // worker's own live claude pty. Must SURVIVE because its pid is excluded (via the stubbed pty.getPid
  // below), exactly as the real confirmWorkerMerge excludes the confirming worker's own pid.
  const lookalikeScript = path.join(worktreePath, "lookalike.js");
  fs.writeFileSync(lookalikeScript, "setInterval(() => {}, 1000);\n");
  const lookalike = spawnProcess(process.execPath, [lookalikeScript], { cwd: worktreePath, stdio: "ignore" });

  // A genuinely STRAY process — also rooted in the worktree, but NOT excluded and NOT part of the gate's
  // own process tree at all (started completely independently, e.g. an escaped dev-server). Must be SWEPT.
  const strayScript = path.join(worktreePath, "stray.js");
  fs.writeFileSync(strayScript, "setInterval(() => {}, 1000);\n");
  const stray = spawnProcess(process.execPath, [strayScript], { cwd: worktreePath, stdio: "ignore" });

  try {
    await sleep(400);
    check("(no-fratricide) the worker-lookalike is alive before the gate runs", isAlive(lookalike.pid));
    check("(no-fratricide) the stray process is alive before the gate runs", isAlive(stray.pid));

    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {}, getPid: (sid) => (sid === workerId ? lookalike.pid : undefined) };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

    const confirmResult = await sessions.confirmWorkerMerge(mgrId, workerId);
    check("(no-fratricide) the gate genuinely timed out (real spawn, real timeout — not a mocked result)",
      confirmResult.merged === false && confirmResult.gateDetail?.timedOut === true);

    const strayGone = await waitUntil(() => !isAlive(stray.pid), 8000);
    check("(no-fratricide) the STRAY process (rooted in the worktree, not excluded) is SWEPT after the timeout", strayGone);

    await sleep(600);
    check("(no-fratricide) the WORKER-LOOKALIKE (excluded via pty.getPid) SURVIVES the exact same sweep — no fratricide", isAlive(lookalike.pid));
  } finally {
    try { if (isAlive(lookalike.pid)) process.kill(lookalike.pid, "SIGKILL"); } catch { /* ignore */ }
    try { if (isAlive(stray.pid)) process.kill(stray.pid, "SIGKILL"); } catch { /* ignore */ }
    db.close();
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a gate timeout kills the REAL process tree (grandchildren included, not just the shell), and the service-layer worktree sweep that backstops it correctly excludes the confirming worker's own process while still sweeping a genuinely stray one — no fratricide."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
