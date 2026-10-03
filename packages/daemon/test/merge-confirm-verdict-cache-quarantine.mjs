import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 7e5b23e7 round 2 (Code Review 8cd5e832, MINOR item 2) — `classifyOutcome` never checked
// `outcome.value.quarantined` at all, so a quarantine-class rejection (the entry-time backstop, the
// pre-gate union-merge's `union_merge_quarantined`, and `reunionAtAdmission`'s own
// `union_merge_quarantined_at_admission`) fell through to the plain `"merged" : "rejected"` fallback and
// got cached/replayed like an ordinary rejection — so a plain re-confirm AFTER a human cleared the
// quarantine could replay the stale refusal instead of trying again. The fix (one shared place, not three
// per-site patches): `classifyOutcome` now checks `quarantined` before the fallback, and `"quarantined"`
// is in `NEVER_CACHED_OUTCOMES` (orchestration/pending-ops.ts).
//
// This file exercises the ENTRY-TIME backstop (`assertRepoNotQuarantined`, checked at confirm START,
// before any union-merge or gate lane) — the fastest, most deterministic way to reach the SAME shared
// classifyOutcome/NEVER_CACHED_OUTCOMES chokepoint every quarantine-class rejection routes through. The
// OTHER two sites (the pre-gate union-merge's own kill-confirm, and `reunionAtAdmission`'s admission-time
// re-union) are covered at the git/worktrees.ts layer by union-merge-kill-confirm.mjs's GREEN-2 (proving
// the quarantine itself is raised/pinned correctly) — reproducing an UNCONFIRMED kill through the FULL
// `confirmWorkerMergeTracked` flow would need a REAL 45s+45s give-up window (mergeMainIntoWorktree's own
// `UNION_MERGE_TIMEOUT_FLOOR_MS`, which `SessionService`'s own call site does not expose a test-seam
// override for), making that scenario impractical to exercise fast here; NOT independently reproduced by
// this file. Documented here rather than silently absent — see the round-2 DoD's own test-coverage note.
//
// Exercises `SessionService.confirmWorkerMergeTracked` directly against a REAL git repo/worktree (no
// stubbed git — only the gate command itself is stubbed), mirroring
// merge-confirm-verdict-cache-squash-refusal.mjs's own setup pattern for the sibling fb525c31
// never-cached exception.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-confirm-verdict-cache-quarantine.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mcvcq-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { enterMergeQuarantine, clearMergeQuarantine, activeMergeQuarantineFor } = await import("../dist/git/merge-quarantine.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mcvcq@loom -c user.name=mcvcq";
const now = new Date().toISOString();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mcvcq\n");
  execSync(`git init -q && git config user.email mcvcq@loom && git config user.name mcvcq`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

async function setupWorkerProject(sfx, reposDir, gateCommand = "pnpm gate") {
  registerForCleanup(reposDir);
  const db = new Db();
  const mgrId = `mcvcq-mgr-${sfx}`, projId = `mcvcq-p-${sfx}`, taskId = `mcvcq-t-${sfx}`, workerId = `mcvcq-w-${sfx}`;
  const repo = path.join(reposDir, "repo");
  makeRepo(repo);
  const config = { orchestration: { gateCommand } };
  db.insertProject({ id: projId, name: "MCVCQ", repoPath: repo, vaultPath: repo, config, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-mcvcq-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-mcvcq-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertAgent({ id: `agent-mcvcq-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "MCVCQ-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, "feature.txt"), "work\n");
  commitAll(worktreePath, "feature.txt", GIT_ID);
  db.insertSession({ id: workerId, projectId: projId, agentId: `agent-mcvcq-w-${sfx}`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
  return { db, mgrId, projId, taskId, workerId, repo, worktreePath, branch };
}

// ── ENTRY-TIME QUARANTINE BACKSTOP: quarantined:true, never cached ──────────────────────────────────────
{
  const sfx = `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reposDir = path.join(os.tmpdir(), `loom-mcvcq-${sfx}`);
  const { db, mgrId, workerId, repo } = await setupWorkerProject(sfx, reposDir);
  let gateCalls = 0;
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000, runGate: async () => { gateCalls++; return { passed: true, steps: [] }; },
  });

  const token = enterMergeQuarantine(repo, "some-other-branch", "simulated unconfirmed kill for this test");
  check("(setup) the canonical repo is quarantined", !!activeMergeQuarantineFor(repo));

  const r1 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(entry-backstop) op 1 settled, NOT merged, refused by the quarantine BEFORE any gate lane", r1.settled === true && r1.ok && r1.value.merged === false && gateCalls === 0);
  check("(entry-backstop) op 1's result carries quarantined:true", r1.ok && r1.value.quarantined === true);
  check("(entry-backstop) op 1's reason names the concrete human remedy (reused assertRepoNotQuarantined text)", r1.ok && /POST \/internal\/merge-quarantine\/clear/.test(r1.value.reason ?? ""));

  // A plain re-call while STILL quarantined is refused again (the repo-wide latch is the real signal here,
  // not the cache) — sanity-checking this before clearing isolates "the quarantine persists" from "the
  // verdict cache serves a stale reply", which the NEXT assertion is actually about.
  const rStillQuarantined = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(entry-backstop) a re-call while STILL quarantined is refused again, still no gate lane", rStillQuarantined.settled === true && rStillQuarantined.ok && rStillQuarantined.value.merged === false && rStillQuarantined.value.quarantined === true && gateCalls === 0);

  clearMergeQuarantine(repo);
  check("(setup) the quarantine is cleared", !activeMergeQuarantineFor(repo));

  const r2 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(entry-backstop) card 7e5b23e7 round 2: after the human clears the quarantine, the re-call does NOT replay the stale quarantine refusal — it actually re-attempts (gate runs for real)", gateCalls === 1 && r2.cacheHit === undefined);
  check("(entry-backstop) op 2 actually merges (the worktree had real, mergeable work all along — only the quarantine ever stood in the way)", r2.settled === true && r2.ok && r2.value.merged === true);

  // Not consumed by the assertions above, but exercised: `token` would let a MORE TARGETED clear remove
  // only this raise (clearMergeQuarantineByToken) — the blanket `clearMergeQuarantine` above is the
  // human-REST route's own unconditional clear, used here since this file raised the only outstanding one.
  void token;
}

console.log(failures === 0
  ? "\n✅ ALL PASS — confirmWorkerMergeTracked's entry-time quarantine backstop: a quarantined repo refuses " +
    "every merge before any gate lane (quarantined:true, concrete remedy text), and — the round-2 fix this " +
    "file proves — the refusal is NEVER cached: once a human clears the quarantine, a plain re-confirm at " +
    "the SAME commit actually re-attempts instead of replaying the stale refusal."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
