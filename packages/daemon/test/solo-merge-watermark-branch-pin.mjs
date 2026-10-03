import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card d69d4858 — the solo squash-merge path's twin of b801bad0's batch fast-forward branch pin.
// `mergeBranchLocked` (git/worktrees.ts) used to pin only the canonical HEAD's SHA (`requireCanonicalHead`),
// never which BRANCH it was checked out on — a same-commit divert (`GitWriter.checkout`/`createBranch`, the
// Platform Lead's own git tools, or a stray manual checkout) passed that sha-only check trivially and the
// squash landed onto the stray branch, reporting `ok:true`. This file proves the fix via the REAL
// `confirmWorkerMerge` stack on real git repos:
//
//   (A) RED-FIRST — a same-commit divert (no new commit) BEFORE a solo confirm refuses `branchDiverted:true`
//       and lands nothing on either branch. Run this file against the pre-card code (temporarily revert
//       git/worktrees.ts + sessions/service.ts, rebuild, re-run) to see this assertion fail — the squash
//       lands onto the stray branch and reports `merged:true` there instead.
//   (B) CONTROL — a FRESH project with no mainline watermark ever stamped (true first sight) behaves
//       byte-identically to before this card: an ordinary solo merge lands normally, `branchDiverted`/
//       `unverified` are never set.
//   (C) a forced pre-check read failure (the injected `soloMergeGitFactory` test seam, same shape as
//       b801bad0's `batchFfGitFactory`) refuses `unverified:true`, never `branchDiverted` — the read failing
//       is not proof of anything either way, so this fails CLOSED rather than silently proceeding.
//   (D) the already-landed lookup scans the MAINLINE ref, not bare `HEAD`, for the SUPPRESS-notification
//       decision specifically: `shouldSuppressMergeReject`'s own `findLandedSquashCommit` call must NOT treat
//       a stray-only trailer commit as "already landed" against the real mainline, so a `branchDiverted`
//       rejection is NOT suppressed (`confirm.notified === true`). The divert is injected DURING the gate
//       (not before confirm starts) so the earlier union-merge step never taints the worker's own branch
//       ancestry with the stray commit — see this scenario's own inline note for why that confound matters.
//   (E) POST-squash DIVERT (Code Review round 2 item 5): `verifyLandedOnMainline`'s post-commit check, faked
//       via `soloMergeGitFactory` reporting a different branch on the second combined read — `divertedSha`
//       is returned, the real commit landed on mainline's own ref (the fake only lied to the read), the
//       watermark is never advanced, and the wording reflects a commit DID land.
//   (F) POST-squash UNVERIFIED: same shape as (E), but the second combined read THROWS instead of lying —
//       `unverified:true`, never `branchDiverted`, `divertedSha` still returned (a commit DID land, only the
//       confirmation read failed).
//   (G) BLOCKING fix (Code Review round 2 item 1): a BARE branch name handed to `git log` is ambiguous
//       against a same-named top-level file/dir ("fatal: ambiguous argument", reproduced directly here) or a
//       same-named tag. The already-landed lookup must use a fully-qualified `refs/heads/<branch>` instead —
//       proven against a repo that actually carries the adversarial directory.
//   (H) MAJOR fix (Code Review round 2 item 2): `confirmWorkerMergeTracked`'s OWN catch path (card 479f449f)
//       also scanned bare `HEAD` and FINALIZES on a hit (worktree removed, branch deleted, task merged) — a
//       forced throw (a `getPid` that throws) with canonical diverted onto a stray-only trailer commit must
//       NOT finalize.
//
// OUT OF SCOPE (carded separately, eb58b8bd): the periodic orphan sweep and findLandedSquashCommitViaMap
// also scan "HEAD" — not touched here.
//
// Run: 1) build daemon (pnpm build), 2) LOOM_CODEX_BIN=<nonexistent> node test/solo-merge-watermark-branch-pin.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), `loom-no-such-codex-bin-${process.pid}`);
useOwnLoomHome("loom-smwp-home-");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { boundedSimpleGit } = await import("../dist/git/bounded.js");
const { nonInteractiveEnv } = await import("../dist/git/writer.js");
const MW = await import("../dist/git/mainline-watch.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const IDENT = { GIT_AUTHOR_NAME: "smwp", GIT_AUTHOR_EMAIL: "smwp@loom", GIT_COMMITTER_NAME: "smwp", GIT_COMMITTER_EMAIL: "smwp@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=smwp@loom -c user.name=smwp";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const noReap = async () => ({ killedPids: [] });
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const PASS = { passed: true, steps: [{ step: "gate", durationMs: 1, status: 0 }] };

const mk = (label) => ({
  projId: `smwp-${label}-proj-${sfx}`, agentId: `smwp-${label}-agent-${sfx}`, mgrId: `smwp-${label}-mgr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-smwp-${label}-repo-${sfx}`),
});
function makeRepo(P) {
  fs.mkdirSync(P.repo, { recursive: true });
  registerForCleanup(P.repo);
  fs.writeFileSync(path.join(P.repo, "README.md"), "# smwp\n");
  git(P.repo, "init", "-q");
  git(P.repo, "config", "core.autocrlf", "false");
  git(P.repo, "config", "user.email", "smwp@loom");
  git(P.repo, "config", "user.name", "smwp");
  commitAll(P.repo, "init", GIT_ID);
  return git(P.repo, "rev-parse", "--abbrev-ref", "HEAD");
}
function seedProject(db, P, extraSessionsOpts) {
  db.insertProject({ id: P.projId, name: "SMWP", repoPath: P.repo, vaultPath: P.repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: P.agentId, projectId: P.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  return new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, runGate: async () => PASS, reapWorktreeProcesses: noReap, ...extraSessionsOpts });
}
let seq = 0;
async function addWorker(db, P, tag) {
  const n = `${tag}${++seq}`;
  const taskId = `smwp-${n}-task-${sfx}`, workerId = `smwp-${n}-wkr-${sfx}`;
  db.insertTask({ id: taskId, projectId: P.projId, title: `feat(x): change ${n}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(P.repo, P.projId, taskId);
  registerForCleanup(worktreePath);
  fs.writeFileSync(path.join(worktreePath, `${n}.ts`), `export const ${n} = 1;\n`);
  commitAll(worktreePath, `feat(x): change ${n}`, GIT_ID);
  db.insertSession({ id: workerId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: P.mgrId, taskId, worktreePath, branch });
  return { taskId, workerId, worktreePath, branch };
}
const rejectedEvents = (db, workerId, reason) => db.listEventsForWorker(workerId).filter((e) => e.kind === "merge_rejected" && e.detail?.reason === reason);

// ── (A) RED-FIRST: a same-commit divert before a solo confirm refuses, lands nothing ──────────────────────
{
  const A = mk("a");
  const MAIN = makeRepo(A);
  const MAINREF = `refs/heads/${MAIN}`;
  const db = new Db();
  const sessions = seedProject(db, A);
  const KEY = MW.mainlineWatermarkKey(A.projId, "primary");
  db.setMeta(KEY, JSON.stringify({ branch: MAIN, sha: git(A.repo, "rev-parse", "HEAD") }));

  const w = await addWorker(db, A, "a");
  const preSha = git(A.repo, "rev-parse", "HEAD");
  git(A.repo, "checkout", "-q", "-b", "strayA"); // same-commit divert, no new commit
  check("(A) precondition: canonical is on the stray branch, same sha as mainline", git(A.repo, "symbolic-ref", "--short", "HEAD") === "strayA" && git(A.repo, "rev-parse", "HEAD") === preSha);

  const confirm = await sessions.confirmWorkerMerge(A.mgrId, w.workerId);
  check("(A) the confirm refuses: merged:false", confirm.merged === false);
  check("(A) classified branchDiverted:true", confirm.branchDiverted === true);
  check("(A) observedBranch names the stray branch", confirm.observedBranch === "strayA");
  check("(A) mainline's own ref is untouched", git(A.repo, "rev-parse", MAINREF) === preSha);
  check("(A) the stray branch is untouched too (nothing was squashed anywhere)", git(A.repo, "rev-parse", "refs/heads/strayA") === preSha);
  check("(A) the worktree is retained (not finalized)", fs.existsSync(w.worktreePath));
  check("(A) a durable branch_diverted merge_rejected event was filed", rejectedEvents(db, w.workerId, "branch_diverted").length === 1);
  try { db.close(); } catch { /* already closed */ }
}

// ── (B) CONTROL: a fresh project with NO mainline watermark ever stamped behaves unchanged ─────────────────
{
  const B = mk("b");
  const MAIN = makeRepo(B);
  const db = new Db();
  const sessions = seedProject(db, B);
  // Deliberately NOT stamping the watermark — true first sight for this (project, repoKey).

  const w = await addWorker(db, B, "b");
  const confirm = await sessions.confirmWorkerMerge(B.mgrId, w.workerId);
  check("(B) with no watermark, an ordinary solo merge still lands: merged:true", confirm.merged === true);
  check("(B) branchDiverted is never set when there is nothing to compare against", confirm.branchDiverted === undefined);
  check("(B) unverified is never set either", confirm.unverified === undefined);
  try { db.close(); } catch { /* already closed */ }
}

// ── (C) a forced pre-check read failure refuses unverified:true, never branchDiverted ──────────────────────
{
  const C = mk("c");
  const MAIN = makeRepo(C);
  const db = new Db();
  let combinedCalls = 0;
  // Proxies every real git call except the FIRST combined `rev-parse HEAD --symbolic-full-name HEAD` read
  // (mergeBranchLocked's own PRE-squash branch pin check) — a transient read failure, never a
  // wrong-but-readable answer (that would classify as branchDiverted instead; see scenario (A)).
  function preCheckFailsGitFactory(repoPath, blockTimeoutMs) {
    const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
    return {
      raw: async (args) => {
        if (Array.isArray(args) && args[0] === "rev-parse" && args.includes("--symbolic-full-name")) {
          combinedCalls++;
          if (combinedCalls === 1) throw new Error("git rev-parse timed out after 10000ms");
        }
        return real.raw(args);
      },
    };
  }
  const sessions = seedProject(db, C, { soloMergeGitFactory: preCheckFailsGitFactory });
  const KEY = MW.mainlineWatermarkKey(C.projId, "primary");
  db.setMeta(KEY, JSON.stringify({ branch: MAIN, sha: git(C.repo, "rev-parse", "HEAD") }));

  const w = await addWorker(db, C, "c");
  const preSha = git(C.repo, "rev-parse", "HEAD");
  const confirm = await sessions.confirmWorkerMerge(C.mgrId, w.workerId);
  check("(C) the confirm refuses: merged:false", confirm.merged === false);
  check("(C) classified unverified:true (fail closed — the read failing is not proof either way)", confirm.unverified === true);
  check("(C) never classified as a confirmed branchDiverted", confirm.branchDiverted === undefined);
  check("(C) mainline's own ref is untouched", git(C.repo, "rev-parse", MAIN) === preSha);
  check("(C) the worktree is retained", fs.existsSync(w.worktreePath));
  check("(C) a durable branch_divert_unverified merge_rejected event was filed", rejectedEvents(db, w.workerId, "branch_divert_unverified").length === 1);
  // Round 3 Code Review (reviewer 7497f7cf), cheap addition: this is the PRE-squash path — nothing landed
  // at all — so it must get the plain "untouched" wording, never either post-squash sha-bearing phrasing.
  check(
    "(C) wording states the pre-squash \"untouched\" text (nothing landed, no sha either way)",
    /Canonical repo and worktree are untouched; nothing was squashed; worktree retained\./.test(confirm.detailText),
  );
  try { db.close(); } catch { /* already closed */ }
}

// ── (D) the already-landed lookup scans the MAINLINE ref, not bare HEAD — suppress path ─────────────────────
// Code Review round 2 (card dd36012a item 6): reverting ONLY shouldSuppressMergeReject's own base-arg fix
// must flip this test.
//
// TWO prior designs were tried and rejected — recorded here so the next reader doesn't re-derive them:
//   (i)  Divert canonical (with the stray trailer commit) BEFORE calling confirm at all. Confirm's own
//        UNION-MERGE step (mergeMainIntoWorktree, which always runs before the squash when nothing is
//        preLanded) reads canonical's CURRENT HEAD and merges it into the worker's OWN branch — making the
//        stray trailer commit an ANCESTOR of the worker's branch, which trips findLandedSquashCommit's OWN
//        re-task guard (`mergeBase(sha, branch) === sha`) and returns null REGARDLESS of which ref is
//        scanned. This isn't a test artifact — it's how confirmWorkerMerge genuinely behaves, which means a
//        PERSISTENT same-sha divert with its own stray landed-looking commit is self-neutralized by the
//        union-merge before the suppress check ever sees it, independent of this card's own fix.
//   (ii) Divert DURING the gate instead (mirroring batch-merge-watermark-branch-pin.mjs's own (P2)) to dodge
//        the union-merge taint. But creating the trailer commit changes canonical's sha, which the PRE-
//        EXISTING, broader `requireCanonicalHead` sha check catches FIRST (`gateBaseInvalidated`, a benign
//        race) — my new branch check never gets a chance to run. A same-SHA-only divert (the one shape that
//        reaches the branch check at all) by definition shares history with mainline, so scanning either ref
//        gives an IDENTICAL answer — a branchDiverted refusal and a scan-dependent lookup result are
//        structurally close to mutually exclusive.
// FIX: trigger the refusal via the EARLY `reviewedTipVerdict` "confirm-start" check instead (one of this
// card's other 5 fixed call sites) — it runs BEFORE preLanded/the union-merge ever touch anything, so the
// stray trailer commit's ancestry is never tainted. The worker is "reviewed" at an old tip, then gets a real
// new commit (genuinely "moved" — a worker's own commit never chain-verifies as a safe Loom-authored advance),
// and canonical is diverted to a stray branch (same sha as mainline, no taint) carrying a trailer commit for
// the FULL current content. `rejectNotify("reviewed_tip_moved", …)` then calls shouldSuppressMergeReject,
// which is the SAME suppress path (D) always meant to exercise — now reachable for real.
{
  const D = mk("d");
  const MAIN = makeRepo(D);
  const db = new Db();
  const sessions = seedProject(db, D);
  const KEY = MW.mainlineWatermarkKey(D.projId, "primary");
  db.setMeta(KEY, JSON.stringify({ branch: MAIN, sha: git(D.repo, "rev-parse", "HEAD") }));

  const w = await addWorker(db, D, "d");
  const reviewedTip = git(D.repo, "rev-parse", w.branch);
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: D.mgrId, workerSessionId: w.workerId, taskId: w.taskId, kind: "merge_request", detail: { branch: w.branch, tip: reviewedTip, repoKey: null } });
  // A genuine NEW worker commit after the review — never chain-verifies as a safe Loom-authored advance, so
  // reviewedTipVerdict correctly reads this as "moved", independent of anything else in this scenario.
  fs.writeFileSync(path.join(w.worktreePath, "d-extra.ts"), "export const dExtra = 1;\n");
  commitAll(w.worktreePath, "feat(x): change d1 (late commit after review)", GIT_ID);

  const preSha = git(D.repo, "rev-parse", "HEAD");
  git(D.repo, "checkout", "-q", "-b", "strayD"); // same-sha divert — BEFORE confirm, but BEFORE any
  // union-merge has a chance to run too, since this refusal fires earlier than that step.
  git(D.repo, "merge", "-q", "--squash", w.branch);
  git(D.repo, "commit", "-q", "-m", `feat(x): change (stray)\n\nLoom-Worker-Branch: ${w.branch}`);
  const strayTrailerSha = git(D.repo, "rev-parse", "HEAD");
  check("(D) precondition: the trailer commit exists on the stray branch", git(D.repo, "log", "strayD", `--grep=Loom-Worker-Branch: ${w.branch}`, "--format=%H") === strayTrailerSha);
  check("(D) precondition: the trailer commit is NOT reachable from mainline", git(D.repo, "log", MAIN, `--grep=Loom-Worker-Branch: ${w.branch}`, "--format=%H") === "");

  const confirm = await sessions.confirmWorkerMerge(D.mgrId, w.workerId);
  check("(D) the confirm refuses EARLY, before ever reaching the union-merge/squash: reviewedTipMoved:true", confirm.merged === false && confirm.reviewedTipMoved === true);
  // THE ASSERTION THIS SCENARIO EXISTS FOR: shouldSuppressMergeReject's own findLandedSquashCommit call
  // scans the MAINLINE ref (where the trailer commit is absent), so the rejection notify is NOT suppressed.
  // Scanning bare HEAD (= the stray branch, where the trailer commit IS present, untainted this early) would
  // wrongly suppress it — VERIFIED by reverting only that one call site's base-arg back to "HEAD": this
  // assertion flips to FAIL (confirmed directly against this exact scenario before landing this fix).
  check("(D) notified:true — the stray-only trailer commit does NOT count as \"already landed\" against mainline", confirm.notified === true);
  check("(D) nothing was squashed anywhere — mainline's own ref is untouched", git(D.repo, "rev-parse", MAIN) === preSha);
  check("(D) the stray branch is untouched beyond the precondition commit (confirm never reached the squash)", git(D.repo, "rev-parse", "refs/heads/strayD") === strayTrailerSha);
  try { db.close(); } catch { /* already closed */ }
}

// ── (E) post-squash DIVERT: the post-commit read reports a DIFFERENT branch than reality ────────────────────
// Code Review round 2 (card dd36012a item 5): no existing test exercises verifyLandedOnMainline's POST-squash
// path at all — the file's own banner claim ("re-verified before AND after") was false until this scenario
// existed. Uses `soloMergeGitFactory` to fake ONLY the SECOND combined `rev-parse --symbolic-full-name` read
// (the post-commit one) to report a fabricated branch name, mirroring b801bad0's own
// `batch-merge-ff-unverified-no-fallback.mjs` technique at the solo level — deterministic, no real divert
// needed, and immune to the union-merge confound (D) above had to work around.
{
  const E = mk("e");
  const MAIN = makeRepo(E);
  const db = new Db();
  let combinedCalls = 0;
  function postDivertsGitFactory(repoPath, blockTimeoutMs) {
    const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
    return {
      raw: async (args) => {
        const out = await real.raw(args);
        if (Array.isArray(args) && args[0] === "rev-parse" && args.includes("--symbolic-full-name")) {
          combinedCalls++;
          if (combinedCalls === 2) { const sha = out.trim().split("\n")[0]; return `${sha}\nrefs/heads/fake-stray-e\n`; }
        }
        return out;
      },
    };
  }
  const sessions = seedProject(db, E, { soloMergeGitFactory: postDivertsGitFactory });
  const KEY = MW.mainlineWatermarkKey(E.projId, "primary");
  db.setMeta(KEY, JSON.stringify({ branch: MAIN, sha: git(E.repo, "rev-parse", "HEAD") }));

  const w = await addWorker(db, E, "e");
  const preSha = git(E.repo, "rev-parse", "HEAD");
  const confirm = await sessions.confirmWorkerMerge(E.mgrId, w.workerId);
  check("(E) the confirm refuses: merged:false", confirm.merged === false);
  check("(E) classified branchDiverted:true (post-squash)", confirm.branchDiverted === true);
  check("(E) observedBranch names the fabricated branch", confirm.observedBranch === "fake-stray-e");
  check("(E) divertedSha is returned (Code Review round 2 item 4: was declared but never returned)", typeof confirm.divertedSha === "string" && confirm.divertedSha.length > 0);
  check("(E) the real commit landed on MAIN's own ref (the fake only lied to the read, not to git itself)", git(E.repo, "rev-parse", MAIN) === confirm.divertedSha && confirm.divertedSha !== preSha);
  check("(E) the mainline watermark was NOT advanced", JSON.parse(db.getMeta(KEY)).sha === preSha);
  check("(E) the worktree is retained (not finalized)", fs.existsSync(w.worktreePath));
  check("(E) a durable branch_diverted event carries the divertedSha", rejectedEvents(db, w.workerId, "branch_diverted").some((e) => e.detail?.divertedSha === confirm.divertedSha));
  check("(E) wording reflects that a commit DID land, not \"untouched\"", !/untouched/.test(confirm.detailText) && confirm.detailText.includes(confirm.divertedSha));
  // Round 3 Code Review (reviewer 7497f7cf), mirroring (F)'s exact-text assertion: branchDiverted must get
  // the "NOT advanced" wording and NEVER the unverified "UNCONFIRMED" phrasing — the two must not swap.
  check(
    "(E) wording states the exact branch-diverted \"NOT advanced\" text, never the unverified \"UNCONFIRMED\" phrasing",
    confirm.detailText.includes(
      `Canonical main was NOT advanced — a commit landed (${confirm.divertedSha}) but is not confirmed reachable from mainline; worktree retained.`,
    ) && !/UNCONFIRMED/.test(confirm.detailText),
  );
  try { db.close(); } catch { /* already closed */ }
}

// ── (F) post-squash UNVERIFIED: the post-commit read itself fails ───────────────────────────────────────────
{
  const F = mk("f");
  const MAIN = makeRepo(F);
  const db = new Db();
  let combinedCalls = 0;
  function postReadFailsGitFactory(repoPath, blockTimeoutMs) {
    const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
    return {
      raw: async (args) => {
        if (Array.isArray(args) && args[0] === "rev-parse" && args.includes("--symbolic-full-name")) {
          combinedCalls++;
          if (combinedCalls === 2) throw new Error("git rev-parse timed out after 10000ms");
        }
        return real.raw(args);
      },
    };
  }
  const sessions = seedProject(db, F, { soloMergeGitFactory: postReadFailsGitFactory });
  const KEY = MW.mainlineWatermarkKey(F.projId, "primary");
  db.setMeta(KEY, JSON.stringify({ branch: MAIN, sha: git(F.repo, "rev-parse", "HEAD") }));

  const w = await addWorker(db, F, "f");
  const preSha = git(F.repo, "rev-parse", "HEAD");
  const confirm = await sessions.confirmWorkerMerge(F.mgrId, w.workerId);
  check("(F) the confirm refuses: merged:false", confirm.merged === false);
  check("(F) classified unverified:true (post-squash) — never branchDiverted", confirm.unverified === true && confirm.branchDiverted === undefined);
  check("(F) divertedSha is still returned — a real commit DID land, only the read failed", typeof confirm.divertedSha === "string" && confirm.divertedSha.length > 0);
  check("(F) the real commit landed on MAIN's own ref", git(F.repo, "rev-parse", MAIN) === confirm.divertedSha && confirm.divertedSha !== preSha);
  check("(F) the mainline watermark was NOT advanced (unconfirmed, never trusted)", JSON.parse(db.getMeta(KEY)).sha === preSha);
  check("(F) the worktree is retained (not finalized)", fs.existsSync(w.worktreePath));
  check("(F) wording reflects that a commit DID land, not \"untouched\"", !/untouched/.test(confirm.detailText) && confirm.detailText.includes(confirm.divertedSha));
  // Round 3 (delta review b39e8972, item 1): the OLD wording keyed on `divertedSha` alone, so this
  // unverified+sha case wrongly borrowed the branch-diverted "Canonical main was NOT advanced" phrasing
  // (self-contradictory against its own "could not be confirmed" reason). Assert the EXACT UNCONFIRMED
  // text, not just the absence of "untouched" — and assert the divert-only phrasing is ABSENT here, since
  // that's precisely the regression this test exists to catch.
  check(
    "(F) wording states the exact UNCONFIRMED text, never the branch-diverted \"NOT advanced\" phrasing",
    confirm.detailText.includes(
      `A commit landed (${confirm.divertedSha}); whether it is on mainline is UNCONFIRMED — check \`git log ${MAIN}\` before recovering.`,
    ) && !/Canonical main was NOT advanced/.test(confirm.detailText),
  );
  try { db.close(); } catch { /* already closed */ }
}

// ── (G) BLOCKING fix (card dd36012a item 1): a bare branch name is ambiguous against a same-named top-level
//        file/dir/tag ("fatal: ambiguous argument"). A fully-qualified refs/heads/<branch> must be used for
//        the lookup base — proven against a repo that actually carries the adversarial shape. ─────────────────
{
  const G = mk("g");
  const MAIN = makeRepo(G);
  // A top-level DIRECTORY named exactly like the mainline branch — reproduces the reviewer's exact
  // `fatal: ambiguous argument '<branch>': both revision and filename` against a bare name.
  fs.mkdirSync(path.join(G.repo, MAIN), { recursive: true });
  fs.writeFileSync(path.join(G.repo, MAIN, "f.txt"), "x\n");
  commitAll(G.repo, "chore: add an ambiguous top-level dir", GIT_ID);
  const db = new Db();
  const sessions = seedProject(db, G);
  const KEY = MW.mainlineWatermarkKey(G.projId, "primary");
  db.setMeta(KEY, JSON.stringify({ branch: MAIN, sha: git(G.repo, "rev-parse", "HEAD") }));

  const w = await addWorker(db, G, "g");
  // Land it for real onto MAIN directly (bypassing a full confirm, mirroring (D)/(E)'s own technique) so the
  // worker's branch + worktree still exist afterward, simulating a stale re-confirm (the shape preLanded
  // exists for) against a canonical repo that already carries the adversarial same-named directory.
  git(G.repo, "merge", "-q", "--squash", w.branch);
  git(G.repo, "commit", "-q", "-m", `feat(x): change g\n\nLoom-Worker-Branch: ${w.branch}`);
  const landedSha = git(G.repo, "rev-parse", "HEAD");
  check("(G) precondition: a bare `git log <branch>` against this repo is genuinely ambiguous", (() => {
    try { execFileSync("git", ["log", MAIN, "--format=%H"], { cwd: G.repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); return false; }
    catch (e) { return /ambiguous argument/.test(String(e.stderr ?? e.message)); }
  })());

  const confirm = await sessions.confirmWorkerMerge(G.mgrId, w.workerId);
  check("(G) the re-confirm still classifies as landed despite the ambiguous bare name: merged:true", confirm.merged === true);
  check("(G) no branchDiverted/unverified false-positive from the ambiguity", confirm.branchDiverted === undefined && confirm.unverified === undefined);
  try { db.close(); } catch { /* already closed */ }
}

// ── (H) MAJOR fix (card dd36012a item 2): confirmWorkerMergeTracked's OWN catch path (card 479f449f) must
//        also scan the watermark ref, not bare HEAD — it FINALIZES on a hit (worktree removed, branch
//        deleted, task merged). A diverted canonical with a stray-only trailer commit must NOT be finalized
//        when confirmWorkerMerge itself throws. ──────────────────────────────────────────────────────────────
{
  const H = mk("h");
  const MAIN = makeRepo(H);
  const db = new Db();
  // A ptyStub whose getPid THROWS: confirmWorkerMerge's gated branch calls `this.pty.getPid?.(...)`
  // unconditionally and uncaught, right at its very first line — before the reap, before preLanded, before
  // the union-merge. Forcing it to throw aborts confirmWorkerMerge immediately, propagating to
  // confirmWorkerMergeTracked's own try/catch (the ONE path that can legitimately reach this code with a
  // worktree/branch that still exist and canonical genuinely diverted).
  const throwingPtyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {}, getPid() { throw new Error("[TEST] simulated pty failure"); } };
  db.insertProject({ id: H.projId, name: "SMWP", repoPath: H.repo, vaultPath: H.repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: H.agentId, projectId: H.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: H.mgrId, projectId: H.projId, agentId: H.agentId, engineSessionId: null, title: null, cwd: H.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const sessions = new SessionService(db, throwingPtyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, runGate: async () => PASS, reapWorktreeProcesses: noReap });
  const KEY = MW.mainlineWatermarkKey(H.projId, "primary");
  db.setMeta(KEY, JSON.stringify({ branch: MAIN, sha: git(H.repo, "rev-parse", "HEAD") }));

  const w = await addWorker(db, H, "h");
  const preSha = git(H.repo, "rev-parse", "HEAD");
  git(H.repo, "checkout", "-q", "-b", "strayH"); // diverted BEFORE confirm is ever called — the throw fires
  // before the union-merge, so (unlike (D)) there is no ancestry-tainting confound to work around here.
  git(H.repo, "merge", "-q", "--squash", w.branch);
  git(H.repo, "commit", "-q", "-m", `feat(x): change (stray)\n\nLoom-Worker-Branch: ${w.branch}`);
  const strayTrailerSha = git(H.repo, "rev-parse", "HEAD");
  check("(H) precondition: the trailer commit exists on the stray branch", git(H.repo, "log", "strayH", `--grep=Loom-Worker-Branch: ${w.branch}`, "--format=%H") === strayTrailerSha);
  check("(H) precondition: the trailer commit is NOT reachable from mainline", git(H.repo, "log", MAIN, `--grep=Loom-Worker-Branch: ${w.branch}`, "--format=%H") === "");

  const result = await sessions.confirmWorkerMergeTracked(H.mgrId, w.workerId);
  const settledOk = result?.settled === true && result?.ok === true;
  check("(H) the catch path did NOT finalize as merged (the stray-only commit must not count as landed)", !(settledOk && result.value?.merged === true));
  check("(H) the worktree was NOT removed", fs.existsSync(w.worktreePath));
  check("(H) the task was NOT moved to a terminal column", db.getTask(w.taskId)?.columnKey === "in_progress");
  check("(H) mainline's own ref is untouched", git(H.repo, "rev-parse", MAIN) === preSha);
  try { db.close(); } catch { /* already closed */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the solo squash-merge path pins the checked-out mainline branch from the stored watermark, re-verified BEFORE (D) and AFTER (E, F) the squash with fully-qualified refs (G) throughout, fails closed on a read failure either side, leaves a no-watermark project unchanged (B), scans the mainline ref rather than bare HEAD in both the suppress decision (D) and the tracked catch path (H), and never finalizes a diverted confirm that threw."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
