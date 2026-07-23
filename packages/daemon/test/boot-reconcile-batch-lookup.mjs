import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 6ee48e4d — boot reconcile Pass A used to call findLandedSquashCommit (an UNCAPPED full-history
// `git log --grep`) once PER historical worker session, including long-retired/archived ones: 2041
// sequential git subprocess spawns on a real boot, minutes of stall. The fix has three parts:
//   1. The cheap `alreadyFinalized` (DB read) + `worktreeOnDisk` (fs.existsSync) early-out now runs
//      BEFORE the squash lookup, not after — an already-reconciled worker whose worktree is gone never
//      pays for a git spawn at all.
//   2. The residual sessions look their branch up in the batch findLandedSquashCommitViaMap map (ONE
//      bounded `git log` pass per repo, shared/cached across every session checked against it) instead of
//      a fresh single-branch walk each.
//   3. A map MISS alone is NOT enough to skip the fallback — the residual population is overwhelmingly
//      NOT-YET-LANDED workers (no trailer at all), which miss the map every time regardless of window
//      size. The scan's OWN `truncated` flag (records returned === MERGED_LOOKUP_SCAN_LIMIT) discriminates
//      "genuinely never landed" (scan read `base`'s entire history — miss is AUTHORITATIVE, skip the
//      fallback) from "possibly landed outside the window" (scan was truncated/errored — miss is
//      inconclusive, fall back exactly as before). Skipping the fallback on a complete scan's miss is what
//      turns the residual spawns toward ~0 instead of ~1-per-residual-session.
// REAL git on temp repos, NO claude and NO live daemon — drives reconcileOrchestrationOnBoot() directly
// against an isolated LOOM_HOME. Proves:
//   (A) an already-finalized worker (merge_done recorded, worktree absent) triggers ZERO git lookups —
//       a counting/stubbed gitFactory injected via reconcile's new `gitDeps` param proves the count.
//   (B) a genuinely-unfinalized LANDED worker (no merge_done yet) is STILL finalized via the batch map's
//       normal in-window HIT path, with the single-branch fallback grep proven NEVER called.
//   (C) a live worker with NO trailer is STILL KEPT (the 2026-06-05 P0 data-loss safety) via a COMPLETE
//       scan's AUTHORITATIVE miss — the single-branch fallback grep is proven NEVER called for it either.
//   (D) a genuinely-landed worker is STILL finalized even when the batch scan is forced to see EXACTLY
//       MERGED_LOOKUP_SCAN_LIMIT non-matching records (a TRUNCATED scan) — proving the fallback still
//       engages (and is proven called) on a genuinely inconclusive miss, so full-history detection is
//       never silently narrowed for a repo bigger than the scan window.
// Run: 1) build daemon, 2) node test/boot-reconcile-batch-lookup.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { simpleGit } from "simple-git";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-bbl-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, taskKey } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=bbl@loom -c user.name=bbl";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();

const db = new Db();
const sessions = new SessionService(db, {}, new OrchestrationControl());
const mergeDoneCount = (mgrId) => db.listEvents(mgrId).filter((e) => e.kind === "merge_done").length;

function seedProjectAndTask(p) {
  db.insertProject({ id: p.projId, name: "BBL", repoPath: p.repo, vaultPath: p.repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "BBL-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
}

function seedWorker(p) {
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

function initRepo(repo, readme) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), readme);
  execSync(`git init -q && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mk = (tag) => ({ projId: `bbl-${tag}-proj-${sfx}`, agentId: `bbl-${tag}-top-${sfx}`, taskId: `bbl-${tag}-task-${sfx}`, mgrId: `bbl-${tag}-mgr-${sfx}`, workerId: `bbl-${tag}-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-bbl-${tag}-${sfx}`) });

// (A) already-finalized, worktree gone: a synthetic branch name is enough — no git op should ever touch it.
const A = mk("a");
A.branch = `loom/${taskKey(A.taskId)}`;
A.worktreePath = path.join(os.tmpdir(), `loom-bbl-a-worktree-gone-${sfx}`); // deliberately never created

// (B) genuinely-unfinalized landed worker (real repo, real squash-merge trailer, worktree still present).
const B = mk("b");

// (C) live worker, no trailer, holds real uncommitted work (P0 safety).
const C = mk("c");

// (D) landed worker whose batch scan will be artificially blinded (simulates "outside the scan window").
const D = mk("d");

try {
  // ---------------------------------------------------------------------------------------------------
  // (A) ZERO git lookups for an already-finalized worker whose worktree is gone.
  // ---------------------------------------------------------------------------------------------------
  fs.mkdirSync(A.repo, { recursive: true }); // repoPath must resolve, but is never touched by git here
  seedProjectAndTask(A);
  seedWorker(A);
  db.appendEvent({ id: `${A.workerId}-merge-done`, ts: now, managerSessionId: A.mgrId, workerSessionId: A.workerId, taskId: A.taskId, kind: "merge_done", detail: { branch: A.branch } });
  check("(A-pre) worktree genuinely absent", !fs.existsSync(A.worktreePath));
  check("(A-pre) merge_done already recorded", mergeDoneCount(A.mgrId) === 1);

  let gitFactoryCalls = 0;
  const countingGit = { raw: async () => "" };
  const rA = await sessions.reconcileOrchestrationOnBoot(new Set(), { gitFactory: () => { gitFactoryCalls++; return countingGit; } });
  check("(A) reconcile invoked the injected gitFactory ZERO times (early-out beat the git call)", gitFactoryCalls === 0);
  check("(A) reconcile finished 0 merges (nothing left to finish)", rA.mergesFinished === 0);
  check("(A) merge_done NOT duplicated", mergeDoneCount(A.mgrId) === 1);

  // ---------------------------------------------------------------------------------------------------
  // (B) genuinely-unfinalized landed worker → still finalized, via the batch map's normal in-window hit.
  // (C) live worker, no trailer, real uncommitted work → still KEPT (P0 safety).
  // ---------------------------------------------------------------------------------------------------
  initRepo(B.repo, "# bbl landed\n");
  {
    const { worktreePath, branch } = await createWorktree(B.repo, B.projId, B.taskId);
    fs.writeFileSync(path.join(worktreePath, "feat.txt"), "landed work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m feat`, { cwd: worktreePath });
    execSync(`git ${GIT_ID} merge --squash ${branch} && git ${GIT_ID} commit -q -m "BBL-TASK" -m "Loom-Worker-Branch: ${branch}"`, { cwd: B.repo });
    B.worktreePath = worktreePath; B.branch = branch;
  }
  seedProjectAndTask(B);
  seedWorker(B);

  initRepo(C.repo, "# bbl live\n");
  {
    const { worktreePath, branch } = await createWorktree(C.repo, C.projId, C.taskId);
    fs.mkdirSync(path.join(worktreePath, "src"), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, "src", "work.txt"), "in-progress, uncommitted\n");
    C.worktreePath = worktreePath; C.branch = branch;
  }
  seedProjectAndTask(C);
  seedWorker(C);

  check("(B-pre) landed HEAD carries the Loom-Worker-Branch trailer", git(B.repo, "log -1 --format=%b").includes(`Loom-Worker-Branch: ${B.branch}`));
  check("(C-pre) live worker has NO trailer in main", !git(C.repo, "log -1 --format=%b").includes("Loom-Worker-Branch"));

  // Both B's and C's repos are TINY (well under MERGED_LOOKUP_SCAN_LIMIT), so their batch scans are
  // genuinely COMPLETE: B is resolved via a real map HIT (never needs the single-branch grep at all), and
  // C's map MISS is AUTHORITATIVE (scanComplete:true) — the fallback grep must be skipped entirely for
  // both. A counting-but-delegating gitFactory (every call still hits real git) proves that single-branch
  // `--max-count=1` grep is NEVER invoked for either session.
  let singleBranchGrepCalls = 0;
  const countingPassthroughFactory = (repoPath, blockTimeoutMs) => {
    const real = simpleGit(repoPath, { timeout: { block: blockTimeoutMs } });
    return {
      raw: async (args) => {
        if (Array.isArray(args) && args.includes("--max-count=1")) singleBranchGrepCalls++;
        return real.raw(args);
      },
    };
  };
  const rBC = await sessions.reconcileOrchestrationOnBoot(new Set(), { gitFactory: countingPassthroughFactory });
  check("(B/C) complete scan ⇒ the single-branch fallback grep was NEVER called (map-hit and authoritative-miss both bypass it)", singleBranchGrepCalls === 0);
  check("(B) landed worker finalized via the batch map (mergesFinished includes it)", rBC.mergesFinished === 1);
  check("(B) landed worktree removed", !fs.existsSync(B.worktreePath));
  check("(B) landed task moved to done", db.getTask(B.taskId).columnKey === "done");
  check("(B) landed branch deleted", git(B.repo, `branch --list ${B.branch}`) === "");
  check("(B) merge_done appended exactly once", mergeDoneCount(B.mgrId) === 1);

  check("(C) live worktree KEPT (no trailer → P0 safety)", fs.existsSync(C.worktreePath));
  check("(C) live work CONTENTS intact", fs.existsSync(path.join(C.worktreePath, "src", "work.txt")));
  check("(C) live task NOT wrongly marked done", db.getTask(C.taskId).columnKey === "in_progress");
  check("(C) live branch NOT deleted", git(C.repo, `branch --list ${C.branch}`).includes(C.branch));
  check("(C) live worker recorded NO merge_done", mergeDoneCount(C.mgrId) === 0);

  // ---------------------------------------------------------------------------------------------------
  // (D) the batch scan (the "-n <limit>" git-log pass) is artificially blinded to simulate a landed
  //     commit falling OUTSIDE MERGED_LOOKUP_SCAN_LIMIT — every OTHER git op is delegated to real git.
  //     Pass A must still find + finalize it via the single-branch fallback (findLandedSquashCommit),
  //     proving a map miss never silently narrows detection.
  // ---------------------------------------------------------------------------------------------------
  initRepo(D.repo, "# bbl blinded-scan\n");
  {
    const { worktreePath, branch } = await createWorktree(D.repo, D.projId, D.taskId);
    fs.writeFileSync(path.join(worktreePath, "feat.txt"), "landed work behind a blinded scan\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m feat`, { cwd: worktreePath });
    execSync(`git ${GIT_ID} merge --squash ${branch} && git ${GIT_ID} commit -q -m "BBL-TASK-D" -m "Loom-Worker-Branch: ${branch}"`, { cwd: D.repo });
    D.worktreePath = worktreePath; D.branch = branch;
  }
  seedProjectAndTask(D);
  seedWorker(D);
  check("(D-pre) landed HEAD carries the Loom-Worker-Branch trailer", git(D.repo, "log -1 --format=%b").includes(`Loom-Worker-Branch: ${D.branch}`));

  // A fully-EMPTY stubbed response would read as "scan complete, zero commits" (recordCount 0 < the
  // limit) — i.e. `truncated: false`, which the new authoritative-miss discriminator (this same message's
  // follow-up fix) would then treat as CONCLUSIVE and correctly skip the fallback, defeating the point of
  // this scenario. To genuinely simulate "the scan hit MERGED_LOOKUP_SCAN_LIMIT", fabricate exactly that
  // many well-formed, NON-matching commit records (same %H\x1f%aI\x1f%B\x1e shape scanMergedCommitMap
  // parses) so recordCount reaches the limit and `truncated` is correctly detected `true`.
  const MERGED_LOOKUP_SCAN_LIMIT_UNDER_TEST = 5000; // must track worktrees.ts's own private constant
  const FIELD_SEP = "\x1f";
  const RECORD_SEP = "\x1e";
  const fakeTruncatedScanOutput = Array.from(
    { length: MERGED_LOOKUP_SCAN_LIMIT_UNDER_TEST },
    (_, i) => `deadbeef${i}${FIELD_SEP}2020-01-01T00:00:00+00:00${FIELD_SEP}dummy non-matching commit ${i}${RECORD_SEP}`,
  ).join("");

  let blindedScanCalls = 0;
  let dFallbackGrepCalls = 0;
  const blindMapFactory = (repoPath, blockTimeoutMs) => {
    const real = simpleGit(repoPath, { timeout: { block: blockTimeoutMs } });
    return {
      raw: async (args) => {
        // The batch scanMergedCommitMap pass is the ONLY call in this whole path that carries "-n"
        // (findLandedSquashCommit's single-branch --grep walk uses --max-count=1, never -n). Forcing it to
        // see exactly MERGED_LOOKUP_SCAN_LIMIT non-matching records simulates "this branch's landed commit
        // is outside the scan window" (truncated:true) — a genuinely inconclusive miss, not a complete one.
        if (Array.isArray(args) && args.includes("-n")) { blindedScanCalls++; return fakeTruncatedScanOutput; }
        if (Array.isArray(args) && args.includes("--max-count=1")) dFallbackGrepCalls++;
        return real.raw(args);
      },
    };
  };
  const rD = await sessions.reconcileOrchestrationOnBoot(new Set(), { gitFactory: blindMapFactory });
  check("(D-sanity) the batch scan was actually exercised (and blinded/truncated)", blindedScanCalls > 0);
  check("(D) a truncated scan DOES fall back to the single-branch grep (inconclusive miss)", dFallbackGrepCalls > 0);
  check("(D) landed worker STILL finalized despite the blinded batch scan (fallback engaged)", rD.mergesFinished === 1);
  check("(D) landed worktree removed", !fs.existsSync(D.worktreePath));
  check("(D) landed task moved to done", db.getTask(D.taskId).columnKey === "done");
  check("(D) merge_done appended exactly once", mergeDoneCount(D.mgrId) === 1);

  // (D) also reprocesses A/B/C harmlessly: A/B are already-finalized+worktree-gone (early-out, no git
  // regardless of the blinded factory); C is still live with no trailer, so the blinded map miss +
  // fallback correctly agree with the unblinded result — still kept, unchanged.
  check("(D-side-effect) (A) still shows exactly 1 merge_done (not reprocessed)", mergeDoneCount(A.mgrId) === 1);
  check("(D-side-effect) (C) still KEPT after being reprocessed under the blinded factory", fs.existsSync(C.worktreePath) && db.getTask(C.taskId).columnKey === "in_progress");
} finally {
  db.close();
  for (const p of [A, B, C, D]) {
    try { if (p.worktreePath) fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — boot-reconcile Pass A's cheap early-out skips git entirely for an already-finalized worker; a landed worker is finalized via the batch map with zero fallback grep calls; a live untailered worker is kept (P0 safety) via a COMPLETE scan's authoritative miss, also with zero fallback grep calls; and a TRUNCATED scan's genuinely inconclusive miss still falls back to the uncapped single-branch lookup (proven called) and still finalizes a genuinely-landed worker, so full-history detection is never silently narrowed."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
