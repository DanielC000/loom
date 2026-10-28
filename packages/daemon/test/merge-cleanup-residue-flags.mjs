import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision c395b4fb — every squash-failure cleanup site must spread `cleanupResidueFlags(cleanup)`,
// never a hand-patched quarantined/transient-only spread — `resetOrSkip` has TWO paths (a skip, and an
// ordinary first-attempt reset failure) that leave real residue behind without setting either flag.
//
// PROVES residuePossible is now set for all 3 site-classes under SKIP — (A) probe-failure,
// (B) conflict/rawError, (C) subject/title-entity — PLUS (D) the SAME conflict site under an ORDINARY
// reset failure (no skip), proving both of resetOrSkip's paths are fixed, PLUS (E) the SAME fact
// reaching the real confirmWorkerMerge caller: residuePossible on ConfirmMergeResult, honest detailText.
// Narrative: docs/decisions/c395b4fb-residue-flags-and-pre-squash-trust-refusal-sites.md ("Test design").
//
// RED/GREEN: `pnpm --filter @loom/daemon negative-control --file packages/daemon/src/git/worktrees.ts
// --test packages/daemon/test/merge-cleanup-residue-flags.mjs --ref 16af28e9`.
// Run: pnpm build, then node test/merge-cleanup-residue-flags.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { commitAll } from "./_git-commit.mjs";
import { useOwnLoomHome, registerForCleanup } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";

useOwnLoomHome("loom-crf-");
requireHermeticEnv();

const { mergeBranch, createWorktree } = await import("../dist/git/worktrees.js");
const { canonicalGit } = await import("../dist/git/bounded.js");
const { nonInteractiveEnv } = await import("../dist/git/writer.js");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=crf@loom -c user.name=crf";
const now = new Date().toISOString();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
const openDbs = [];
const noReap = async () => ({ killedPids: [] });

function freshDir(tag) {
  const dir = path.join(os.tmpdir(), `loom-crf-${tag}-${Date.now()}-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  registerForCleanup(dir);
  return dir;
}
function makeRepo(tag) {
  const repo = freshDir(`repo-${tag}`);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "crf@loom"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "crf"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "init\n");
  fs.writeFileSync(path.join(repo, "unrelated.txt"), "unrelated-base\n");
  commitAll(repo, "init", GIT_ID);
  return repo;
}
function addWorktree(repo, branch, from) {
  const wt = freshDir(`wt-${branch.replace(/\//g, "-")}`);
  fs.rmdirSync(wt); // git worktree add wants to create it itself
  execFileSync("git", ["worktree", "add", "-q", "-b", branch, wt, from], { cwd: repo });
  return wt;
}
function makeUnstagedDirt(repo, file) {
  // Pre-existing unstaged tracked-file edit, NEVER staged/committed — the exact precondition that makes
  // `hadUnstagedDirtAtEntry` true (git/worktrees.ts's own `statusAtEntry` probe).
  fs.appendFileSync(path.join(repo, file), "a human's own in-progress edit\n");
}
function statusPorcelain(repo) {
  return execFileSync("git", ["status", "--porcelain"], { cwd: repo }).toString().trimEnd();
}

try {
  // ── (A) probe-failure class, SKIP ───────────────────────────────────────────────────────────────
  {
    console.log("\n— (A) staged-probe-failure site, pre-existing dirt ⇒ SKIP, residuePossible must be true —");
    const repo = makeRepo("a");
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const wt = addWorktree(repo, "loom/crf-a", base);
    fs.writeFileSync(path.join(wt, "feature-a.txt"), "worker a work\n");
    commitAll(wt, "feature a", GIT_ID);
    makeUnstagedDirt(repo, "README.md");
    check("(A setup) the canonical repo genuinely has pre-existing unstaged dirt", statusPorcelain(repo) !== "");

    // Throws on the SECOND occurrence of the staged-diff probe's exact argv — the first (the pre-squash
    // entry check) must succeed cleanly so the merge is even attempted.
    let seen = 0;
    const factory = (repoPath, blockTimeoutMs) => ({
      raw: async (args) => {
        const argv = Array.isArray(args) ? args : [args];
        if (argv[0] === "diff" && argv.includes("--cached") && argv.includes("--name-only")) {
          seen++;
          if (seen >= 2) throw new Error("simulated staged-diff probe failure");
        }
        const real = canonicalGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
        return real.raw(args);
      },
    });
    const result = await mergeBranch(repo, "loom/crf-a", "Fix A", { gitFactory: factory });
    check("(A) refused, never merged", result.ok === false);
    check("(A) THE FIX: residuePossible is set — the cleanup could not run (skip)", result.residuePossible === true);
    check("(A) not quarantined/transient (a skip, not a kill/quarantine)", !result.quarantined && !result.transient);
    check("(A) reason names the real probe failure", /failed to inspect canonical index staged diff after squash/.test(result.reason ?? ""));
    check("(A) reason names the skip (pre-existing unstaged changes)", /already had unstaged tracked changes/.test(result.reason ?? ""));
    check("(A) the pre-existing unstaged README.md edit survives untouched", fs.readFileSync(path.join(repo, "README.md"), "utf8").includes("a human's own in-progress edit"));
  }

  // ── (B) conflict/rawError class, SKIP ────────────────────────────────────────────────────────────
  {
    console.log("\n— (B) a genuine squash conflict, pre-existing dirt ⇒ SKIP, residuePossible must be true —");
    const repo = makeRepo("b");
    fs.writeFileSync(path.join(repo, "conflict.txt"), "base\n");
    commitAll(repo, "conflict base", GIT_ID);
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const wt = addWorktree(repo, "loom/crf-b", base);
    fs.writeFileSync(path.join(wt, "conflict.txt"), "worker-change\n");
    commitAll(wt, "worker b conflicting change", GIT_ID);
    // Canonical advances the SAME file differently, so squashing the worker branch conflicts.
    fs.writeFileSync(path.join(repo, "conflict.txt"), "main-change\n");
    commitAll(repo, "main advances conflict.txt", GIT_ID);
    // Pre-existing dirt on an UNRELATED tracked file.
    makeUnstagedDirt(repo, "unrelated.txt");
    check("(B setup) the canonical repo genuinely has pre-existing unstaged dirt", statusPorcelain(repo) !== "");

    const result = await mergeBranch(repo, "loom/crf-b", "Fix B");
    check("(B) refused as a genuine conflict", result.ok === false && result.conflict === true);
    check("(B) THE FIX: residuePossible is set — the cleanup could not run (skip)", result.residuePossible === true);
    check("(B) not quarantined/transient", !result.quarantined && !result.transient);
    check("(B) the pre-existing unstaged unrelated.txt edit survives untouched", fs.readFileSync(path.join(repo, "unrelated.txt"), "utf8").includes("a human's own in-progress edit"));
  }

  // ── (C) subject/commit class, SKIP ───────────────────────────────────────────────────────────────
  {
    console.log("\n— (C) an HTML-entity title, pre-existing dirt ⇒ SKIP, residuePossible must be true —");
    const repo = makeRepo("c");
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const wt = addWorktree(repo, "loom/crf-c", base);
    fs.writeFileSync(path.join(wt, "feature-c.txt"), "worker c work\n");
    commitAll(wt, "feature c", GIT_ID);
    makeUnstagedDirt(repo, "README.md");
    check("(C setup) the canonical repo genuinely has pre-existing unstaged dirt", statusPorcelain(repo) !== "");

    const result = await mergeBranch(repo, "loom/crf-c", "fix(test): &lt;thing&gt;");
    check("(C) refused, never merged", result.ok === false);
    check("(C) THE FIX: residuePossible is set — the cleanup could not run (skip)", result.residuePossible === true);
    check("(C) not quarantined/transient", !result.quarantined && !result.transient);
    check("(C) reason names the HTML-entity cause", /contains an HTML entity/.test(result.reason ?? ""));
    check("(C) the pre-existing unstaged README.md edit survives untouched", fs.readFileSync(path.join(repo, "README.md"), "utf8").includes("a human's own in-progress edit"));
  }

  // ── (D) ORDINARY FAILURE — same conflict site, no pre-existing dirt, reset --hard itself fails ────
  {
    console.log("\n— (D) a genuine squash conflict, NO pre-existing dirt, but reset --hard fails ordinarily —");
    const repo = makeRepo("d");
    fs.writeFileSync(path.join(repo, "conflict.txt"), "base\n");
    commitAll(repo, "conflict base", GIT_ID);
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const wt = addWorktree(repo, "loom/crf-d", base);
    fs.writeFileSync(path.join(wt, "conflict.txt"), "worker-change\n");
    commitAll(wt, "worker d conflicting change", GIT_ID);
    fs.writeFileSync(path.join(repo, "conflict.txt"), "main-change\n");
    commitAll(repo, "main advances conflict.txt", GIT_ID);
    check("(D setup) the canonical repo is CLEAN (no pre-existing dirt)", statusPorcelain(repo) === "");

    let thrown = false;
    const factory = (repoPath, blockTimeoutMs) => ({
      raw: async (args) => {
        const argv = Array.isArray(args) ? args : [args];
        if (!thrown && argv[0] === "reset" && argv.includes("--hard")) {
          thrown = true;
          throw new Error("simulated ordinary reset --hard failure");
        }
        const real = canonicalGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
        return real.raw(args);
      },
    });
    const result = await mergeBranch(repo, "loom/crf-d", "Fix D", { gitFactory: factory });
    check("(D) refused as a genuine conflict", result.ok === false && result.conflict === true);
    check("(D) THE FIX: residuePossible is set — the reset ATTEMPT itself failed ordinarily (not a skip)", result.residuePossible === true);
    check("(D) not quarantined/transient (an ordinary failure, not a kill/quarantine)", !result.quarantined && !result.transient);
    check("(D) reason names the real reset failure, not a skip", /reset --hard \(conflict cleanup\) failed/.test(result.reason ?? "") && !/already had unstaged tracked changes/.test(result.reason ?? ""));
  }

  // ── (E) CONFIRMWORKERMERGE-LEVEL — commit-step failure + pre-existing dirt ⇒ residuePossible ────────
  // Code Review round 2, finding 1 (REPRODUCED end-to-end): `cleanupResidueFlags` setting
  // `residuePossible:true` inside mergeBranchLocked's return value is NOT enough — confirmWorkerMerge's
  // own generic fallthrough never read it, so the manager-facing detailText still said "canonical repo
  // untouched ... Re-task a rebase." Drives the REAL confirmWorkerMerge/SessionService plumbing (not
  // bare mergeBranch) to prove the fix landed at the layer the manager actually reads.
  {
    console.log("\n— (E) confirmWorkerMerge: commit-step failure + pre-existing dirt ⇒ residuePossible on the result —");
    const sfx = `e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const repo = makeRepo(sfx);
    makeUnstagedDirt(repo, "unrelated.txt");
    check("(E setup) the canonical repo genuinely has pre-existing unstaged dirt", statusPorcelain(repo) !== "");

    const db = new Db(); openDbs.push(db);
    const mgrId = `crf-mgr-${sfx}`, projId = `crf-p-${sfx}`, taskId = `crf-t-${sfx}`, workerId = `crf-w-${sfx}`;
    db.insertProject({ id: projId, name: "CRF", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `agent-crf-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-crf-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertAgent({ id: `agent-crf-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    // A CLEAN, non-conflicting worker change — the squash must actually SUCCEED at staging, so the
    // commit step is reached at all.
    const wt = await createWorktree(repo, projId, taskId);
    fs.writeFileSync(path.join(wt.worktreePath, "feature-e.txt"), "worker e work\n");
    commitAll(wt.worktreePath, "feature e", GIT_ID);
    db.insertTask({ id: taskId, projectId: projId, title: "CRF-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: workerId, projectId: projId, agentId: `agent-crf-w-${sfx}`, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: wt.worktreePath, branch: wt.branch });

    const commitFailureFactory = (repoPath, blockTimeoutMs) => ({
      raw: async (args) => {
        const argv = Array.isArray(args) ? args : [args];
        if (argv[0] === "commit" && argv[1] === "-F") throw new Error("simulated ordinary commit failure");
        const real = canonicalGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
        return real.raw(args);
      },
    });
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap, soloMergeGitFactory: commitFailureFactory });
    const confirm = await sessions.confirmWorkerMerge(mgrId, workerId);
    check("(E) refused, never merged", confirm.merged === false);
    check("(E) THE FIX: residuePossible:true reaches the ConfirmMergeResult itself", confirm.residuePossible === true);
    check("(E) detailText never claims the canonical repo is untouched", !/canonical repo untouched/.test(confirm.detailText ?? ""));
    check("(E) detailText never offers the rebase remedy", !/Re-task a rebase/.test(confirm.detailText ?? ""));
    check("(E) detailText instead names the real inspect commands", /git diff --cached/.test(confirm.detailText ?? "") && /git status/.test(confirm.detailText ?? ""));
    // Code Review (lead): "a rebase will not help" overclaims for a MERGE CONFLICT whose cleanup was
    // skipped/failed — a rebase IS the eventual remedy for the conflict itself, it just won't clear the
    // canonical-side residue. The shared residueInspectNote text must say that precisely.
    check("(E) detailText says to clear the residue first, not that rebasing never helps", /Clear that residue first; a rebase of this branch alone will not clear it\./.test(confirm.detailText ?? ""));
  }
} finally {
  for (const db of openDbs) { try { db.close(); } catch { /* ignore */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — every mergeBranchLocked cleanup site now reports residuePossible for BOTH a skipped reset AND an ordinary reset failure, via the shared cleanupResidueFlags helper."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
