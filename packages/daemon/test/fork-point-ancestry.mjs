import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 0eaaa693 — refuse a landing whose fork point is off the current mainline. REAL git on temp repos
// (mirrors worktrees.mjs / batch-merge-canonical-branch-divert.mjs's own setup style).
//
// Scenario A (solo): a worker cut from main's tip C1, then the canonical checkout moves to an UNRELATED
//   branch "atlas" (diverged from an EARLIER commit C0 — C1 was never incorporated). mergeBranch, given
//   the worker's recorded cutBaseSha (C1), refuses — nothing landed, canonical repo untouched.
// Scenario B (solo): an ORDINARY branch cut from C0, with main (and therefore the worker's own union-
//   merge target) advancing and union-merging THREE separate times. The worker's cutBaseSha (C0) is still
//   an ancestor of the final target, so the landing proceeds normally — proving the union merges (which
//   inject a second-parent edge into the worker branch's own history) never contaminate the check.
// Scenario C (solo): a null cutBaseSha (a legacy worker, grandfathered) lands normally — unchanged
//   behavior, never refused.
// Scenario D (batch): assembleBatchBranches, given two candidates — one cut from main (lands), one cut
//   from the SAME unrelated "atlas" lineage as scenario A (dropped, forkPointDiverged) — lands the first,
//   drops the second, and does NOT abort the whole batch (quarantined/rollbackUnverified both false).
// Scenario E (round 2, card 0eaaa693): checkCutBaseAncestry FAILS CLOSED on a genuinely unresolvable
//   cutBaseSha (never committed in this repo at all, not merely cross-lineage) — `ok:false`, never a
//   throw, never the `unknown:true` (legacy/null) grandfathering shape.
//
// Run: 1) build daemon (pnpm build), 2) node test/fork-point-ancestry.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { commitAll } from "./_git-commit.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-fpa-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { mergeBranch, mergeMainIntoWorktree, assembleBatchBranches, checkCutBaseAncestry } = await import("../dist/git/worktrees.js").then(
  async (wt) => ({ ...wt, ...(await import("../dist/git/batch-merge.js")) }),
);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=fpa@loom -c user.name=fpa";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();

const tmpDirs = [];
function freshDir(tag) {
  // randomUUID() (not just ${Date.now()}-${process.pid}) — this helper is called repeatedly within ONE
  // process, so a bare clock+pid suffix collides within the same process on the millisecond axis
  // clock-path-regression-guard.mjs polices (card c1d48ea7); the random discriminator actually varies
  // per call, unlike pid alone.
  const dir = path.join(os.tmpdir(), `loom-fpa-${tag}-${Date.now()}-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

function makeRepo(tag) {
  const repo = freshDir(`repo-${tag}`);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", [..."config user.email fpa@loom".split(" ")], { cwd: repo });
  execFileSync("git", [..."config user.name fpa".split(" ")], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "init\n");
  commitAll(repo, "init", GIT_ID);
  return repo;
}

function addWorktree(repo, branch, from, tag) {
  const wt = freshDir(`wt-${tag}`);
  fs.rmdirSync(wt); // git worktree add wants to create it itself
  execFileSync("git", ["worktree", "add", "-q", "-b", branch, wt, from], { cwd: repo });
  return wt;
}

try {
  // ===================================================================================
  // SCENARIO A — solo, cross-lineage cut base is refused.
  // ===================================================================================
  {
    const repo = makeRepo("a");
    const base = git(repo, "rev-parse HEAD");

    // Main advances to c1 BEFORE the worker is ever cut from it.
    fs.writeFileSync(path.join(repo, "main-only.txt"), "main advanced\n");
    commitAll(repo, "main advances to c1", GIT_ID);
    const c1 = git(repo, "rev-parse HEAD");
    check("(A setup) c1 differs from base", c1 !== base);

    // Worker cut from c1 (current main tip at spawn time) — THIS is the worker's recorded cut base.
    const workerWt = addWorktree(repo, "loom/task-a", c1, "a-worker");
    fs.writeFileSync(path.join(workerWt, "worker.txt"), "worker A work\n");
    commitAll(workerWt, "worker A commit", GIT_ID);
    const cutBaseSha = c1;

    // Canonical checkout now diverts to an UNRELATED branch "atlas", cut from `base` — BEFORE c1 ever
    // existed, so c1 (the worker's cut base) is NOT an ancestor of atlas. This is the exact shape
    // 0eaaa693 describes: canonical moved to a different lineage than the worker's own fork point.
    execFileSync("git", ["checkout", "-q", "-b", "atlas", base], { cwd: repo });
    fs.writeFileSync(path.join(repo, "atlas-only.txt"), "atlas work\n");
    commitAll(repo, "atlas work", GIT_ID);
    const atlasTip = git(repo, "rev-parse HEAD");
    check("(A setup) atlas tip differs from base and c1", atlasTip !== base && atlasTip !== c1);
    check("(A setup) c1 is NOT an ancestor of atlas (the cross-lineage precondition)",
      (() => { try { execFileSync("git", ["merge-base", "--is-ancestor", c1, atlasTip], { cwd: repo }); return false; } catch { return true; } })());

    const result = await mergeBranch(repo, "loom/task-a", "Scenario A task", {}, undefined, undefined, undefined, undefined, undefined, undefined, undefined, cutBaseSha);
    check("(A) refused — ok:false", result.ok === false);
    check("(A) classified forkPointDiverged (never branchDiverted)", result.forkPointDiverged === true && !result.branchDiverted);
    check("(A) refusal says recycling/rebasing this worker can NEVER clear it (round 2 fix: the old wording was unreachable)",
      /cannot be cleared by recycling/i.test(result.reason ?? ""));
    check("(A) refusal names BOTH real remedies: switch the checkout back, and a fresh worker from current mainline",
      /switch the canonical checkout back/.test(result.reason ?? "") && /fresh worker/.test(result.reason ?? ""));
    check("(A) canonical repo untouched — still on atlas's tip", git(repo, "rev-parse HEAD") === atlasTip);
    // atlas's own history is exactly 2 commits (init, atlas-work) — c1 (main-only) was never incorporated,
    // and nothing new landed on top of it from the refused merge attempt.
    check("(A) nothing landed — atlas's history is still exactly 2 commits", git(repo, "rev-list --count HEAD") === "2");
  }

  // ===================================================================================
  // SCENARIO B — solo, an ordinary branch survives THREE real union-merges with no false positive.
  // ===================================================================================
  {
    const repo = makeRepo("b");
    const c0 = git(repo, "rev-parse HEAD");
    const cutBaseSha = c0;

    const workerWt = addWorktree(repo, "loom/task-b", c0, "b-worker");
    fs.writeFileSync(path.join(workerWt, "worker.txt"), "worker B work\n");
    commitAll(workerWt, "worker B commit", GIT_ID);

    // Main advances and the worker union-merges it THREE separate times — each union merge injects a
    // real 2-parent commit into the worker branch's own history (the exact shape that would contaminate
    // a naive merge-base-against-the-branch's-own-history check).
    for (let i = 1; i <= 3; i++) {
      fs.writeFileSync(path.join(repo, `main-${i}.txt`), `main advance ${i}\n`);
      commitAll(repo, `main advance ${i}`, GIT_ID);
      const union = await mergeMainIntoWorktree(repo, workerWt);
      check(`(B setup) union-merge #${i} ok`, union.ok === true);
    }
    const finalMainTip = git(repo, "rev-parse HEAD");
    check("(B setup) worker branch's own history now includes 3 merge commits",
      Number(git(workerWt, `rev-list --merges --count ${cutBaseSha}..HEAD`)) === 3);

    const result = await mergeBranch(repo, "loom/task-b", "Scenario B task", {}, undefined, undefined, undefined, undefined, undefined, undefined, undefined, cutBaseSha);
    check("(B) lands normally — ok:true (no false-positive refusal)", result.ok === true);
    check("(B) a real squash commit landed", typeof result.sha === "string" && result.sha.length >= 7);
    check("(B) canonical HEAD advanced past the pre-merge main tip", git(repo, "rev-parse HEAD") !== finalMainTip);
  }

  // ===================================================================================
  // SCENARIO C — solo, a null (legacy) cutBaseSha is grandfathered, never refused.
  // ===================================================================================
  {
    const repo = makeRepo("c");
    const c0 = git(repo, "rev-parse HEAD");
    const workerWt = addWorktree(repo, "loom/task-c", c0, "c-worker");
    fs.writeFileSync(path.join(workerWt, "worker.txt"), "worker C work\n");
    commitAll(workerWt, "worker C commit", GIT_ID);

    const result = await mergeBranch(repo, "loom/task-c", "Scenario C task", {}, undefined, undefined, undefined, undefined, undefined, undefined, undefined, null);
    check("(C) a null cutBaseSha still lands normally (grandfathered)", result.ok === true);
    check("(C) never classified forkPointDiverged for a null cut base", !result.forkPointDiverged);
  }

  // ===================================================================================
  // SCENARIO D — batch: one cross-lineage candidate dropped, the other lands; batch not aborted.
  // ===================================================================================
  {
    const repo = makeRepo("d");
    const defaultBranch = git(repo, "symbolic-ref --short HEAD");
    const c0 = git(repo, "rev-parse HEAD");

    // Candidate "good": cut from c0, same lineage as main.
    const goodWt = addWorktree(repo, "loom/task-d-good", c0, "d-good");
    fs.writeFileSync(path.join(goodWt, "good.txt"), "good work\n");
    commitAll(goodWt, "good work", GIT_ID);
    const goodTip = git(goodWt, "rev-parse HEAD");

    // Candidate "stray": cut from an unrelated "atlas" lineage (diverged from c0, never sharing main's
    // own later history) — same cross-lineage shape as scenario A.
    execFileSync("git", ["checkout", "-q", "-b", "atlas-d", c0], { cwd: repo });
    fs.writeFileSync(path.join(repo, "atlas-d.txt"), "atlas-d work\n");
    commitAll(repo, "atlas-d work", GIT_ID);
    const strayCutBase = git(repo, "rev-parse HEAD"); // the stray worker's recorded cut base
    const strayWt = addWorktree(repo, "loom/task-d-stray", strayCutBase, "d-stray");
    fs.writeFileSync(path.join(strayWt, "stray.txt"), "stray work\n");
    commitAll(strayWt, "stray work", GIT_ID);
    const strayTip = git(strayWt, "rev-parse HEAD");

    // Canonical checkout returns to main (never incorporating atlas-d) before the batch is cut.
    execFileSync("git", ["checkout", "-q", defaultBranch], { cwd: repo });
    const mainTip = git(repo, "rev-parse HEAD");
    check("(D setup) stray's cut base is NOT an ancestor of main",
      (() => { try { execFileSync("git", ["merge-base", "--is-ancestor", strayCutBase, mainTip], { cwd: repo }); return false; } catch { return true; } })());

    const batchWt = addWorktree(repo, "loom/batch-d", mainTip, "d-batch");

    const result = await assembleBatchBranches(repo, batchWt, [
      { workerSessionId: "good", taskId: "task-d-good", branch: "loom/task-d-good", taskTitle: "good", tip: goodTip, cutBaseSha: c0 },
      { workerSessionId: "stray", taskId: "task-d-stray", branch: "loom/task-d-stray", taskTitle: "stray", tip: strayTip, cutBaseSha: strayCutBase },
    ], {});

    check("(D) the batch is NOT aborted (quarantined false)", !result.quarantined);
    check("(D) the batch is NOT aborted (rollbackUnverified false)", !result.rollbackUnverified);
    check("(D) exactly one candidate landed", result.landed.length === 1);
    check("(D) the GOOD candidate landed", result.landed[0]?.workerSessionId === "good");
    check("(D) exactly one candidate was dropped", result.dropped.length === 1);
    check("(D) the STRAY candidate was dropped", result.dropped[0]?.workerSessionId === "stray");
    check("(D) the drop reason names the fork-point divergence",
      /not an ancestor|cut from|lineage/.test(result.dropped[0]?.reason ?? ""));
    check("(D) the drop reason says recycling/rebasing this worker can NEVER clear it (round 2 fix)",
      /cannot be cleared by recycling/i.test(result.dropped[0]?.reason ?? ""));
    check("(D) the drop reason names a fresh worker from current mainline as the real remedy",
      /fresh worker/.test(result.dropped[0]?.reason ?? ""));
    check("(D) the batch worktree carries the good candidate's file", fs.existsSync(path.join(batchWt, "good.txt")));
    check("(D) the batch worktree does NOT carry the stray candidate's file", !fs.existsSync(path.join(batchWt, "stray.txt")));
  }

  // ===================================================================================
  // SCENARIO E — checkCutBaseAncestry fails CLOSED on a genuinely unresolvable cutBaseSha.
  // ===================================================================================
  {
    const { simpleGit } = await import("simple-git");
    const repo = makeRepo("e");
    const targetTip = git(repo, "rev-parse HEAD");
    const git2 = simpleGit(repo);
    // A well-formed-looking sha that was NEVER committed anywhere in this repo — distinct from Scenario A's
    // cross-lineage (but genuinely resolvable) cut base: `git merge-base` itself must fail to resolve it.
    const bogusSha = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const result = await checkCutBaseAncestry(git2, 15_000, bogusSha, targetTip);
    check("(E) an unresolvable cutBaseSha fails CLOSED — ok:false", result.ok === false);
    check("(E) NOT classified as the null/legacy grandfathering shape (unknown must be absent/false)", !result.unknown);
    check("(E) the refusal names the unresolvable sha", result.cutBaseSha === bogusSha);
    check("(E) classified probeFailed — the git call itself threw (unresolvable object), never a resolved non-ancestor", result.probeFailed === true);
    // Sanity: a GENUINELY present sha (the repo's own HEAD) against itself resolves fine — proves the
    // bogus-sha failure above is about resolvability, not a broken harness/timeout.
    const selfResult = await checkCutBaseAncestry(git2, 15_000, targetTip, targetTip);
    check("(E control) a real, present sha against itself resolves ok:true (harness sanity)", selfResult.ok === true);
  }
} finally {
  for (const dir of tmpDirs) { try { execSync(`git worktree prune 2>/dev/null || true`, { cwd: path.dirname(dir) }); } catch { /* best effort */ } }
  for (const dir of tmpDirs) cleanupPathSync(dir);
  cleanupPathSync(process.env.LOOM_HOME);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a cross-lineage cut base is refused with nothing landed (solo + batch, never reusing branchDiverted), the refusal names the CORRECT remedy (not recycling/rebasing this worker — a fresh worker from current mainline, or switching the checkout back), an ordinary branch surviving repeated real union-merges lands normally (no false-positive contamination), a null/legacy cut base is grandfathered, a batch with one diverged candidate drops only that candidate without aborting the whole batch, and a genuinely unresolvable cut base fails CLOSED (never the null/legacy grandfathering shape)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
