import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card cd92e609 — attribute an already-landed branch to the commit that actually INTRODUCED its content.
// REAL git on temp repos, no claude, no daemon. Two commits on main carry the same `Loom-Worker-Branch:` trailer
// (a recycled / re-tasked branch name); main's tree still holds the branch's content in both.
//   (1) RED-first: the lookup names the NEWER trailer commit (which introduced nothing of the branch's); findIntroducingSquashCommit (attribution only) names the introducer,
//       while findLandedSquashCommit stays BIT-IDENTICAL (still the newest) — the pin-safety control: gating/pinning must not move.
//   (2) CONTROL: a single trailer commit is still returned as-is.
//   (3) CONTROL: when the NEWER commit itself changed the branch's paths away from the branch tip, the verdict stays null.
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
}
function laterTrailerCommit(repo, branch, file, content) {
  fs.writeFileSync(path.join(repo, file), content);
  execSync(`git add -A && git ${ID} commit -q -m "feat(x): second task on a re-used branch name" -m "Loom-Worker-Branch: ${branch}"`, { cwd: repo });
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
  // (3) control: newer trailer commit rewrites the branch's own path -> content no longer holds -> null (never more permissive).
  {
    const repo = newRepo("rewrite");
    const branch = "loom/lca-branch-c";
    branchWithWork(repo, branch, "file-c.txt", "branch c content\n");
    await mergeBranch(repo, branch, "feat(x): landing c");
    laterTrailerCommit(repo, branch, "file-c.txt", "someone else rewrote it\n");
    check("(3) control: newest trailer commit no longer holds the branch's content -> null, older commit is NOT resurrected", (await findLandedSquashCommit(repo, branch)) === null);
  }
} finally {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}
console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
