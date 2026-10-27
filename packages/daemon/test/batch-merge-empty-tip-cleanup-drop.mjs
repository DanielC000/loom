import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// CARD 458028ae — see docs/decisions/458028ae-predict-git-cleanup-before-batch-commit.md for the full
// defect (a batch tip whose message collapses to nothing but blank lines promotes its own
// Loom-Worker-Branch trailer into the subject, landing SILENTLY unreadable since decision 45036494) and
// the fix (predictGitCleanupWhitespace + a pre-commit drop, same remedy as the A2 reserved-subject drop).
//
// (E1) an EMPTY-MESSAGE tip (`--allow-empty-message`) alongside a GOOD sibling — good lands, empty drops
//      (never headMoved), main advances with only good's content.
// (E2) same shape via a `commit-tree`-authored literal blank-first-line body — a DIFFERENT raw authoring
//      path reaching the same post-trim empty `originalMessage`, proving the fix catches both.
// (E3) (E1)'s dropped candidate retried via the ordinary SOLO merge path — lands with a READABLE trailer.
// (E4) Code Review (session e8f1f410) item 2 — a tip message that is genuinely non-blank (a lone `\f`,
//      content to real git, never blank) must NOT be dropped; proves the fix doesn't over-drop.
// (P1) Code Review item 1 — a `#`-subject tip landed under an ambient `commit.cleanup=strip` repo config:
//      proves the `--cleanup=whitespace` pin is load-bearing (without it, the real commit silently
//      diverges from this predictor's own whitespace-mode assumption and the trailer goes unreadable).
//
// Run: 1) build daemon (pnpm build), 2) node test/batch-merge-empty-tip-cleanup-drop.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), `loom-no-such-codex-bin-${process.pid}`);
useOwnLoomHome("bmetcd-home-");

requireHermeticEnv();

const { createWorktree, mergeBranch, parseLoomTrailerBlock } = await import("../dist/git/worktrees.js");
const { runBatchedMerge } = await import("../dist/git/batch-merge.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const IDENT = { GIT_AUTHOR_NAME: "bmetcd", GIT_AUTHOR_EMAIL: "bmetcd@loom", GIT_COMMITTER_NAME: "bmetcd", GIT_COMMITTER_EMAIL: "bmetcd@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
// UNTRIMMED variant — `git()`'s own `.trim()` would eat a leading `\f`/whitespace-shaped byte from a
// `%B` read before (E4) ever gets to compare it; use this for any raw message-body check.
const gitRaw = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] });
const GIT_ID = "-c user.email=bmetcd@loom -c user.name=bmetcd";
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Only a plain projectId string is needed — createWorktree never looks up a real DB row for it (used
// purely for worktree-path/branch naming), matching the sibling batch-merge-head-moved-commit-identity.mjs.
const P = { projId: `bmetcd-proj-${sfx}` };

try {
  // ── (E1) empty-message tip via `--allow-empty-message`, alongside a good sibling candidate.
  {
    const repo = path.join(os.tmpdir(), `loom-bmetcd-e1-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# bmetcd-e1\n");
    git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "bmetcd@loom"); git(repo, "config", "user.name", "bmetcd");
    commitAll(repo, "init", GIT_ID);
    const baseMainSha = git(repo, "rev-parse", "HEAD");

    const { worktreePath: goodWt, branch: goodBranch } = await createWorktree(repo, P.projId, `bmetcd-e1-good-${sfx}`);
    registerForCleanup(goodWt);
    fs.writeFileSync(path.join(goodWt, "e1-good.txt"), "good\n");
    commitAll(goodWt, "feat(x): change e1 good", GIT_ID);

    const { worktreePath: evilWt, branch: evilBranch } = await createWorktree(repo, P.projId, `bmetcd-e1-evil-${sfx}`);
    registerForCleanup(evilWt);
    fs.writeFileSync(path.join(evilWt, "e1-evil.txt"), "evil\n");
    git(evilWt, "add", "-A");
    // The worker's OWN empty-message commit — not Loom's. `--allow-empty-message` is what makes git
    // accept this at all; an ordinary `git commit -m ""` refuses with "Aborting commit due to empty
    // commit message".
    git(evilWt, "commit", "-q", "--allow-empty-message", "-m", "");
    check("(E1) precondition: the evil commit's own message really is empty", git(evilWt, "log", "-1", "--format=%B", "HEAD") === "");

    const { worktreePath: batchWt } = await createWorktree(repo, P.projId, `bmetcd-e1-batch-${sfx}`);
    registerForCleanup(batchWt);

    const passGate = async () => ({ passed: true });
    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [
      { workerSessionId: "bmetcd-e1-good-w1", taskId: "bmetcd-e1-good-t1", branch: goodBranch, cutBaseSha: null },
      { workerSessionId: "bmetcd-e1-evil-w1", taskId: "bmetcd-e1-evil-t1", branch: evilBranch, cutBaseSha: null },
    ], passGate);

    check("(E1) the batch still SUCCEEDS overall — an empty-message tip is a worker-authored defect, not a racer tamper", result.ok === true);
    check("(E1) the good candidate LANDED", result.landed.some((l) => l.branch === goodBranch));
    check("(E1) the empty-message candidate was DROPPED, never landed, and never typed headMoved",
      !result.landed.some((l) => l.branch === evilBranch) && result.dropped.some((d) => d.branch === evilBranch) && result.batchHeadMoved !== true);
    check("(E1) the drop reason names the cleanup/unreadable defect, not a generic tamper",
      /cleanup|unreadable/i.test(result.dropped.find((d) => d.branch === evilBranch)?.reason ?? ""));
    check("(E1) canonical main advanced with ONLY the good candidate's content",
      git(repo, "rev-parse", "HEAD") !== baseMainSha && fs.existsSync(path.join(repo, "e1-good.txt")) && !fs.existsSync(path.join(repo, "e1-evil.txt")));

    // ── (E3) the dropped (E1) candidate solo-merges with a READABLE trailer.
    const soloResult = await mergeBranch(repo, evilBranch, "fix(x): land e1 evil via solo retry", { timeoutMs: 60_000 });
    check("(E3) the solo retry of the dropped empty-message candidate SUCCEEDS", soloResult.ok === true && typeof soloResult.sha === "string");
    const soloBody = soloResult.sha ? git(repo, "log", "-1", "--format=%B", soloResult.sha) : "";
    const soloTrailer = parseLoomTrailerBlock(soloBody);
    check("(E3) the solo-landed commit's trailer is READABLE and names the dropped branch", soloTrailer !== null && soloTrailer.branch === evilBranch);
    check("(E3) the evil candidate's content now lands via the solo retry", fs.existsSync(path.join(repo, "e1-evil.txt")));
  }

  // ── (E2) blank-first-line tip authored via `commit-tree` (never through `git commit`'s own cleanup),
  //     alongside a good sibling candidate — the SAME predicted-cleanup check must catch this DIFFERENT
  //     raw-authoring path too.
  {
    const repo = path.join(os.tmpdir(), `loom-bmetcd-e2-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# bmetcd-e2\n");
    git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "bmetcd@loom"); git(repo, "config", "user.name", "bmetcd");
    commitAll(repo, "init", GIT_ID);
    const baseMainSha = git(repo, "rev-parse", "HEAD");

    const { worktreePath: goodWt, branch: goodBranch } = await createWorktree(repo, P.projId, `bmetcd-e2-good-${sfx}`);
    registerForCleanup(goodWt);
    fs.writeFileSync(path.join(goodWt, "e2-good.txt"), "good\n");
    commitAll(goodWt, "feat(x): change e2 good", GIT_ID);

    const { worktreePath: evilWt, branch: evilBranch } = await createWorktree(repo, P.projId, `bmetcd-e2-evil-${sfx}`);
    registerForCleanup(evilWt);
    fs.writeFileSync(path.join(evilWt, "e2-evil.txt"), "evil\n");
    git(evilWt, "add", "-A");
    const evilTree = git(evilWt, "write-tree");
    // Remove the worktree BEFORE force-moving its branch ref — same precondition
    // batch-merge-head-moved-commit-identity.mjs's own (L2) scenario uses: a branch checked out in a
    // worktree can't be force-moved while checked out.
    execFileSync("git", ["worktree", "remove", "--force", evilWt], { cwd: repo });
    // `commit-tree` applies NO cleanup to its own `-m` message by default (unlike `git commit`), so this
    // is the one way to put a literal blank-first-line body into a real commit object.
    const evilSha = execFileSync("git", ["commit-tree", evilTree, "-p", baseMainSha, "-m", "\n"], { cwd: repo, encoding: "utf8", env: { ...process.env, ...IDENT } }).trim();
    git(repo, "update-ref", `refs/heads/${evilBranch}`, evilSha);
    check("(E2) precondition: the evil commit's own message reduces to nothing but whitespace", git(repo, "log", "-1", "--format=%B", evilSha).trim() === "");

    const { worktreePath: batchWt } = await createWorktree(repo, P.projId, `bmetcd-e2-batch-${sfx}`);
    registerForCleanup(batchWt);

    const passGate = async () => ({ passed: true });
    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [
      { workerSessionId: "bmetcd-e2-good-w1", taskId: "bmetcd-e2-good-t1", branch: goodBranch, cutBaseSha: null },
      { workerSessionId: "bmetcd-e2-evil-w1", taskId: "bmetcd-e2-evil-t1", branch: evilBranch, cutBaseSha: null },
    ], passGate);

    check("(E2) the batch still SUCCEEDS overall", result.ok === true);
    check("(E2) the good candidate LANDED", result.landed.some((l) => l.branch === goodBranch));
    check("(E2) the blank-first-line candidate was DROPPED, never landed, and never typed headMoved",
      !result.landed.some((l) => l.branch === evilBranch) && result.dropped.some((d) => d.branch === evilBranch) && result.batchHeadMoved !== true);
    check("(E2) the drop reason names the cleanup/unreadable defect, not a generic tamper",
      /cleanup|unreadable/i.test(result.dropped.find((d) => d.branch === evilBranch)?.reason ?? ""));
    check("(E2) canonical main advanced with ONLY the good candidate's content",
      git(repo, "rev-parse", "HEAD") !== baseMainSha && fs.existsSync(path.join(repo, "e2-good.txt")) && !fs.existsSync(path.join(repo, "e2-evil.txt")));
  }
  // ── (E4) Code Review (session e8f1f410) item 2: a tip message that is genuinely NON-blank under git's
  //     own byte-narrow blank test (a lone form-feed, `\f` — real CONTENT to git, never blank — MEASURED
  //     against real `git stripspace`) must NOT be dropped. The worker's own commit quotes a STALE
  //     `Loom-Worker-Branch:` line (the 5e323196/R2 shape) after its `\f` subject, so once
  //     `stripReservedLoomTrailerLines` removes that stale line (never touching the subject itself), the
  //     RESIDUAL body is exactly the lone `\f` — the one shape that actually reaches the predictor
  //     un-eaten by the EARLIER `originalMessage.replace(/\s+$/, "")` trim (that trim's own JS `\s` class
  //     also misclassifies `\f` as blank, so a message that is ENTIRELY `\f` is eaten before the predictor
  //     ever sees it either way — this residual-after-strip construction is what makes the two predictors
  //     actually disagree on OUTCOME, not just on the unit directly).
  {
    const repo = path.join(os.tmpdir(), `loom-bmetcd-e4-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# bmetcd-e4\n");
    git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "bmetcd@loom"); git(repo, "config", "user.name", "bmetcd");
    commitAll(repo, "init", GIT_ID);
    const baseMainSha = git(repo, "rev-parse", "HEAD");

    const { worktreePath: goodWt, branch: goodBranch } = await createWorktree(repo, P.projId, `bmetcd-e4-good-${sfx}`);
    registerForCleanup(goodWt);
    fs.writeFileSync(path.join(goodWt, "e4-good.txt"), "good\n");
    commitAll(goodWt, "feat(x): change e4 good", GIT_ID);

    const { worktreePath: evilWt, branch: evilBranch } = await createWorktree(repo, P.projId, `bmetcd-e4-evil-${sfx}`);
    registerForCleanup(evilWt);
    fs.writeFileSync(path.join(evilWt, "e4-evil.txt"), "evil\n");
    git(evilWt, "add", "-A");
    const evilTree = git(evilWt, "write-tree");
    execFileSync("git", ["worktree", "remove", "--force", evilWt], { cwd: repo });
    // `commit-tree` applies NO cleanup, so the literal `\f` subject + the stale quoted trailer line both
    // land verbatim, exactly as a worker's own (non-`git commit -m`) authoring path might produce.
    const evilSha = execFileSync("git", ["commit-tree", evilTree, "-p", baseMainSha, "-m", "\f\nLoom-Worker-Branch: some-other-branch"], { cwd: repo, encoding: "utf8", env: { ...process.env, ...IDENT } }).trim();
    git(repo, "update-ref", `refs/heads/${evilBranch}`, evilSha);
    check("(E4) precondition: the evil commit's own subject is the lone form-feed byte", gitRaw(repo, "log", "-1", "--format=%B", evilSha).replace(/\s+$/, "") === "\f\nLoom-Worker-Branch: some-other-branch");

    const { worktreePath: batchWt } = await createWorktree(repo, P.projId, `bmetcd-e4-batch-${sfx}`);
    registerForCleanup(batchWt);

    const passGate = async () => ({ passed: true });
    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [
      { workerSessionId: "bmetcd-e4-good-w1", taskId: "bmetcd-e4-good-t1", branch: goodBranch, cutBaseSha: null },
      { workerSessionId: "bmetcd-e4-evil-w1", taskId: "bmetcd-e4-evil-t1", branch: evilBranch, cutBaseSha: null },
    ], passGate);

    check("(E4) the batch succeeds", result.ok === true);
    check("(E4) the good candidate LANDED", result.landed.some((l) => l.branch === goodBranch));
    check("(E4) the lone-form-feed candidate LANDED too — NEVER dropped (it is genuinely non-blank, not the defect shape)", result.landed.some((l) => l.branch === evilBranch));
    const e4Entry = result.landed.find((l) => l.branch === evilBranch);
    check("(E4) the worker's own stale quoted trailer line WAS stripped", (e4Entry?.strippedReservedLineCount ?? 0) > 0);
    const e4Body = e4Entry?.sha ? gitRaw(repo, "log", "-1", "--format=%B", e4Entry.sha) : "";
    const e4Trailer = parseLoomTrailerBlock(e4Body);
    check("(E4) the landed trailer is READABLE and names THIS branch, never the stale quoted one", e4Trailer !== null && e4Trailer.branch === evilBranch);
    check("(E4) the landed message's own first paragraph still carries the literal form-feed byte, never silently dropped", e4Body.split(/\n(?:[ \t]*\n)+/)[0] === "\f");
    check("(E4) canonical main advanced with BOTH candidates' content", git(repo, "rev-parse", "HEAD") !== baseMainSha && fs.existsSync(path.join(repo, "e4-good.txt")) && fs.existsSync(path.join(repo, "e4-evil.txt")));
  }

  // ── (P1) Code Review item 1: an ambient `commit.cleanup=strip` REPO config (e.g. a self-hosting host's
  //     own ~/.gitconfig) must not defeat the `--cleanup=whitespace` PIN — the predictor only ever models
  //     `whitespace` mode, so without the pin the REAL commit would silently diverge onto `strip` mode and
  //     strip the `#`-subject tip's own comment line, landing the exact silent-unreadable trailer this
  //     card exists to prevent. Proves the pin is load-bearing, not a no-op (see the decision record for
  //     the direct real-git measurement of this exact divergence).
  {
    const repo = path.join(os.tmpdir(), `loom-bmetcd-p1-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# bmetcd-p1\n");
    git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "bmetcd@loom"); git(repo, "config", "user.name", "bmetcd");
    commitAll(repo, "init", GIT_ID);
    // Set AFTER init: a genuinely repo-level config, shared by every worktree of this repo (including the
    // batch worktree `landBranchCommitsIndividually` commits in) unless explicitly overridden on the argv.
    git(repo, "config", "commit.cleanup", "strip");
    const baseMainSha = git(repo, "rev-parse", "HEAD");

    const { worktreePath: goodWt, branch: goodBranch } = await createWorktree(repo, P.projId, `bmetcd-p1-good-${sfx}`);
    registerForCleanup(goodWt);
    fs.writeFileSync(path.join(goodWt, "p1-good.txt"), "good\n");
    commitAll(goodWt, "feat(x): change p1 good", GIT_ID);

    const { worktreePath: tipWt, branch: tipBranch } = await createWorktree(repo, P.projId, `bmetcd-p1-tip-${sfx}`);
    registerForCleanup(tipWt);
    fs.writeFileSync(path.join(tipWt, "p1-tip.txt"), "tip\n");
    git(tipWt, "add", "-A");
    const tipTree = git(tipWt, "write-tree");
    execFileSync("git", ["worktree", "remove", "--force", tipWt], { cwd: repo });
    // `commit-tree` applies no cleanup, so the literal `#`-prefixed subject lands verbatim regardless of
    // the repo's own `commit.cleanup=strip` — matching a worker whose own authoring path didn't go
    // through `git commit -m` at all, or whose own git config genuinely differs from the landing host's.
    const tipSha = execFileSync("git", ["commit-tree", tipTree, "-p", baseMainSha, "-m", "# worker subject"], { cwd: repo, encoding: "utf8", env: { ...process.env, ...IDENT } }).trim();
    git(repo, "update-ref", `refs/heads/${tipBranch}`, tipSha);
    check("(P1) precondition: the tip commit's own subject really is the comment-shaped line", git(repo, "log", "-1", "--format=%s", tipSha) === "# worker subject");

    const { worktreePath: batchWt } = await createWorktree(repo, P.projId, `bmetcd-p1-batch-${sfx}`);
    registerForCleanup(batchWt);

    const passGate = async () => ({ passed: true });
    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [
      { workerSessionId: "bmetcd-p1-good-w1", taskId: "bmetcd-p1-good-t1", branch: goodBranch, cutBaseSha: null },
      { workerSessionId: "bmetcd-p1-tip-w1", taskId: "bmetcd-p1-tip-t1", branch: tipBranch, cutBaseSha: null },
    ], passGate);

    check("(P1) the batch succeeds — the pin overrides the ambient commit.cleanup=strip config", result.ok === true);
    check("(P1) the comment-subject candidate LANDED, never dropped", result.landed.some((l) => l.branch === tipBranch));
    const p1Entry = result.landed.find((l) => l.branch === tipBranch);
    const p1Body = p1Entry?.sha ? git(repo, "log", "-1", "--format=%B", p1Entry.sha) : "";
    const p1Trailer = parseLoomTrailerBlock(p1Body);
    check("(P1) the landed trailer is READABLE and names the right branch, despite the ambient strip config", p1Trailer !== null && p1Trailer.branch === tipBranch);
    check("(P1) the landed subject is the ORIGINAL comment-shaped line — whitespace mode keeps '#' lines, unlike the ambient strip config", p1Body.split(/\r?\n/)[0] === "# worker subject");
    check("(P1) canonical main advanced with both candidates' content", git(repo, "rev-parse", "HEAD") !== baseMainSha && fs.existsSync(path.join(repo, "p1-good.txt")) && fs.existsSync(path.join(repo, "p1-tip.txt")));
  }
} finally {
  // no shared canonical repo to restore — every scenario above creates its OWN throwaway `repo`,
  // registered for cleanup individually.
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a tip commit whose message is empty or reduces to nothing but blank lines drops ONLY that candidate (never headMoved) before anything is committed, via both an ordinary --allow-empty-message authoring path and a commit-tree-authored blank-first-line path; the rest of the batch lands normally; the dropped candidate's own later solo retry lands with a fully readable trailer; a genuinely non-blank tip (a lone form-feed, after a stale quoted trailer is stripped) is never over-dropped; and the --cleanup=whitespace pin overrides an ambient commit.cleanup=strip repo config so a #-subject tip still lands readable (card 458028ae)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
