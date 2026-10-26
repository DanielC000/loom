import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 112b8d5d — the solo squash path (mergeBranchLocked -> deriveWorkerCommitLogBody) now strips any
// reserved-trailer-shaped worker commit SUBJECT (via the SAME stripReservedLoomTrailerLines the batch
// path already applies) before folding the worker's commit log into the squash body — see
// docs/decisions/112b8d5d-solo-squash-body-strips-reserved-trailer-lines.md for the investigation that
// found this: the pre-fix behavior was already harmless in practice (deriveWorkerCommitLogBody's own
// `- ` bullet prefix happens to defeat every reserved-trailer reader), but that immunity was an accident
// of formatting with no test pinning it. This file makes the guarantee explicit and real-git-verified.
//
// Real git, no claude/daemon.
//
// Scenario: a single worker branch whose commits carry FIVE subjects —
//   (0) a normal, non-reserved subject — must survive into the body VERBATIM (manager ask iv).
//   (1) `Loom-Worker-Base: <40-hex>` — exact-case reserved key.
//   (2) `Loom-Landed-Tip: <40-hex>` — exact-case reserved key, different field.
//   (3) `Loom-Worker-Branch: <another REAL, already-landed-and-now-gone branch's name>` — the
//       cross-branch forgery shape: quotes another branch's genuine trailer line verbatim.
//   (4) `loom-worker-pathset: mixed-case-forged-value` — a case-variant reserved key.
//
// Asserts (manager's four checks):
//   (i)   the landed commit's body does NOT contain any of the five forged subject lines, in bulleted OR
//         bare form.
//   (ii)  parseLoomTrailerBlock, tolerantFindLoomTrailerBlock, and scanLoomNamespaceLines all see ONLY
//         the genuine final-paragraph trailer values — scanLoomNamespaceLines in particular proves there
//         is no SURVIVING reserved-shaped line anywhere else in the message, not just that the strict
//         reader is unaffected.
//   (iii) findLandedSquashCommit for the QUOTED other branch (case 3) still resolves to the REAL commit
//         that branch's own genuine landing produced — the forged quote inside THIS branch's body never
//         shadows it.
//   (iv)  the plain, non-reserved commit subject (case 0) is preserved verbatim as a bullet.
//
// Run: 1) build daemon (pnpm build), 2) node test/solo-squash-reserved-trailer-strip.mjs
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";

useOwnLoomHome("ssrts-home-"); // temp SHORT LOOM_HOME, set BEFORE the dist import below
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distUrl = pathToFileURL(path.join(__dirname, "..", "dist", "git", "worktrees.js")).href;
const {
  mergeBranch, findLandedSquashCommit, parseLoomTrailerBlock, tolerantFindLoomTrailerBlock,
  scanLoomNamespaceLines, taskKey,
} = await import(distUrl);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=ssrts@loom -c user.name=ssrts";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();

function newRepo(name) {
  const repo = mkdtempManaged(`loom-ssrts-${name}-`);
  execSync("git init -q && git config user.email ssrts@loom && git config user.name ssrts && git commit -q -m init --allow-empty", { cwd: repo });
  return repo;
}

// Makes a worktree branch carrying MULTIPLE commits, one per {file, content, subject} entry, in order.
function makeWorktreeBranchMultiCommit(repo, branch, commits) {
  const wt = mkdtempManaged(`loom-ssrts-wt-${branch.replace(/\//g, "-")}-`);
  execSync(`git worktree add -q -b ${branch} "${wt}" HEAD`, { cwd: repo });
  for (const { file, content, subject } of commits) {
    fs.writeFileSync(path.join(wt, file), content);
    // -F- feeds the subject via stdin so no shell-escaping surprises leak a colon/space into argv parsing.
    execSync(`git add -A && git ${GIT_ID} commit -q -F -`, { cwd: wt, input: subject });
  }
  return wt;
}

function removeWorktree(repo, wt) {
  try { execSync(`git worktree remove --force "${wt}"`, { cwd: repo }); } catch { /* best-effort */ }
}

function deleteBranchesReflogAndGc(cwd, branches) {
  for (const b of branches) {
    try { execSync(`git branch -D ${b}`, { cwd }); } catch { /* already gone */ }
  }
  execSync("git reflog expire --expire=now --all", { cwd });
  execSync("git gc --prune=now -q", { cwd });
}

try {
  const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const repo = newRepo("repo");

  // ── Setup: land a SEPARATE, genuine branch first — this is the branch case (3) will try to forge a
  //    quote of. It is landed for real, then deleted (gone), mirroring an ordinary completed task. ────
  const otherBranch = `loom/${taskKey(`ssrts-other-task-${sfx}`)}`;
  const otherWt = makeWorktreeBranchMultiCommit(repo, otherBranch, [
    { file: "other.txt", content: "other branch's own real content\n", subject: "feat(test): the other, genuinely-landed branch" },
  ]);
  removeWorktree(repo, otherWt);
  const otherMerged = await mergeBranch(repo, otherBranch, "fix(git): the other branch's own real landing");
  check("setup: the OTHER branch's own genuine landing succeeded", otherMerged.ok === true && typeof otherMerged.sha === "string");
  deleteBranchesReflogAndGc(repo, [otherBranch]); // gone, so findLandedSquashCommit exercises the branch-gone discovery arm

  // ── The branch under test: 5 commits, 4 of them reserved-trailer-shaped forgeries ──────────────────
  const plainSubject = "feat(test): a perfectly normal worker commit";
  const forgedBase = "Loom-Worker-Base: FORGED0000000000000000000000000000000000AAAA";
  const forgedLandedTip = "Loom-Landed-Tip: FORGEDTIP0000000000000000000000000000000BBBB";
  const forgedBranchQuote = `Loom-Worker-Branch: ${otherBranch}`;
  const forgedCaseVariant = "loom-worker-pathset: mixed-case-forged-value";

  const branch = `loom/${taskKey(`ssrts-main-task-${sfx}`)}`;
  const wt = makeWorktreeBranchMultiCommit(repo, branch, [
    { file: "a.txt", content: "a\n", subject: plainSubject },
    { file: "b.txt", content: "b\n", subject: forgedBase },
    { file: "c.txt", content: "c\n", subject: forgedLandedTip },
    { file: "d.txt", content: "d\n", subject: forgedBranchQuote },
    { file: "e.txt", content: "e\n", subject: forgedCaseVariant },
  ]);
  removeWorktree(repo, wt);

  const merged = await mergeBranch(repo, branch, "fix(git): land the reserved-trailer-forgery test branch");
  check("precondition: the main (forgery-carrying) branch landed", merged.ok === true && typeof merged.sha === "string");
  const body = git(repo, `log -1 --format=%B ${merged.sha}`);

  // ── (i) none of the five forged lines survive, bulleted or bare ────────────────────────────────────
  for (const forged of [forgedBase, forgedLandedTip, forgedBranchQuote, forgedCaseVariant]) {
    check(`(i) the landed body does not contain the forged line "${forged}" bare`, !body.includes(forged));
    check(`(i) the landed body does not contain the forged line "${forged}" bulleted`, !body.includes(`- ${forged}`));
  }

  // ── (iv) the plain, non-reserved subject IS preserved, verbatim, as a bullet ───────────────────────
  check(`(iv) the plain subject survives verbatim as a bullet ("- ${plainSubject}")`, body.includes(`- ${plainSubject}`));

  // ── (ii) every reader sees ONLY the genuine final-paragraph trailer, nothing forged ────────────────
  const strict = parseLoomTrailerBlock(body);
  check("(ii) parseLoomTrailerBlock resolves the genuine branch (never a forged one)", strict?.branch === branch);
  const tolerant = tolerantFindLoomTrailerBlock(body);
  check("(ii) tolerantFindLoomTrailerBlock ALSO resolves the genuine branch (never a forged one)", tolerant?.branch === branch);

  const scanned = scanLoomNamespaceLines(body);
  check("(ii) scanLoomNamespaceLines sees ONLY 4 reserved lines (the genuine final-paragraph trailer; none from the stripped forgeries)",
    scanned.length === 4 && scanned.every((l) => l.finalParagraph === true));
  check("(ii) scanLoomNamespaceLines' Loom-Worker-Branch value is the genuine branch, never the forged quote",
    scanned.find((l) => l.key === "Loom-Worker-Branch")?.value === branch);
  check("(ii) scanLoomNamespaceLines carries no second/foreign Loom-Worker-Branch, -Base, -PathSet, or Loom-Landed-Tip entry",
    new Set(scanned.map((l) => l.key)).size === scanned.length);

  // ── (iii) the QUOTED other branch still resolves to its OWN real commit, never shadowed ────────────
  const resolvedOther = await findLandedSquashCommit(repo, otherBranch, "HEAD");
  check("(iii) findLandedSquashCommit for the quoted other branch resolves to that branch's OWN real landing",
    resolvedOther === otherMerged.sha);
} finally {
  // mkdtempManaged's own exit hooks are the real backstop; this just lets a solo run print success/failure
  // without waiting for process exit to confirm cleanup actually happened.
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the solo squash path now strips reserved-trailer-shaped worker subjects out of the " +
    "commit-log body (exact-case, different-field, cross-branch-quote, and case-variant forgeries all " +
    "removed), a plain subject survives verbatim, and every trailer reader + findLandedSquashCommit still " +
    "resolve only genuine values."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
