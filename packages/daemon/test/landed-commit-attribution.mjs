import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card cd92e609 — attribute an already-landed branch to the commit that actually INTRODUCED its content.
// REAL git on temp repos, no claude, no daemon. Two commits on main carry the same `Loom-Worker-Branch:` trailer
// (a recycled / re-tasked branch name); main's tree still holds the branch's content in both.
//   (1) RED-first: the lookup names the NEWER trailer commit (which introduced nothing of the branch's); findIntroducingSquashCommit (attribution only) names the introducer,
//       while findLandedSquashCommit stays BIT-IDENTICAL (still the newest) — the pin-safety control: gating/pinning must not move.
//   (2) CONTROL: a single trailer commit is still returned as-is.
//   (3) card c0d0eac9's newest-VERIFIED-wins walk, with the single-attempt answer as a FLOOR: on the branch-PRESENT
//       arm, a newer trailer commit whose content genuinely no longer matches the live branch (a definitive
//       mismatch — never forged-to-match, never an injected error) must not abort the lookup; the walk falls
//       through to the OLDER trailer commit, whose content still genuinely matches, and returns IT, never null.
//       This is the FIRST test of walk-past-on-a-genuine-content-mismatch on the branch-present arm — c0d0eac9's
//       own suite only ever exercised this shape on the branch-gone/ledger arm (CAP-FLOOR) or with a
//       forged-to-match decoy (TRANSIENT-FAULT / SHADOW-PRESENT-ARM). See docs/decisions/c0d0eac9-*.md.
//   (3b) CONTROL: when NEITHER trailer commit's content matches the live branch (a third, later change to the
//       branch's own file), the walk still returns null — "never more permissive" stays meaningful for the case
//       that actually needs it: no verified candidate at all, not merely "the newest one failed."
// Run: pnpm build, then node test/landed-commit-attribution.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { mergeBranch, findLandedSquashCommit, findIntroducingSquashCommit } = await import(pathToFileURL(path.join(__dirname, "..", "dist", "git", "worktrees.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const ID = "-c user.email=lca@loom -c user.name=lca";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const tmpDirs = [];

function newRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-lca-${tag}-${sfx}`);
  tmpDirs.push(repo);
  fs.mkdirSync(repo, { recursive: true });
  execSync(`git init -q && git config user.email lca@loom && git config user.name lca && git ${ID} commit -q -m init --allow-empty`, { cwd: repo });
  return repo;
}
function branchWithWork(repo, branch, file, content) {
  const wt = path.join(os.tmpdir(), `loom-lca-wt-${branch.replace(/\//g, "-")}-${sfx}`);
  tmpDirs.push(wt);
  execSync(`git worktree add -q -b ${branch} "${wt}" HEAD`, { cwd: repo });
  fs.writeFileSync(path.join(wt, file), content);
  execSync(`git add -A && git ${ID} commit -q -m "${branch} work"`, { cwd: wt });
  return wt;
}
function laterTrailerCommit(repo, branch, file, content) {
  fs.writeFileSync(path.join(repo, file), content);
  execSync(`git add -A && git ${ID} commit -q -m "feat(x): second task on a re-used branch name" -m "Loom-Worker-Branch: ${branch}"`, { cwd: repo });
  return git(repo, "rev-parse HEAD");
}
// @decision c0d0eac9 round 7, finding 1 — never build a fixture whose own ordering claim depends on
// `git log`'s default tie-break (parent order) at the same wall-clock committer-date second. Pins the new
// trailer commit's date to `afterSha`'s own committer date + 5s, so it sorts strictly newer on any clock.
function laterTrailerCommitAfter(repo, branch, file, content, afterSha) {
  const epoch = Number(git(repo, `log -1 --format=%ct ${afterSha}`)) + 5;
  const committerDate = `@${epoch} +0000`;
  fs.writeFileSync(path.join(repo, file), content);
  execSync(`git add -A && git ${ID} commit -q -m "feat(x): second task on a re-used branch name" -m "Loom-Worker-Branch: ${branch}"`,
    { cwd: repo, env: { ...process.env, GIT_COMMITTER_DATE: committerDate, GIT_AUTHOR_DATE: committerDate } });
  return git(repo, "rev-parse HEAD");
}

try {
  // (1) two same-branch trailer commits; the NEWER one touches only an unrelated path.
  {
    const repo = newRepo("two");
    const branch = "loom/lca-branch-a";
    branchWithWork(repo, branch, "file-a.txt", "branch a content\n");
    const first = await mergeBranch(repo, branch, "feat(x): first landing");
    check("(1) precondition: real squash landed", first.ok === true && typeof first.sha === "string");
    const newer = laterTrailerCommit(repo, branch, "other.txt", "unrelated\n");
    check("(1) precondition: newer trailer commit is newer and did NOT touch the branch's path",
      newer !== first.sha && git(repo, `diff --name-only ${newer}~1 ${newer}`) === "other.txt");
    const looked = await findLandedSquashCommit(repo, branch);
    check("(1) PIN-SAFETY CONTROL: findLandedSquashCommit is unchanged — still the NEWEST trailer commit", looked === newer);
    const got = await findIntroducingSquashCommit(repo, branch, looked);
    check("(1) the attributed commit is the one that INTRODUCED the branch's content, not the newer trailer commit", got === first.sha);
    check("(1) a sha not in the trailer list falls back to itself (never invents one)", (await findIntroducingSquashCommit(repo, branch, "0".repeat(40))) === "0".repeat(40));
    check("(1) a nonexistent repo falls back to the given sha (fail-safe)", (await findIntroducingSquashCommit(path.join(os.tmpdir(), `loom-lca-nope-${sfx}`), branch, newer)) === newer);
  }
  // (2) control: a single trailer commit is returned unchanged.
  {
    const repo = newRepo("one");
    const branch = "loom/lca-branch-b";
    branchWithWork(repo, branch, "file-b.txt", "branch b content\n");
    const only = await mergeBranch(repo, branch, "feat(x): only landing");
    check("(2) control: a single trailer commit is returned as-is", (await findLandedSquashCommit(repo, branch)) === only.sha);
    check("(2) control: a single trailer commit attributes to itself", (await findIntroducingSquashCommit(repo, branch, only.sha)) === only.sha);
  }
  // (3) card c0d0eac9: the branch stays PRESENT; a newer trailer commit DEFINITIVELY fails the content
  //     check (rewrites the branch's own path away from the branch's live tip) -> the walk falls through
  //     to the OLDER trailer commit (the real squash), which still genuinely content-matches the live
  //     branch -> findLandedSquashCommit returns the ORIGINAL squash, never null. (Pre-c0d0eac9, the
  //     single-candidate code tried only the newest candidate and returned null on its failure — see the
  //     RED proof below, run against that commit's own dist.)
  {
    const repo = newRepo("rewrite");
    const branch = "loom/lca-branch-c";
    branchWithWork(repo, branch, "file-c.txt", "branch c content\n");
    const landing = await mergeBranch(repo, branch, "feat(x): landing c");
    check("(3) precondition: the original squash landed", landing.ok === true && typeof landing.sha === "string");
    laterTrailerCommit(repo, branch, "file-c.txt", "someone else rewrote it\n");
    check("(3) card c0d0eac9: newest trailer commit's content no longer matches the live branch -> the walk falls through to the OLDER, still-verifying landing (never null)",
      (await findLandedSquashCommit(repo, branch)) === landing.sha);
  }
  // (3b) control: when NEITHER trailer commit's content matches the live branch (a THIRD, later change to
  //      the branch's own file, after both land), the walk still returns null — "never more permissive"
  //      stays meaningful for the case that actually needs it: no verified candidate at all.
  {
    const repo = newRepo("rewrite-both-stale");
    const branch = "loom/lca-branch-d";
    const wt = branchWithWork(repo, branch, "file-d.txt", "branch d content\n");
    const landing = await mergeBranch(repo, branch, "feat(x): landing d");
    check("(3b) precondition: the original squash landed", landing.ok === true && typeof landing.sha === "string");
    const newer = laterTrailerCommitAfter(repo, branch, "file-d.txt", "someone else rewrote it\n", landing.sha);
    check("(3b) setup control: newest-first ordering really holds (git log lists the newer trailer commit before the original squash)",
      git(repo, "log --format=%H").split("\n")[0] === newer);
    // Move the LIVE branch's own file to a THIRD value, distinct from BOTH the original landing's
    // content and the later trailer commit's content — neither candidate's content can ever match it.
    fs.writeFileSync(path.join(wt, "file-d.txt"), "yet another, third value\n");
    execSync(`git add -A && git ${ID} commit -q -m "${branch} more work"`, { cwd: wt });
    check("(3b) control: neither trailer commit's content matches the live branch's CURRENT tip -> null",
      (await findLandedSquashCommit(repo, branch)) === null);
  }
} finally {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}
console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
