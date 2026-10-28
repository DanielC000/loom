import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 027bad41 — end-to-end (via confirmWorkerMerge) reproduction of the 3-worker false-HIGH
// mainline-trust-freeze sequence from card 08c36dae's Code Review: w1 lands (trust=A), w2's squash lands
// but its confirmatory read throws, w3 lands afterward. (RECOVERED): a one-shot failure on w2 now
// recovers (ledger row written, ZERO freeze events, trust advances to w3) — RED before this card's fix,
// GREEN after. (EXHAUSTED): every attempt failing preserves today's refusal/no-ledger/eventual HIGH
// freeze byte-for-byte (the named, accepted residual). UNIT-level retry coverage lives in the sibling
// mainline-watch-squash-landed-unread-retry.mjs. Full analysis: docs/decisions/027bad41-*.md.
//
// Run: 1) pnpm build, 2) node packages/daemon/test/merge-confirm-squash-landed-unread-recovered.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";

useOwnLoomHome("loom-mcslur-home-");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const IDENT = { GIT_AUTHOR_NAME: "mcslur", GIT_AUTHOR_EMAIL: "mcslur@loom", GIT_COMMITTER_NAME: "mcslur", GIT_COMMITTER_EMAIL: "mcslur@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=mcslur@loom -c user.name=mcslur";
const now = new Date().toISOString();
const noReap = async () => ({ killedPids: [] });
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
const openDbs = [];

function makeRepo(sfx) {
  const repo = mkdtempManaged(`loom-mcslur-repo-${sfx}-`);
  fs.writeFileSync(path.join(repo, "README.md"), "# mcslur\n");
  git(repo, "init", "-q", "-b", "main"); git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "user.email", "mcslur@loom"); git(repo, "config", "user.name", "mcslur");
  commitAll(repo, "init", GIT_ID);
  return repo;
}

function newProject(tag, repo) {
  const sfx = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const projId = `mcslur-proj-${sfx}`, agentId = `mcslur-agent-${sfx}`, mgrId = `mcslur-mgr-${sfx}`;
  const db = new Db(); openDbs.push(db);
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap });
  db.insertProject({ id: projId, name: `MCSLUR-${tag}`, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  return { db, sessions, projId, mgrId, agentId, sfx, repo };
}

let seq = 0;
async function addWorker(ctx, tag) {
  const n = `${tag}${++seq}`;
  const taskId = `mcslur-${n}-task-${ctx.sfx}`, workerId = `mcslur-${n}-wkr-${ctx.sfx}`;
  ctx.db.insertTask({ id: taskId, projectId: ctx.projId, title: `feat(x): change ${n}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(ctx.repo, ctx.projId, taskId);
  registerForCleanup(worktreePath);
  fs.writeFileSync(path.join(worktreePath, `${n}.ts`), `export const ${n} = 1;\n`);
  commitAll(worktreePath, `feat(x): change ${n}`, GIT_ID);
  ctx.db.insertSession({ id: workerId, projectId: ctx.projId, agentId: ctx.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: ctx.mgrId, taskId, worktreePath, branch });
  return { taskId, workerId, worktreePath, branch };
}
const confirm = (ctx, w) => ctx.sessions.confirmWorkerMerge(ctx.mgrId, w.workerId);
const eventsFor = (db, projId) => db.listEventsSince(0, 100000).filter((e) => e.kind === "mainline_moved_outside_loom" && e.detail?.projectId === projId);
const freezeEventsFor = (db, projId) => eventsFor(db, projId).filter((e) => e.detail?.source === "landing-trust-freeze");
const ledgerRowFor = (db, projId, tip) => db.db.prepare("SELECT * FROM mainline_landed_commits WHERE project_id = ? AND tip = ?").get(projId, tip);

// NARROWEST NATIVE SEAM, same shape as merge-confirm-squash-landed-unread.mjs's own
// `postCommitReadFailFactory`: the real `git commit -F <file>` always lands; only the `rev-parse HEAD`
// read(s) that follow it are faulted, up to `failCount` times, before falling through to real git.
function readFailFactory(failCount) {
  let commitSucceeded = false;
  let failsSoFar = 0;
  return (repoPath, blockTimeoutMs) => ({
    raw: async (args) => {
      const { boundedSimpleGit } = await import("../dist/git/bounded.js");
      const { nonInteractiveEnv } = await import("../dist/git/writer.js");
      const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      if (Array.isArray(args) && args[0] === "commit" && args[1] === "-F") {
        const out = await real.raw(args);
        commitSucceeded = true;
        return out;
      }
      if (commitSucceeded && Array.isArray(args) && args[0] === "rev-parse" && args[args.length - 1] === "HEAD" && failsSoFar < failCount) {
        failsSoFar++;
        throw new Error(`simulated post-commit HEAD read failure (attempt ${failsSoFar})`);
      }
      return real.raw(args);
    },
  });
}

try {
  // ===================== (RECOVERED) ======================================================================
  {
    const repo = makeRepo("rec");
    const ctx = newProject("rec", repo);

    const w1 = await addWorker(ctx, "a");
    const r1 = await confirm(ctx, w1);
    check("(RECOVERED) w1 lands normally", r1.merged === true);
    const trustA = ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main");
    check("(RECOVERED) trust establishes at w1's own tip (first landing)", trustA !== null && trustA === git(repo, "rev-parse", "HEAD"));

    const w2 = await addWorker(ctx, "b");
    const w2BranchTip = git(w2.worktreePath, "rev-parse", "HEAD"); // the WORKER's own branch head — a DIFFERENT fact from the squash commit's own sha (db.ts ~L1541-1542)
    ctx.sessions.soloMergeGitFactory = readFailFactory(1); // ONE-SHOT: recovered by the retry
    const r2 = await confirm(ctx, w2);
    ctx.sessions.soloMergeGitFactory = undefined;
    check("(RECOVERED) THE FIX: w2's one-shot read failure recovers — a genuine success, never squashLandedUnread", r2.merged === true && r2.squashLandedUnread !== true);
    const landedSha2 = git(repo, "rev-parse", "HEAD");
    check("(RECOVERED) HEAD genuinely advanced past w1's tip — w2's commit really landed", landedSha2 !== trustA);
    const ledgerRow2 = ledgerRowFor(ctx.db, ctx.projId, landedSha2);
    check("(RECOVERED) w2 GETS its own ledger row (verified as Loom's own commit)", ledgerRow2 !== undefined);
    check("(RECOVERED) that ledger row's own worker_landed_tip is stamped to w2's WORKER BRANCH head (card 5958c149's column, written only for a verified landing — distinct from `tip`, the squash commit's own sha)", ledgerRow2?.worker_landed_tip === w2BranchTip);

    const w3 = await addWorker(ctx, "c");
    const r3 = await confirm(ctx, w3);
    check("(RECOVERED) w3 lands normally", r3.merged === true);
    check("(RECOVERED) THE FIX: ZERO mainline-moved-trust-freeze events — the bug reproduced in this card is gone", freezeEventsFor(ctx.db, ctx.projId).length === 0);
    const trustFinal = ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main");
    check("(RECOVERED) trust advances cleanly to w3's own landed tip — never frozen at w1's", trustFinal === git(repo, "rev-parse", "HEAD") && trustFinal !== trustA);
  }

  // ===================== (EXHAUSTED) — the named, accepted residual: preserved byte-for-byte ============
  {
    const repo = makeRepo("exh");
    const ctx = newProject("exh", repo);

    const w1 = await addWorker(ctx, "d");
    const r1 = await confirm(ctx, w1);
    check("(EXHAUSTED) w1 lands normally", r1.merged === true);
    const trustA = ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main");

    const w2 = await addWorker(ctx, "e");
    ctx.sessions.soloMergeGitFactory = readFailFactory(2); // PERSISTENT: exhausts the one bounded retry
    const r2 = await confirm(ctx, w2);
    ctx.sessions.soloMergeGitFactory = undefined;
    check("(EXHAUSTED) w2's refusal is unchanged: squashLandedUnread, never merged", r2.merged === false && r2.squashLandedUnread === true);
    check("(EXHAUSTED) no ledger row for w2's commit after the original refusal", ledgerRowFor(ctx.db, ctx.projId, git(repo, "rev-parse", "HEAD")) === undefined);

    const r2b = await confirm(ctx, w2); // the ALREADY_MERGED re-confirm, unchanged
    check("(EXHAUSTED) w2's re-confirm resolves ALREADY_MERGED, never a duplicate commit", r2b.merged === true);
    check("(EXHAUSTED) STILL no ledger row after the ALREADY_MERGED re-confirm (candidate (a), deliberately not fixed)", ledgerRowFor(ctx.db, ctx.projId, git(repo, "rev-parse", "HEAD")) === undefined);
    check("(EXHAUSTED) trust is still untouched after op1+op2", ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === trustA);

    const w3 = await addWorker(ctx, "f");
    const r3 = await confirm(ctx, w3);
    check("(EXHAUSTED) w3's own landing still succeeds (4fa36502's own Do-not: never block a later landing)", r3.merged === true);
    const freeze = freezeEventsFor(ctx.db, ctx.projId);
    check("(EXHAUSTED) THE RESIDUAL, PRESERVED: exactly ONE HIGH landing-trust-freeze event fires, naming w2's own commit", freeze.length === 1 && freeze[0].detail.severity === "high" && freeze[0].detail.from === trustA);
    check("(EXHAUSTED) trust stays FROZEN at w1's tip — never advances to w3's", ctx.db.getMainlineBranchTrust(ctx.projId, "primary", "main") === trustA);
  }
} finally {
  for (const db of openDbs) { try { db.close(); } catch { /* ignore */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the card's reproduced 3-worker sequence is fixed for the recoverable (one-shot) case (w2 lands cleanly, gets its own ledger row, w3's landing advances trust with ZERO false freeze events) and the named residual (every retry attempt exhausted) is preserved byte-for-byte: w2's squashLandedUnread refusal, its ALREADY_MERGED re-confirm, and w3's eventual HIGH trust-freeze alert all behave exactly as before this card."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
