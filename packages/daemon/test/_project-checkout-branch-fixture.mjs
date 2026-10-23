// Shared fixture/helper kit for the `project-checkout-branch-*.mjs` family (card 0b00aa6a — split from the
// former single `project-checkout-branch.mjs`, which ran ~7-10 min / 299 checks and could never fit the
// advisory dist-importer check's per-file run under contention). Card 4fabafd1 / `@decision 2a6a292a`
// rounds 4-6 — `project_checkout_branch`: a manager-initiated checkout switch that re-points the project's
// mainline watermark to the resulting {branch,sha}, so a subsequent landing doesn't need a human reset to
// clear branchDiverted. REAL git on temp repos throughout, across every split file.
//
// Each `project-checkout-branch-*.mjs` file imports from here, calls its OWN `useOwnLoomHome(...)` FIRST
// (LOOM_HOME must be pinned before any `../dist/**` module that reads it is ever loaded — the reason
// `loadPcbDistModules` below is a function, not a top-level await: a static top-level import in THIS module
// would evaluate before the importing file's own `useOwnLoomHome()` call, no matter where the import
// statement is written), then calls {@link loadPcbDistModules} to load the `../dist/**` modules it needs,
// creates its OWN `db = new Db()` (many scenarios call `db.*` directly, not just through a fixture), and
// calls {@link makeFixtureKit} to get its own `makeFixture(label, opts)` factory.
//
// Full round-by-round scenario history (every (TAG) below, which split file it now lives in, and the
// full incident/decision narrative) lives in `docs/decisions/2a6a292a-mainline-watermark-branch-change-
// only-on-a-trusted-signal.md` — this module intentionally does not re-duplicate it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

export { commitAll, registerForCleanup };

export const IDENT = { GIT_AUTHOR_NAME: "pcb", GIT_AUTHOR_EMAIL: "pcb@loom", GIT_COMMITTER_NAME: "pcb", GIT_COMMITTER_EMAIL: "pcb@loom" };
export const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
export const GIT_ID = "-c user.email=pcb@loom -c user.name=pcb";
export const noReap = async () => ({ killedPids: [] });
export const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
export const PASS_GATE = { passed: true, steps: [{ step: "gate", durationMs: 1, status: 0 }] };

export const listToolNames = async (server) => {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st)]);
  const client = new Client({ name: "pcb-test", version: "0" });
  await client.connect(ct);
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  await client.close();
  return names;
};
export const parse = (res) => JSON.parse(res.content[0].text);
export async function callTool(server, name, args) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st)]);
  const client = new Client({ name: "pcb-test", version: "0" });
  await client.connect(ct);
  const out = parse(await client.callTool({ name, arguments: args }));
  await client.close();
  return out;
}

/** Dynamically imports every `../dist/**` module some split of this family needs — called by each split
 *  file AFTER its own `useOwnLoomHome(...)`, mirroring the original single file's import ordering. Every
 *  split destructures only the subset of the returned object it actually uses. `requireHermeticEnv()`
 *  first is the fail-closed backstop the createworktree-loom-home-guard/merge-quarantine-loom-home-guard
 *  static guards require (this module's own `makeFixtureKit` reaches a real `createWorktree(`) — every
 *  caller has already called `useOwnLoomHome` by this point, so this never trips in practice. */
export async function loadPcbDistModules() {
  requireHermeticEnv();
  const { Db } = await import("../dist/db.js");
  const { SessionService } = await import("../dist/sessions/service.js");
  const { OrchestrationControl } = await import("../dist/orchestration/control.js");
  const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
  const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
  const { createWorktree } = await import("../dist/git/worktrees.js");
  const { clearMergeQuarantine, enterMergeQuarantine } = await import("../dist/git/merge-quarantine.js");
  const { withCanonicalIndexLock } = await import("../dist/git/repo-lock.js");
  const { GitWriter, unsafeBranchNameReason } = await import("../dist/git/writer.js");
  const MW = await import("../dist/git/mainline-watch.js");
  return {
    Db, SessionService, OrchestrationControl, OrchestrationMcpRouter, PlatformMcpRouter, createWorktree,
    clearMergeQuarantine, enterMergeQuarantine, withCanonicalIndexLock, GitWriter, unsafeBranchNameReason, MW,
  };
}

/** Builds the `makeFixture(label, opts)` factory each scenario calls to get its own fresh repo + project +
 *  manager (+ optional platform session) — most scenarios get their OWN, so laundering/alert/dirty-tree/
 *  unmerged-worker mutations never contaminate another scenario's own watermark/marker state. `db` is the
 *  CALLER's own `new Db()` (several scenarios also call `db.*` directly); `mods` is {@link loadPcbDistModules}'s
 *  return value. */
export function makeFixtureKit(db, mods) {
  const { SessionService, OrchestrationControl, OrchestrationMcpRouter, createWorktree, MW } = mods;
  let fxSeq = 0;
  function makeFixture(label, opts = {}) {
    const sfx = `${Date.now()}-${++fxSeq}-${Math.random().toString(36).slice(2, 6)}`;
    const repo = opts.repoPath ?? path.join(os.tmpdir(), `loom-pcb-${label}-${sfx}`);
    if (!opts.repoPath) {
      fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
      fs.writeFileSync(path.join(repo, "README.md"), "# pcb\n");
      git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "pcb@loom"); git(repo, "config", "user.name", "pcb");
      commitAll(repo, "init", GIT_ID);
    }
    const main = opts.repoPath ? null : git(repo, "rev-parse", "--abbrev-ref", "HEAD");
    const now = new Date().toISOString();
    const projId = `pcb-${label}-proj-${sfx}`, agentId = `pcb-${label}-agent-${sfx}`, mgrId = `pcb-${label}-mgr-${sfx}`;
    db.insertProject({ id: projId, name: label, repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    let pfmId;
    if (opts.withPlatform) {
      pfmId = `pcb-${label}-pfm-${sfx}`;
      db.insertSession({ id: pfmId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "platform" });
    }
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, runGate: async () => PASS_GATE, reapWorktreeProcesses: noReap });
    const orch = new OrchestrationMcpRouter(db, sessions);
    const canonHead = () => git(repo, "rev-parse", "HEAD");
    const canonBranch = () => { try { return git(repo, "symbolic-ref", "--short", "HEAD"); } catch { return null; } };
    const wKey = MW.mainlineWatermarkKey(projId, "primary");
    const watermark = () => MW.parseMainlineWatermark(db.getMeta(wKey));
    const trust = (branch) => db.getMainlineBranchTrust(projId, "primary", branch);
    const alertKey = MW.mainlineBootAlertKey(projId, "primary");
    const mwEvents = () => db.listEventsSince(0, 100000).filter((e) => e.kind === "mainline_moved_outside_loom" && e.detail?.projectId === projId);
    /** Directly stamp a branch's trust record, bypassing the tool — the owner-adopt / already-landed-
     *  elsewhere shortcut most scenarios use so they can test their OWN concern (a gate, a dirty tree, an
     *  unmerged worker, …) without first routing through create:true or a real landing. */
    const trustBranch = (branch) => db.setMainlineBranchTrust(projId, "primary", branch, git(repo, "rev-parse", branch));
    let wseq = 0;
    async function addWorker(tag) {
      const n = `${label}${tag}${++wseq}`;
      const taskId = `pcb-${n}-task-${sfx}`, workerId = `pcb-${n}-wkr-${sfx}`;
      db.insertTask({ id: taskId, projectId: projId, title: `feat(x): change ${n}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
      const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
      registerForCleanup(worktreePath);
      fs.writeFileSync(path.join(worktreePath, `${n}.ts`), `export const ${n} = 1;\n`);
      commitAll(worktreePath, `feat(x): change ${n}`, GIT_ID);
      db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
      return { taskId, workerId, worktreePath, branch };
    }
    const call = (toolName, args) => callTool(orch.buildServer(mgrId, "manager"), toolName, args);
    return { label, repo, projId, agentId, mgrId, pfmId, sessions, orch, main, canonHead, canonBranch, watermark, trust, trustBranch, alertKey, mwEvents, addWorker, call };
  }
  return { makeFixture };
}
