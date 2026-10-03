import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card c1161989 round-2 Code Review finding 1 + 5: `projectMap` (the bulk `getProject` replacement) is
// built ONCE, before Pass A even runs. Pass A's own git awaits run un-awaited (card 460d3178), so a live
// MCP handler outside this function can delete (or rebind) a project WHILE Pass A is mid-flight. Pass
// A2/B must therefore re-resolve `projectMap` FRESH at their own start, exactly like `taskColumnKeyMap`/
// `eventPresenceMap` already do (dd494a9b's own precedent) — never keep reading the Pass-A-era snapshot.
//
// This file proves the Pass B half of that: a worktree whose project was deleted AFTER Pass A's snapshot
// was taken must be SKIPPED by Pass B (never GC'd) — Pass B has no safe way to resolve a repo/identity
// for a project that no longer exists, so its only safe move is to leave the worktree exactly as-is for a
// human/next pass, mirroring every other "can't be sure" case Pass B already fails safe on (a stale
// repoKey, an unresolvable registry entry).
//
// MECHANISM: a spy wraps `Db.prototype.listAllProjectsIncludingArchived` (the exact method the bulk fix
// calls to build `projectMap`). On its FIRST call — Pass A's own snapshot build — it calls through to the
// real implementation, captures that pre-deletion result, THEN calls the real `db.deleteProject(...)` on
// the victim project (a genuine DB delete, run between Pass A's snapshot and whatever rebuilds come
// after), and finally returns the CAPTURED pre-deletion snapshot so Pass A itself still sees the project
// present — exactly modeling "deleted immediately after the snapshot". Every call after the first reads
// the now-genuinely-updated DB, so a FRESH rebuild (the fix) correctly no longer finds it.
//
// `all` (reconcileOrchestrationOnBoot's own session-row snapshot) and our local fixture state are
// captured before the delete runs, so `deleteProject`'s cascade (which also removes the task + session
// rows) never crashes the pass — only the LOOKUP MAPS built from fresh DB reads are affected, which is
// exactly the staleness window this test exists to close.
//
// Two scenarios in one run (separate projects, separate worktrees), same reconcile call:
//   - CONTROL: project never deleted → the clean, 0-commits-ahead worktree IS GC'd (proves the fixture is
//     genuinely GC-eligible to begin with — a positive control for the negative case below).
//   - VICTIM: project deleted right after Pass A's snapshot → the SAME-shaped worktree must survive,
//     untouched, on disk — proving Pass B's fresh rebuild (not the stale Pass-A-era snapshot) decided it.
//
// REAL git on temp repos, NO claude, NO live daemon.
// Run: 1) build daemon, 2) node test/reconcile-pass-b-stale-project-map.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-pb-stalepm-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=pbspm@loom -c user.name=pbspm";
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const now = new Date().toISOString();

const db = new Db();
const sessions = new SessionService(db, {}, new OrchestrationControl());

async function seedProject(tag) {
  const projId = `pbspm-${tag}-proj-${sfx}`, agentId = `pbspm-${tag}-agent-${sfx}`, taskId = `pbspm-${tag}-task-${sfx}`, mgrId = `pbspm-${tag}-mgr-${sfx}`, workerId = `pbspm-${tag}-wkr-${sfx}`;
  const repo = path.join(os.tmpdir(), `loom-pbspm-repo-${tag}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), `# pbspm ${tag}\n`);
  execSync(`git init -q`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  db.insertProject({ id: projId, name: `PBSPM-${tag}`, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: `PBSPM ${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  // Clean, zero-commits-ahead worktree (NO changes made after checkout) — no merge_request was ever
  // filed, so Pass A's own "never requested a merge" early-out requires the worktree to be GONE on disk
  // to fire; here it's present, so Pass A falls through to repoKey resolution + squash detection, finds
  // no Loom-Worker-Branch trailer (nothing was ever landed), and `continue`s WITHOUT adding this worktree
  // to `handledWorktrees` — reaching Pass B untouched, exactly the lookup site this test targets.
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
  return { projId, taskId, mgrId, workerId, repo, worktreePath, branch };
}

const control = await seedProject("control");
const victim = await seedProject("victim");

check("(pre) control worktree present on disk", fs.existsSync(control.worktreePath));
check("(pre) victim worktree present on disk", fs.existsSync(victim.worktreePath));
check("(pre) victim project row exists before the run", !!db.getProject(victim.projId));

// ════════ THE SPY — deletes the victim project right after Pass A's own snapshot captures it ════════
const origListAllProjectsIncludingArchived = Db.prototype.listAllProjectsIncludingArchived;
let callCount = 0;
let deletedAtCall = null;
Db.prototype.listAllProjectsIncludingArchived = function (...a) {
  callCount++;
  const snapshot = origListAllProjectsIncludingArchived.apply(this, a);
  if (callCount === 1) {
    deletedAtCall = callCount;
    this.deleteProject(victim.projId); // genuine DB delete, run between THIS snapshot and anything after it
  }
  return snapshot; // Pass A (this call) still sees the pre-deletion snapshot — "deleted right after the snapshot"
};

const r = await sessions.reconcileOrchestrationOnBoot();

Db.prototype.listAllProjectsIncludingArchived = origListAllProjectsIncludingArchived;

console.log(`\nlistAllProjectsIncludingArchived call count: ${callCount} (deleted right after call #${deletedAtCall})`);
check("victim project row is genuinely gone after the run", !db.getProject(victim.projId));

// ════════ CONTROL — untouched project's clean worktree IS GC'd (proves the fixture shape is GC-eligible) ════════
check("(control) worktree was PRUNED (clean, 0-commits-ahead, project present throughout)", !fs.existsSync(control.worktreePath));

// ════════ VICTIM — the regression-sensitive assertion ════════
// Pre-fix (a single Pass-A-era `projectMap` reused by Pass B unchanged): Pass B would still find the
// victim project present in that stale snapshot, proceed to evaluate `worktreeHasWork` (clean → false),
// and GC the worktree — losing the (correct) opportunity to fail safe on a project that's actually gone.
// Post-fix (Pass B rebuilds `projectMap` fresh at its own start): the fresh rebuild reads the REAL,
// already-deleted DB state, finds no project, and `continue`s — the worktree is left exactly as-is.
check("(victim) worktree SURVIVED on disk (Pass B's fresh projectMap lookup correctly found no project and skipped it)", fs.existsSync(victim.worktreePath));
check("(victim) reconcile recorded NO prune for it (worktreesPruned reflects only the control case)", r.worktreesPruned === 1);

db.close();
try { fs.rmSync(control.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
try { fs.rmSync(victim.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
fs.rmSync(control.repo, { recursive: true, force: true });
fs.rmSync(victim.repo, { recursive: true, force: true });
fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });

console.log(failures === 0
  ? "\n✅ ALL PASS — reconcileOrchestrationOnBoot's Pass B resolves a session's project via a FRESH per-pass lookup, not the Pass-A-era snapshot: a project deleted during Pass A's own git awaits is correctly seen as gone by the time Pass B runs, and its orphaned worktree is left on disk (fail-safe skip) instead of being GC'd against a project that no longer exists."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
