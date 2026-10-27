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
// CARD 75199847 — the two follow-up shapes from 458028ae's own Code Review (session e8f1f410); see
// docs/decisions/75199847-batch-commit-message-via-temp-file-and-named-empty-drop.md.
// (F1) a NON-TIP commit (one of two on the same branch) whose message is empty: `expectedPlainTrailers`
//      is `{}` for a non-tip, so the pre-fix predictor check passed vacuously and real git refused outright
//      ("Aborting commit due to empty commit message") — proves the new explicit emptiness check drops the
//      whole branch with a reason naming the real cause, before anything is committed.
// (F2) a commit message well over the Windows ~32K `CreateProcess` argv ceiling lands successfully
//      end-to-end (the `-F <tempfile>` switch has no such limit) with byte-identical content.
// (F3) a commit-message temp-file WRITE failure (simulated via TEMP/TMP/TMPDIR pointed at a non-existent
//      directory — the real seam `os.tmpdir()` reads live, no new DI surface) drops ONLY the affected
//      candidate with a reason naming the failure, never falling back to `-m` or failing the whole batch.
// (F4) Code Review round 2, S1 — a WRITE failure AFTER `mkdtemp` already succeeded must not leak the
//      now-orphaned temp dir; proven via a monkey-patched `fs.promises.mkdtemp`/`writeFile` (the real
//      shared `node:fs` singleton, no production DI change) that captures the created dir and fails the
//      write exactly once.
// (F5) Code Review round 2, S2 — a RELATIVE `TEMP`/`TMP`/`TMPDIR` must still land an intact message:
//      `path.resolve(os.tmpdir())` resolves the relative value against THIS process's own cwd, so
//      `process.chdir()` into a dedicated anchor dir, then point the env vars at a SHORT relative subdir
//      name under it — the exact shape the reviewer reproduced `fatal: could not read log file` against
//      pre-fix.
//
// Run: 1) build daemon (pnpm build), 2) node test/batch-merge-empty-tip-cleanup-drop.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";
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

  // ── (F1) card 75199847 — a NON-TIP commit whose message is empty (`--allow-empty-message`), followed
  //     by a normal tip commit on the SAME branch: `expectedPlainTrailers` is `{}` for a non-tip, so the
  //     pre-fix predictor check passed vacuously and real git then refused outright. Proves the explicit
  //     emptiness check drops the WHOLE branch (ALL-OR-NOTHING), never headMoved, before anything commits.
  {
    const repo = path.join(os.tmpdir(), `loom-bmetcd-f1-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# bmetcd-f1\n");
    git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "bmetcd@loom"); git(repo, "config", "user.name", "bmetcd");
    commitAll(repo, "init", GIT_ID);
    const baseMainSha = git(repo, "rev-parse", "HEAD");

    const { worktreePath: goodWt, branch: goodBranch } = await createWorktree(repo, P.projId, `bmetcd-f1-good-${sfx}`);
    registerForCleanup(goodWt);
    fs.writeFileSync(path.join(goodWt, "f1-good.txt"), "good\n");
    commitAll(goodWt, "feat(x): change f1 good", GIT_ID);

    const { worktreePath: evilWt, branch: evilBranch } = await createWorktree(repo, P.projId, `bmetcd-f1-evil-${sfx}`);
    registerForCleanup(evilWt);
    // Commit 1 (NON-TIP): real staged content, EMPTY message.
    fs.writeFileSync(path.join(evilWt, "f1-evil-1.txt"), "evil1\n");
    git(evilWt, "add", "-A");
    git(evilWt, "commit", "-q", "--allow-empty-message", "-m", "");
    check("(F1) precondition: commit 1's own message really is empty", git(evilWt, "log", "-1", "--format=%B", "HEAD") === "");
    // Commit 2 (TIP): ordinary message, real staged content — this branch now carries TWO commits.
    fs.writeFileSync(path.join(evilWt, "f1-evil-2.txt"), "evil2\n");
    commitAll(evilWt, "feat(x): f1 evil tip", GIT_ID);

    const { worktreePath: batchWt } = await createWorktree(repo, P.projId, `bmetcd-f1-batch-${sfx}`);
    registerForCleanup(batchWt);

    const passGate = async () => ({ passed: true });
    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [
      { workerSessionId: "bmetcd-f1-good-w1", taskId: "bmetcd-f1-good-t1", branch: goodBranch, cutBaseSha: null },
      { workerSessionId: "bmetcd-f1-evil-w1", taskId: "bmetcd-f1-evil-t1", branch: evilBranch, cutBaseSha: null },
    ], passGate);

    check("(F1) the batch still SUCCEEDS overall", result.ok === true);
    check("(F1) the good candidate LANDED", result.landed.some((l) => l.branch === goodBranch));
    check("(F1) the two-commit branch with an empty NON-TIP message was DROPPED WHOLESALE, never typed headMoved",
      !result.landed.some((l) => l.branch === evilBranch) && result.dropped.some((d) => d.branch === evilBranch) && result.batchHeadMoved !== true);
    // NOT just /empty/i — git's OWN generic refusal text ("Aborting commit due to empty commit message")
    // also contains that word, so a bare /empty/i match passes vacuously even against the OLD generic
    // commit-failed fallback (measured: this exact regex gave a false PASS pre-fix). Require the phrase
    // unique to the NEW, named pre-commit drop instead.
    check("(F1) the drop reason names the EMPTY-message cause specifically, via the new named pre-commit drop — not git's own generic refusal text surfacing through the old commit-failed fallback",
      /would be empty after git.?s own commit cleanup/i.test(result.dropped.find((d) => d.branch === evilBranch)?.reason ?? ""));
    check("(F1) canonical main advanced with ONLY the good candidate's content",
      git(repo, "rev-parse", "HEAD") !== baseMainSha && fs.existsSync(path.join(repo, "f1-good.txt")) && !fs.existsSync(path.join(repo, "f1-evil-1.txt")) && !fs.existsSync(path.join(repo, "f1-evil-2.txt")));
  }

  // ── (F2) card 75199847 — a commit message well over the Windows ~32K `CreateProcess` argv ceiling lands
  //     successfully end-to-end through the real batch landing path (the `-F <tempfile>` switch removes the
  //     limit entirely; pre-fix this would ENAMETOOLONG and generically drop the candidate).
  {
    const repo = path.join(os.tmpdir(), `loom-bmetcd-f2-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# bmetcd-f2\n");
    git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "bmetcd@loom"); git(repo, "config", "user.name", "bmetcd");
    commitAll(repo, "init", GIT_ID);
    const baseMainSha = git(repo, "rev-parse", "HEAD");

    const { worktreePath: bigWt, branch: bigBranch } = await createWorktree(repo, P.projId, `bmetcd-f2-big-${sfx}`);
    registerForCleanup(bigWt);
    fs.writeFileSync(path.join(bigWt, "f2-big.txt"), "big\n");
    git(bigWt, "add", "-A");
    const bigBody = "fix(x): a commit with a huge body\n\n" + "y".repeat(40_000) + "\n";
    const bigMsgDir = fs.mkdtempSync(path.join(os.tmpdir(), "bmetcd-f2-msg-"));
    registerForCleanup(bigMsgDir);
    const bigMsgFile = path.join(bigMsgDir, "message");
    fs.writeFileSync(bigMsgFile, bigBody, "utf8");
    // Authored via `-F` here too (fixture setup, not the code under test): an ordinary `-m` of this size
    // would hit the SAME Windows argv ceiling just constructing the worker's own original commit.
    git(bigWt, "commit", "-q", "--cleanup=whitespace", "-F", bigMsgFile);
    check("(F2) precondition: the worker's own commit message really is this large",
      Buffer.byteLength(gitRaw(bigWt, "log", "-1", "--format=%B", "HEAD"), "utf8") > 32_768);

    const { worktreePath: batchWt } = await createWorktree(repo, P.projId, `bmetcd-f2-batch-${sfx}`);
    registerForCleanup(batchWt);

    const passGate = async () => ({ passed: true });
    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [
      { workerSessionId: "bmetcd-f2-big-w1", taskId: "bmetcd-f2-big-t1", branch: bigBranch, cutBaseSha: null },
    ], passGate);

    check("(F2) the batch SUCCEEDS — a >32K commit message no longer hits the Windows argv ceiling", result.ok === true);
    check("(F2) the huge-message candidate LANDED", result.landed.some((l) => l.branch === bigBranch));
    const f2Entry = result.landed.find((l) => l.branch === bigBranch);
    // Read via cat-file, never `git log --format=%B`: that pretty-print format appends its OWN extra
    // trailing newline for DISPLAY, which is not part of the stored object — `%B` would read ONE byte
    // longer than what git actually stored (measured directly, card 75199847's own investigation).
    const f2RawCommit = f2Entry?.sha ? execFileSync("git", ["cat-file", "-p", f2Entry.sha], { cwd: repo }) : Buffer.alloc(0);
    const f2HeaderEnd = f2RawCommit.indexOf("\n\n");
    const f2LandedMessage = f2RawCommit.subarray(f2HeaderEnd + 2);
    const bigBodyTrimmed = bigBody.replace(/\s+$/, "");
    // A PREFIX check, not full equality: this branch's single commit also becomes the batch tip, so it
    // additionally carries the Loom-Worker-Base/PathSet amend trailers (card d62dad73) after its own
    // Loom-Worker-Branch line — exactly as every other single-commit scenario in this file lands. Checking
    // the huge body landed byte-identical, un-truncated, as the message's own PREFIX is what this scenario
    // is actually about; the trailer BLOCK itself is checked structurally below via the real reader.
    const f2ExpectedPrefix = Buffer.from(`${bigBodyTrimmed}\n\n`, "utf8");
    check("(F2) the landed message's huge body is BYTE-IDENTICAL to the worker's own body, un-truncated, as the message's own prefix",
      f2LandedMessage.length >= f2ExpectedPrefix.length && Buffer.compare(f2LandedMessage.subarray(0, f2ExpectedPrefix.length), f2ExpectedPrefix) === 0);
    const f2Trailer = f2Entry?.sha ? parseLoomTrailerBlock(git(repo, "log", "-1", "--format=%B", f2Entry.sha)) : null;
    check("(F2) the trailer is readable and names the right branch", f2Trailer !== null && f2Trailer.branch === bigBranch);
    check("(F2) canonical main advanced with the huge candidate's content", git(repo, "rev-parse", "HEAD") !== baseMainSha && fs.existsSync(path.join(repo, "f2-big.txt")));
  }

  // ── (F3) card 75199847 — a commit-message temp-file WRITE failure (simulated via TEMP/TMP/TMPDIR pointed
  //     at a non-existent directory — the real seam `os.tmpdir()` reads live, no new DI surface added)
  //     drops the affected candidate with a reason naming the failure, rather than silently falling back
  //     to `-m` or crashing. NOTE: the broken env is process-global, so it would break EVERY candidate's
  //     write in the SAME batch call — this runs the affected branch ALONE (never paired with a "good"
  //     sibling in the SAME call, which the broken env would break identically), then separately re-lands
  //     the SAME branch under the RESTORED env to prove both the drop and the restoration are real.
  {
    const repo = path.join(os.tmpdir(), `loom-bmetcd-f3-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# bmetcd-f3\n");
    git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "bmetcd@loom"); git(repo, "config", "user.name", "bmetcd");
    commitAll(repo, "init", GIT_ID);
    const baseMainSha = git(repo, "rev-parse", "HEAD");

    const { worktreePath: wt, branch } = await createWorktree(repo, P.projId, `bmetcd-f3-${sfx}`);
    registerForCleanup(wt);
    fs.writeFileSync(path.join(wt, "f3.txt"), "f3\n");
    commitAll(wt, "feat(x): change f3 — would land fine but for the induced temp-dir failure", GIT_ID);

    const { worktreePath: batchWt1 } = await createWorktree(repo, P.projId, `bmetcd-f3-batch1-${sfx}`);
    registerForCleanup(batchWt1);

    // Derived from the REAL os.tmpdir() so the broken path stays valid-looking on either platform this
    // suite runs on (Windows dev host, Ubuntu CI) — only its own nested segment doesn't exist.
    const brokenTmp = path.join(os.tmpdir(), `bmetcd-f3-nonexistent-${sfx}`, "deeper", "still-deeper");
    const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
    let brokenResult;
    try {
      process.env.TEMP = brokenTmp;
      process.env.TMP = brokenTmp;
      process.env.TMPDIR = brokenTmp;
      const passGate = async () => ({ passed: true });
      brokenResult = await runBatchedMerge(repo, batchWt1, baseMainSha, [
        { workerSessionId: "bmetcd-f3-w1", taskId: "bmetcd-f3-t1", branch, cutBaseSha: null },
      ], passGate);
    } finally {
      for (const k of ["TEMP", "TMP", "TMPDIR"]) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
    }

    check("(F3) under the broken temp dir, the ONLY candidate is DROPPED, never typed headMoved, never crashing the call",
      !brokenResult.landed.some((l) => l.branch === branch) && brokenResult.dropped.some((d) => d.branch === branch) && brokenResult.batchHeadMoved !== true);
    check("(F3) the drop reason names the temp-file write failure specifically",
      /temp file/i.test(brokenResult.dropped.find((d) => d.branch === branch)?.reason ?? ""));
    check("(F3) canonical main did NOT advance — nothing landed", git(repo, "rev-parse", "HEAD") === baseMainSha && !fs.existsSync(path.join(repo, "f3.txt")));

    // Re-land the SAME branch under the now-RESTORED env — proves the earlier drop was really caused by
    // the induced failure (not something permanently wrong with the branch/worktree), and that restoring
    // TEMP/TMP/TMPDIR in the `finally` above genuinely took effect for later code in this same process.
    const { worktreePath: batchWt2 } = await createWorktree(repo, P.projId, `bmetcd-f3-batch2-${sfx}`);
    registerForCleanup(batchWt2);
    const passGate2 = async () => ({ passed: true });
    const restoredResult = await runBatchedMerge(repo, batchWt2, baseMainSha, [
      { workerSessionId: "bmetcd-f3-w2", taskId: "bmetcd-f3-t2", branch, cutBaseSha: null },
    ], passGate2);
    check("(F3) the SAME branch lands fine once TEMP/TMP/TMPDIR are restored", restoredResult.ok === true && restoredResult.landed.some((l) => l.branch === branch));
    check("(F3) canonical main now advances with its content", git(repo, "rev-parse", "HEAD") !== baseMainSha && fs.existsSync(path.join(repo, "f3.txt")));
  }

  // ── (F4) card 75199847 Code Review round 2, S1 — a WRITE failure AFTER mkdtemp already succeeded must
  //     not leak the now-orphaned temp dir. Monkey-patches the real `fs.promises.mkdtemp`/`writeFile` (the
  //     shared `node:fs` singleton — the compiled dist imports the SAME module object, no production DI
  //     change) to capture which dir gets created and fail exactly once, restored in a `finally`
  //     immediately after the call, before anything else in this file can observe the patch.
  {
    const repo = path.join(os.tmpdir(), `loom-bmetcd-f4-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# bmetcd-f4\n");
    git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "bmetcd@loom"); git(repo, "config", "user.name", "bmetcd");
    commitAll(repo, "init", GIT_ID);
    const baseMainSha = git(repo, "rev-parse", "HEAD");

    const { worktreePath: wt, branch } = await createWorktree(repo, P.projId, `bmetcd-f4-${sfx}`);
    registerForCleanup(wt);
    fs.writeFileSync(path.join(wt, "f4.txt"), "f4\n");
    commitAll(wt, "feat(x): change f4", GIT_ID);

    const { worktreePath: batchWt } = await createWorktree(repo, P.projId, `bmetcd-f4-batch-${sfx}`);
    registerForCleanup(batchWt);

    const capturedDirs = [];
    const realMkdtemp = fs.promises.mkdtemp;
    const realWriteFile = fs.promises.writeFile;
    let writeFailed = false;
    fs.promises.mkdtemp = async (...a) => {
      const dir = await realMkdtemp.apply(fs.promises, a);
      if (path.basename(dir).startsWith("loom-batch-commit-")) capturedDirs.push(dir);
      return dir;
    };
    fs.promises.writeFile = async (file, ...rest) => {
      if (!writeFailed && typeof file === "string" && path.basename(file) === "message" &&
          capturedDirs.some((d) => file.startsWith(d))) {
        writeFailed = true;
        throw new Error("simulated EACCES (test F4)");
      }
      return realWriteFile.apply(fs.promises, [file, ...rest]);
    };

    let result;
    try {
      const passGate = async () => ({ passed: true });
      result = await runBatchedMerge(repo, batchWt, baseMainSha, [
        { workerSessionId: "bmetcd-f4-w1", taskId: "bmetcd-f4-t1", branch, cutBaseSha: null },
      ], passGate);
    } finally {
      fs.promises.mkdtemp = realMkdtemp;
      fs.promises.writeFile = realWriteFile;
    }

    check("(F4) precondition: the simulated write failure actually fired", writeFailed === true);
    check("(F4) precondition: a temp dir was actually created before the write failed", capturedDirs.length >= 1);
    const f4Dropped = result.dropped.find((d) => d.branch === branch);
    check("(F4) the candidate was DROPPED with a reason naming the temp-file write failure",
      !result.landed.some((l) => l.branch === branch) && f4Dropped !== undefined && /temp file/i.test(f4Dropped.reason ?? ""));
    // Cleanup is fire-and-forget (never awaited by production code) — poll via the shared waitUntil
    // helper (never a hand-rolled fixed-wait-then-check loop) until it's provably gone.
    const failedDir = capturedDirs[capturedDirs.length - 1];
    let dirGone = false;
    try {
      await waitUntil(() => !fs.existsSync(failedDir), { timeoutMs: 5000, label: `(F4) temp dir ${failedDir} removed` });
      dirGone = true;
    } catch { /* dirGone stays false — reported below */ }
    check("(F4) the orphaned temp dir from the FAILED write is cleaned up, never leaked", dirGone === true);
  }

  // ── (F5) card 75199847 Code Review round 2, S2 — a RELATIVE TEMP/TMP/TMPDIR must still land an intact
  //     message. `os.tmpdir()` returns the env var VERBATIM; `path.resolve` resolves a relative value
  //     against THIS process's own cwd — so `process.chdir()` into a dedicated anchor dir first, then
  //     point TEMP/TMP/TMPDIR at a SHORT relative subdir name under it, matching the exact shape the
  //     reviewer reproduced `fatal: could not read log file` against pre-fix. cwd and env are restored in
  //     a `finally` immediately after the call. A monkey-patched `fs.promises.mkdtemp` (same technique as
  //     F4, real shared `node:fs` singleton, no production DI change) captures the actual dir created, so
  //     the test can assert it genuinely resolved under the anchor — not just that the batch happened to
  //     succeed some other way.
  {
    const repo = path.join(os.tmpdir(), `loom-bmetcd-f5-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# bmetcd-f5\n");
    git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "bmetcd@loom"); git(repo, "config", "user.name", "bmetcd");
    commitAll(repo, "init", GIT_ID);
    const baseMainSha = git(repo, "rev-parse", "HEAD");

    const { worktreePath: wt, branch } = await createWorktree(repo, P.projId, `bmetcd-f5-${sfx}`);
    registerForCleanup(wt);
    fs.writeFileSync(path.join(wt, "f5.txt"), "f5\n");
    const f5Message = "feat(x): change f5 via a relative temp dir";
    commitAll(wt, f5Message, GIT_ID);

    const { worktreePath: batchWt } = await createWorktree(repo, P.projId, `bmetcd-f5-batch-${sfx}`);
    registerForCleanup(batchWt);

    // The anchor dir + its short relative subdir — created BEFORE perturbing cwd/env, so the repo/worktree
    // setup above is entirely unaffected by either.
    const anchorDir = path.join(os.tmpdir(), `loom-bmetcd-f5-anchor-${sfx}`);
    fs.mkdirSync(anchorDir, { recursive: true }); registerForCleanup(anchorDir);
    const relName = "tmp";
    fs.mkdirSync(path.join(anchorDir, relName));

    const capturedDirs = [];
    const realMkdtemp = fs.promises.mkdtemp;
    fs.promises.mkdtemp = async (...a) => {
      const dir = await realMkdtemp.apply(fs.promises, a);
      if (path.basename(dir).startsWith("loom-batch-commit-")) capturedDirs.push(dir);
      return dir;
    };

    const originalCwd = process.cwd();
    const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
    let result;
    try {
      process.chdir(anchorDir);
      process.env.TEMP = relName;
      process.env.TMP = relName;
      process.env.TMPDIR = relName;
      const passGate = async () => ({ passed: true });
      result = await runBatchedMerge(repo, batchWt, baseMainSha, [
        { workerSessionId: "bmetcd-f5-w1", taskId: "bmetcd-f5-t1", branch, cutBaseSha: null },
      ], passGate);
    } finally {
      process.chdir(originalCwd);
      for (const k of ["TEMP", "TMP", "TMPDIR"]) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
      fs.promises.mkdtemp = realMkdtemp;
    }

    check("(F5) precondition: a temp dir was actually created (mkdtemp resolved to SOMEWHERE)", capturedDirs.length >= 1);
    const anchorTmpAbs = path.join(anchorDir, relName);
    check("(F5) the temp dir genuinely resolved under the anchor's relative subdir — proving the relative TEMP/TMP/TMPDIR was actually exercised, not silently bypassed",
      capturedDirs.every((d) => path.isAbsolute(d) && (d === anchorTmpAbs || d.startsWith(anchorTmpAbs + path.sep))));
    check("(F5) the batch SUCCEEDS under a relative TEMP/TMP/TMPDIR", result.ok === true);
    check("(F5) the candidate LANDED", result.landed.some((l) => l.branch === branch));
    const f5Entry = result.landed.find((l) => l.branch === branch);
    const f5Body = f5Entry?.sha ? git(repo, "log", "-1", "--format=%B", f5Entry.sha) : "";
    check("(F5) the landed message's subject is the worker's ORIGINAL, intact message — never truncated or corrupted by the relative resolution",
      f5Body.split(/\r?\n/)[0] === f5Message);
    const f5Trailer = f5Entry?.sha ? parseLoomTrailerBlock(f5Body) : null;
    check("(F5) the trailer is readable and names the right branch", f5Trailer !== null && f5Trailer.branch === branch);
    check("(F5) canonical main advanced with the candidate's content", git(repo, "rev-parse", "HEAD") !== baseMainSha && fs.existsSync(path.join(repo, "f5.txt")));
  }
} finally {
  // no shared canonical repo to restore — every scenario above creates its OWN throwaway `repo`,
  // registered for cleanup individually.
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a tip commit whose message is empty or reduces to nothing but blank lines drops ONLY that candidate (never headMoved) before anything is committed, via both an ordinary --allow-empty-message authoring path and a commit-tree-authored blank-first-line path; the rest of the batch lands normally; the dropped candidate's own later solo retry lands with a fully readable trailer; a genuinely non-blank tip (a lone form-feed, after a stale quoted trailer is stripped) is never over-dropped; the --cleanup=whitespace pin overrides an ambient commit.cleanup=strip repo config so a #-subject tip still lands readable (card 458028ae); a NON-TIP commit's empty message is now caught and named explicitly rather than falling through to a generic git refusal; a >32K commit message lands byte-identical via -F with no argv ceiling; a commit-message temp-file write failure drops only the affected candidate with a named reason; a write failure after mkdtemp already succeeded never leaks the orphaned temp dir; and a RELATIVE TEMP/TMP/TMPDIR still lands an intact message (card 75199847)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
