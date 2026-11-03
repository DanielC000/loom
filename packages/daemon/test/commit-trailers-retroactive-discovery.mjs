import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card f9ada472 (child 4 of d9332365) — pins the SAFE, documented degrade of the four pure trailer-walk
// readers that have NO ledger fallback (unlike findLandedSquashCommit, see e8d4fdc3): findLaterBranchSquash,
// readLandedTipTrailer, findIntroducingSquashCommit, findAllLandedTrailerCommits. REAL git on temp repos, NO
// claude and NO live daemon, NO SessionService/Db (these four readers take only a repoPath).
//
// Analysis d9332365-commit-trailers.md §2e/§2f/§2d: with no `Loom-Worker-Branch:`/`Loom-Landed-Tip:`
// trailer ever written (orchestration.commitTrailers:"off"), each of these four readers is EXPECTED to
// already fail to its existing conservative "not found"/"absent" branch — never throw, never mis-report a
// landing as something it isn't. This file makes that a TESTED, named behaviour rather than an accident.
//
// Proves, each with a trailers-OFF absent case AND a trailers-ON positive control (same reader, same
// shape, trailer present) so the absent-case assertion is shown capable of failing:
//   (1) findLaterBranchSquash: a later landing of `branch` with NO trailer resolves "none" (never "found",
//       never "error") — (1b) the SAME shape WITH a trailer resolves "found".
//   (2) readLandedTipTrailer: a commit message with no Loom-Landed-Tip trailer resolves null (ABSENT,
//       never TRAILER_TIP_UNVERIFIABLE, never a throw) — (2b) a commit WITH the trailer resolves its own
//       (self-referential) sha.
//   (3) findIntroducingSquashCommit: no Loom-Worker-Branch trailer anywhere in history for `branch` makes
//       the grep find nothing, so the function returns `landedSha` UNCHANGED (fail-safe) — (3b) the SAME
//       two-commit shape WITH trailers resolves the OLDER of the two (the real "introducing" commit).
//   (4) findAllLandedTrailerCommits: no trailer anywhere resolves `[]` (never a throw) — (4b) the SAME
//       repo WITH a trailer resolves a non-empty array naming that exact commit.
//
// Run: 1) build (pnpm --filter @loom/daemon build), 2) node test/commit-trailers-retroactive-discovery.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distUrl = pathToFileURL(path.join(__dirname, "..", "dist", "git", "worktrees.js")).href;
const { findLaterBranchSquash, readLandedTipTrailer, findIntroducingSquashCommit, findAllLandedTrailerCommits, TRAILER_TIP_UNVERIFIABLE } = await import(distUrl);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=ctrd@loom -c user.name=ctrd";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-ctrd-repo-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(repo, { recursive: true });
  execSync(`git init -q && git config user.email ctrd@loom && git config user.name ctrd`, { cwd: repo });
  git(repo, `${GIT_ID} commit -q -m init --allow-empty`);
  return repo;
}

const tmpDirs = [];

try {
  // ===================== (1)/(1b) findLaterBranchSquash =====================
  {
    const repo = makeRepo("1"); tmpDirs.push(repo);
    const afterSha = git(repo, "rev-parse HEAD");
    const branch = "loom/ctrd-1";
    // (1) trailers OFF: a real later commit lands, with NO Loom-Worker-Branch trailer at all.
    git(repo, `${GIT_ID} commit -q -m "feat(x): trailers-off later landing" --allow-empty`);
    const none = await findLaterBranchSquash(repo, branch, afterSha);
    check("(1) trailers off: a later landing with no trailer resolves \"none\" (never \"found\", never \"error\")", none === "none");

    // (1b) POSITIVE CONTROL: the SAME shape, but the later commit genuinely carries the trailer.
    git(repo, `${GIT_ID} commit -q -m "feat(x): trailered later landing" -m "Loom-Worker-Branch: ${branch}" --allow-empty`);
    const found = await findLaterBranchSquash(repo, branch, afterSha);
    check("(1b) trailers on: the SAME reader resolves \"found\" once a real trailer exists (proves (1) isn't just always \"none\")", found === "found");
  }

  // ===================== (2)/(2b) readLandedTipTrailer =====================
  {
    const repo = makeRepo("2"); tmpDirs.push(repo);
    // (2) trailers OFF: an ordinary commit with no Loom-Landed-Tip trailer at all.
    git(repo, `${GIT_ID} commit -q -m "feat(x): trailers-off squash" --allow-empty`);
    const noTrailerSha = git(repo, "rev-parse HEAD");
    const absent = await readLandedTipTrailer(repo, noTrailerSha);
    check("(2) trailers off: a commit with no Loom-Landed-Tip trailer resolves null (ABSENT, not UNVERIFIABLE, not a throw)", absent === null);
    check("(2) ABSENT is genuinely distinct from the UNVERIFIABLE sentinel (never conflated)", absent !== TRAILER_TIP_UNVERIFIABLE);

    // (2b) POSITIVE CONTROL: a real worker-branch-tip commit (`tipSha`), then a SEPARATE "squash" commit
    // whose trailer PARAGRAPH names it — the real production shape: Loom-Landed-Tip NEVER appears alone,
    // always alongside Loom-Worker-Branch in the SAME final paragraph (parseTrailerParagraph requires a
    // branch line to accept the paragraph as a trailer block at all — card f9ada472, found while writing
    // this very test: a Loom-Landed-Tip-only paragraph is NOT a trailer, by design). The two lines must
    // land in ONE `-m` (two `-m`s make two separate paragraphs) — execFileSync avoids the shell mangling
    // an embedded newline inside a execSync-shelled string hits on this host.
    git(repo, `${GIT_ID} commit -q -m "feat(x): worker's pre-squash tip" --allow-empty`);
    const tipSha = git(repo, "rev-parse HEAD");
    const branch2b = "loom/ctrd-2b";
    execFileSync("git", ["-c", "user.email=ctrd@loom", "-c", "user.name=ctrd", "commit", "-q", "-m", "feat(x): trailered squash", "-m", `Loom-Worker-Branch: ${branch2b}\nLoom-Landed-Tip: ${tipSha}`, "--allow-empty"], { cwd: repo });
    const squashSha = git(repo, "rev-parse HEAD");
    const resolved = await readLandedTipTrailer(repo, squashSha);
    check("(2b) trailers on: the SAME reader resolves the real tip sha once a valid trailer exists (proves (2) isn't just always null)", resolved === tipSha);
  }

  // ===================== (3)/(3b) findIntroducingSquashCommit =====================
  {
    const repo = makeRepo("3"); tmpDirs.push(repo);
    const branch = "loom/ctrd-3";
    // (3) trailers OFF: the branch ref genuinely EXISTS (so the function's own branch-presence guard
    // passes and the attribution walk actually runs), but NO commit anywhere carries its trailer — the
    // real target of this scenario. Given an arbitrary `landedSha` (as findLandedSquashCommit's own
    // ledger fallback would hand it), the attribution-only walk must fail SAFE by returning that sha
    // UNCHANGED, never throwing and never guessing an older one.
    git(repo, `${GIT_ID} commit -q -m "feat(x): trailers-off landing" --allow-empty`);
    const landedSha = git(repo, "rev-parse HEAD");
    git(repo, `branch ${branch} ${landedSha}`);
    const unchanged = await findIntroducingSquashCommit(repo, branch, landedSha);
    check("(3) trailers off: with no trailer anywhere (branch ref present), the attribution walk returns landedSha UNCHANGED (fail-safe)", unchanged === landedSha);

    // (3b) POSITIVE CONTROL: the branch ref is LIVE and carries its own content change relative to main
    // (so the function's own "no changes of its own" early-return doesn't fire), and TWO main-side
    // commits carry the branch's trailer with content matching the branch's own final file state — the
    // OLDER one is the real "introducing" commit the function is meant to recover.
    const repoB = makeRepo("3b"); tmpDirs.push(repoB);
    const mainBranch = git(repoB, "symbolic-ref --short HEAD");
    git(repoB, `checkout -q -b ${branch}`);
    fs.writeFileSync(path.join(repoB, "file.txt"), "v1\n");
    git(repoB, "add -A"); git(repoB, `${GIT_ID} commit -q -m "feat(y): branch's own work"`);
    git(repoB, `${GIT_ID} commit -q -m "chore(y): re-task tick, no file change" --allow-empty`); // branch tip, same tree as its own work commit
    const branchTip = git(repoB, "rev-parse HEAD");
    git(repoB, `checkout -q ${mainBranch}`);
    git(repoB, `${GIT_ID} commit -q -m "feat(y): older introducing landing" -m "Loom-Worker-Branch: ${branch}" --allow-empty`);
    git(repoB, `checkout -q ${branch} -- file.txt`); git(repoB, "add -A");
    execSync(`git ${GIT_ID} commit --amend -q -m "feat(y): older introducing landing" -m "Loom-Worker-Branch: ${branch}"`, { cwd: repoB });
    const olderSha = git(repoB, "rev-parse HEAD");
    git(repoB, `${GIT_ID} commit -q -m "feat(y): newer landing, same branch re-landed" -m "Loom-Worker-Branch: ${branch}" --allow-empty`);
    const newerSha = git(repoB, "rev-parse HEAD");
    check("(3b) setup control: the branch tip's own diff from main is non-empty (file.txt)", git(repoB, `diff --name-only ${mainBranch}...${branch}`) === "file.txt");
    check("(3b) setup control: the older landing's content matches the branch's own final file state", git(repoB, `show ${olderSha}:file.txt`) === git(repoB, `show ${branchTip}:file.txt`));
    const introducer = await findIntroducingSquashCommit(repoB, branch, newerSha);
    check("(3b) trailers on: the SAME reader recovers the OLDER introducing commit once trailers exist (proves (3) isn't just always a no-op)", introducer === olderSha);
  }

  // ===================== (4)/(4b) findAllLandedTrailerCommits =====================
  {
    const repo = makeRepo("4"); tmpDirs.push(repo);
    const branch = "loom/ctrd-4";
    // (4) trailers OFF: no commit anywhere carries the branch's trailer.
    git(repo, `${GIT_ID} commit -q -m "feat(x): trailers-off landing" --allow-empty`);
    const empty = await findAllLandedTrailerCommits(repo, branch);
    check("(4) trailers off: with no trailer anywhere, resolves [] (never a throw, never a fabricated candidate)", Array.isArray(empty) && empty.length === 0);

    // (4b) POSITIVE CONTROL: the SAME repo, but a later commit genuinely carries the trailer.
    git(repo, `${GIT_ID} commit -q -m "feat(x): trailered landing" -m "Loom-Worker-Branch: ${branch}" --allow-empty`);
    const trailerSha = git(repo, "rev-parse HEAD");
    const found = await findAllLandedTrailerCommits(repo, branch);
    check("(4b) trailers on: the SAME reader finds the real candidate once a trailer exists (proves (4) isn't just always [])", found.length === 1 && found[0]?.sha === trailerSha);
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — findLaterBranchSquash/readLandedTipTrailer/findIntroducingSquashCommit/findAllLandedTrailerCommits all fail safe to their existing \"not found\"/absent branch when no Loom-* trailer exists (orchestration.commitTrailers:\"off\", or any gap in trailer history), never throwing and never mis-reporting a landing — and each is shown capable of finding a real candidate once a trailer genuinely exists, proving the absent-case result isn't a broken reader."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
