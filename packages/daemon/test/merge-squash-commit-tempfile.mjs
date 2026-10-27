import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 8336b903 — reuse writeCommitMessageFile/cleanupCommitMessageFile (git/writer.ts) for the
// solo squash's message too; never re-derive a second -F-via-tempfile helper, and never a fallback to
// -m on write failure.
//
// The solo squash commit in mergeBranchLocked (git/worktrees.ts) now passes its message via `-F
// <tempfile>`, never unbounded `-m` argv — removing the same Windows CreateProcess ~32766-char ceiling
// that 75199847 (batch landing) and 697be64a (GitWriter.commit) already removed from their own callers.
// Unlike those two, the squash's SUBJECT is the board card's title verbatim, which carries no length
// bound anywhere — this is the card that closes that remaining gap.
//
// Real git, no claude/daemon. Run: 1) build daemon (pnpm build), 2) node test/merge-squash-commit-tempfile.mjs
//
// Proves:
//   (1) a pathologically long title (well over BOTH the Windows CreateProcess argv ceiling and Linux's own
//       per-argument MAX_ARG_STRLEN) lands via mergeBranch without ENAMETOOLONG on either OS, and the
//       landed commit's subject is the title VERBATIM (via git cat-file -p).
//   (2) the "message is always exactly one trailing LF, by construction" claim — relied on instead of a
//       GitWriter.commit()-style explicit `${msg.trim()}\n` fix — is PINNED empirically on the REAL
//       mergeBranch path, under BOTH reachable commit.cleanup modes (verbatim, strip).
//   (3) hermetic byte-identity for the SQUASH-SHAPED message (subject + worker-commit-log body bullets +
//       the four Loom-* trailers): -m vs the real writeCommitMessageFile()+-F, under verbatim and strip,
//       for a message ending in "\n" (the only shape the real squash path can ever produce) AND, as a
//       labeled "why the invariant matters" control, the SAME message with its trailing LF stripped
//       (documents that -m and -F would silently DIVERGE under verbatim without it — never reachable from
//       mergeBranch today, since (2) proves that path never produces this shape).
//   (4) a commit-message temp-file write failure is a NAMED refusal naming "temp file", never a silent
//       fallback to -m — and because `message` is only final AFTER `git merge --squash` has already
//       staged the canonical index, the refusal must roll back through the SAME `resetOrSkip` path every
//       other post-stage refusal in this function uses: canonical HEAD unchanged, working tree + index
//       left CLEAN, worker branch retained for recovery.
//   (5) verifyLandedAsOwnCommit (parent+tree+trailer check) and parseLoomTrailerBlock still pass cleanly
//       on a -F-landed squash commit — pathset/landedTip verification is unchanged by the argv-to-tempfile
//       switch.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

useOwnLoomHome("msct-home-"); // temp SHORT LOOM_HOME, set BEFORE the dist imports below
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const worktreesUrl = pathToFileURL(path.join(__dirname, "..", "dist", "git", "worktrees.js")).href;
const writerUrl = pathToFileURL(path.join(__dirname, "..", "dist", "git", "writer.js")).href;
const { mergeBranch, parseLoomTrailerBlock } = await import(worktreesUrl);
const { writeCommitMessageFile } = await import(writerUrl);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=msct@loom -c user.name=msct";

function newRepo(prefix) {
  const repo = mkdtempManaged(prefix);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "msct@loom"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "msct"], { cwd: repo });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "# msct\n");
  commitAll(repo, "init", GIT_ID);
  return repo;
}

function makeWorktreeBranch(repo, branchName, file) {
  const wt = mkdtempManaged(`loom-msct-wt-${branchName.replace(/\//g, "-")}-`);
  execFileSync("git", ["worktree", "add", "-q", "-b", branchName, wt, "HEAD"], { cwd: repo });
  fs.writeFileSync(path.join(wt, file), "worker change\n");
  commitAll(wt, `feat(test): ${file}`, GIT_ID);
  return wt;
}

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();

// `git log --format=%B` appends its OWN extra trailing newline for display (card 75199847's "Do not" —
// never use it for a byte-for-byte comparison). Read the raw object via `cat-file -p` instead and slice
// off the header (up to the first blank-line separator).
const bodyFromCatFile = (raw) => {
  const idx = raw.indexOf("\n\n");
  return idx === -1 ? "" : raw.slice(idx + 2);
};

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const worktreesToClean = [];

try {
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // (1) A pathologically long title lands via mergeBranch without ENAMETOOLONG; subject lands verbatim.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = newRepo(`loom-msct-long-${sfx}-`);
    const wt = makeWorktreeBranch(repo, `loom/msct-long-${sfx}`, "long.txt");
    worktreesToClean.push(wt);
    // Already Conventional-Commits-shaped so toConventionalSubject leaves it byte-identical — isolates
    // this scenario to the argv-ceiling question, not the type-coercion one.
    // Code Review (S1): 50,000 chars sits below Linux's own per-argument ENAMETOOLONG ceiling
    // (MAX_ARG_STRLEN, 131,072 bytes) — a pre-fix `-m` call would NOT fail on ubuntu CI at that size, so
    // this RED was Windows-only. 140,000 chars clears MAX_ARG_STRLEN too (comfortably under the OS-wide
    // ARG_MAX of ~2MB, so the process can still be spawned at all), making the pre-fix path RED on both.
    const longTitle = `fix(test): ${"x".repeat(140_000)}`;
    check("(1) precondition: title exceeds the Windows ~32766-char CreateProcess ceiling AND Linux's ~131,072-byte MAX_ARG_STRLEN", longTitle.length > 131_072);

    const result = await mergeBranch(repo, `loom/msct-long-${sfx}`, longTitle);
    check("(1) mergeBranch succeeds for a 140,000-char title (no ENAMETOOLONG on Windows OR Linux)", result.ok === true);
    const raw = git(repo, "cat-file", "-p", "HEAD");
    const body = bodyFromCatFile(raw);
    const landedSubject = body.split("\n")[0];
    check("(1) the landed commit's subject is the title VERBATIM", landedSubject === longTitle);
    check("(1) result.subject matches too", result.subject === longTitle);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // (2) "message always ends in exactly one trailing LF, by construction" — pinned on the REAL mergeBranch
  //     path, under BOTH reachable commit.cleanup modes.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  for (const cleanupMode of ["verbatim", "strip"]) {
    const repo = newRepo(`loom-msct-lf-${cleanupMode}-${sfx}-`);
    execFileSync("git", ["config", "commit.cleanup", cleanupMode], { cwd: repo });
    const branch = `loom/msct-lf-${cleanupMode}-${sfx}`;
    const wt = makeWorktreeBranch(repo, branch, "lf.txt");
    worktreesToClean.push(wt);

    const result = await mergeBranch(repo, branch, "fix(test): short title");
    check(`(2 ${cleanupMode}) mergeBranch succeeds`, result.ok === true);
    const raw = git(repo, "cat-file", "-p", "HEAD");
    const body = bodyFromCatFile(raw);
    check(`(2 ${cleanupMode}) landed body ends with EXACTLY one trailing LF`, body.endsWith("\n") && !body.endsWith("\n\n"));
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // (3) Hermetic byte-identity for the SQUASH-SHAPED message: -m vs the real writeCommitMessageFile()+-F.
  //     Isolated from ambient host config exactly like test/git-writer.mjs's own 12b matrix.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const savedHermeticEnv = {
      HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
      GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    };
    const isoHome = fs.realpathSync(mkdtempManaged(`loom-msct-isohome-${sfx}-`));
    process.env.HOME = isoHome;
    process.env.USERPROFILE = isoHome;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    process.env.GIT_CONFIG_GLOBAL = path.join(isoHome, "nonexistent-gitconfig");
    try {
      // The exact shape mergeBranchLocked assembles: subject + worker-commit-log bullets + the four
      // Loom-* trailers, ending in exactly one trailing LF — the only shape the real squash path produces.
      const squashShapedMsg = "fix(test): squash-shaped message\n\n" +
        "Worker commits:\n- worker commit one\n- worker commit two\n\n" +
        "Loom-Worker-Branch: loom/deadbeef\nLoom-Landed-Tip: aaaa1112223334445556667778889990aaabbbcc\n" +
        "Loom-Worker-Base: bbbb2223334445556667778889990aaabbbcccddd\n" +
        "Loom-Worker-PathSet: deadbeefcafebabef00dfeed1234567890abcdef\n";
      check("(3) precondition: the squash-shaped fixture message ends in exactly one LF", squashShapedMsg.endsWith("\n") && !squashShapedMsg.endsWith("\n\n"));
      const noLfMsg = squashShapedMsg.replace(/\n$/, "");

      for (const cleanupMode of ["verbatim", "strip"]) {
        const matrixRepo = newRepo(`loom-msct-matrix-${cleanupMode}-${sfx}-`);
        execFileSync("git", ["config", "commit.cleanup", cleanupMode], { cwd: matrixRepo });

        // WITH trailing LF — the only shape mergeBranch can actually produce.
        fs.writeFileSync(path.join(matrixRepo, "f.txt"), `with-lf ${cleanupMode}\n`);
        execFileSync("git", ["add", "-A"], { cwd: matrixRepo });
        execFileSync("git", ["commit", "-m", squashShapedMsg], { cwd: matrixRepo });
        const mBodyWithLf = bodyFromCatFile(git(matrixRepo, "cat-file", "-p", "HEAD"));
        execFileSync("git", ["reset", "--hard", "HEAD~1"], { cwd: matrixRepo });

        fs.writeFileSync(path.join(matrixRepo, "f.txt"), `with-lf ${cleanupMode}\n`);
        execFileSync("git", ["add", "-A"], { cwd: matrixRepo });
        const { dir: withLfDir, file: withLfFile } = await writeCommitMessageFile(squashShapedMsg, "loom-squash-commit-");
        try {
          execFileSync("git", ["commit", "-F", withLfFile], { cwd: matrixRepo });
        } finally {
          fs.rmSync(withLfDir, { recursive: true, force: true });
        }
        const fBodyWithLf = bodyFromCatFile(git(matrixRepo, "cat-file", "-p", "HEAD"));
        execFileSync("git", ["reset", "--hard", "HEAD~1"], { cwd: matrixRepo });

        check(`(3 ${cleanupMode}/with-LF) -m and -F (via the real writeCommitMessageFile) land byte-identical bodies`, mBodyWithLf === fBodyWithLf);

        // WITHOUT trailing LF — never reachable from mergeBranch today (proven by (2) above), but a
        // deliberate control proving WHY the by-construction invariant is load-bearing: `-m`'s own argv
        // value is ALWAYS line-completed by git regardless of cleanup mode; a bare `-F <file>` is used
        // VERBATIM under commit.cleanup=verbatim specifically — the same divergence class 697be64a's own
        // record measured (13/143 cases) before GitWriter.commit() force-appended its own trailing "\n".
        fs.writeFileSync(path.join(matrixRepo, "f.txt"), `no-lf ${cleanupMode}\n`);
        execFileSync("git", ["add", "-A"], { cwd: matrixRepo });
        execFileSync("git", ["commit", "-m", noLfMsg], { cwd: matrixRepo });
        const mBodyNoLf = bodyFromCatFile(git(matrixRepo, "cat-file", "-p", "HEAD"));
        execFileSync("git", ["reset", "--hard", "HEAD~1"], { cwd: matrixRepo });

        fs.writeFileSync(path.join(matrixRepo, "f.txt"), `no-lf ${cleanupMode}\n`);
        execFileSync("git", ["add", "-A"], { cwd: matrixRepo });
        const { dir: noLfDir, file: noLfFile } = await writeCommitMessageFile(noLfMsg, "loom-squash-commit-");
        try {
          execFileSync("git", ["commit", "-F", noLfFile], { cwd: matrixRepo });
        } finally {
          fs.rmSync(noLfDir, { recursive: true, force: true });
        }
        const fBodyNoLf = bodyFromCatFile(git(matrixRepo, "cat-file", "-p", "HEAD"));
        execFileSync("git", ["reset", "--hard", "HEAD~1"], { cwd: matrixRepo });

        if (cleanupMode === "verbatim") {
          check("(3 verbatim/no-LF CONTROL) -m and -F DIVERGE without the trailing-LF invariant — documents why (2) must hold, never a claim about current behavior", mBodyNoLf !== fBodyNoLf && mBodyNoLf === `${noLfMsg}\n` && fBodyNoLf === noLfMsg);
        } else {
          check(`(3 ${cleanupMode}/no-LF) -m and -F still land byte-identical (cleanup normalizes the trailing newline either way)`, mBodyNoLf === fBodyNoLf);
        }
      }
    } finally {
      for (const [k, v] of Object.entries(savedHermeticEnv)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // (4) A commit-message temp-file write failure is a NAMED refusal, never a silent fallback to -m — and
  //     rolls back through resetOrSkip (canonical index/worktree clean, HEAD unchanged, branch retained).
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = newRepo(`loom-msct-wfail-${sfx}-`);
    const branch = `loom/msct-wfail-${sfx}`;
    const wt = makeWorktreeBranch(repo, branch, "wfail.txt");
    worktreesToClean.push(wt);
    const headBefore = git(repo, "rev-parse", "HEAD").trim();

    const realMkdtemp = fs.promises.mkdtemp;
    let mkdtempFailed = false;
    fs.promises.mkdtemp = async (...a) => {
      const prefixArg = a[0] ?? "";
      if (typeof prefixArg === "string" && prefixArg.includes("loom-squash-commit-")) {
        mkdtempFailed = true;
        throw new Error("simulated ENOSPC (test 4)");
      }
      return realMkdtemp.apply(fs.promises, a);
    };
    let result;
    try {
      result = await mergeBranch(repo, branch, "fix(test): write will fail");
    } finally {
      fs.promises.mkdtemp = realMkdtemp;
    }
    check("(4) precondition: the simulated mkdtemp failure actually fired", mkdtempFailed === true);
    check("(4) mergeBranch refuses (ok:false)", result.ok === false);
    check("(4) refusal names 'temp file', never a throw", typeof result.reason === "string" && /temp file/i.test(result.reason));
    check("(4) canonical HEAD unchanged (no squash committed)", git(repo, "rev-parse", "HEAD").trim() === headBefore);
    check("(4) canonical working tree left CLEAN (resetOrSkip's rollback ran, clearing the squash's own staged diff)", git(repo, "status", "--porcelain").trim() === "");
    check("(4) canonical index has nothing staged", git(repo, "diff", "--cached", "--name-only").trim() === "");
    check("(4) worker branch NOT deleted (retained for recovery)", git(repo, "branch", "--list", branch).trim() !== "");
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // (5) verifyLandedAsOwnCommit + parseLoomTrailerBlock still pass cleanly on a -F-landed squash commit —
  //     pathset/landedTip verification is unchanged by the argv-to-tempfile switch.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = newRepo(`loom-msct-verify-${sfx}-`);
    const branch = `loom/msct-verify-${sfx}`;
    const wt = makeWorktreeBranch(repo, branch, "verify.txt");
    worktreesToClean.push(wt);

    const result = await mergeBranch(repo, branch, "fix(test): verify trailers");
    check("(5) mergeBranch succeeds", result.ok === true);
    check("(5) landedVerify === 'verified' (verifyLandedAsOwnCommit's own parent+tree+trailer check passed)", result.landedVerify === "verified");
    check("(5) landedBase is defined (the pre-commit HEAD it verified against)", typeof result.landedBase === "string" && result.landedBase.length > 0);
    check("(5) no trailerAdvisory (the Loom trailer namespace read back exactly as stamped)", result.trailerAdvisory === undefined);

    // Independent external confirmation, not just trusting the function's own self-report: re-read the
    // landed commit's raw body and parse it ourselves.
    const body = bodyFromCatFile(git(repo, "cat-file", "-p", result.sha));
    const trailers = parseLoomTrailerBlock(body);
    check("(5) parseLoomTrailerBlock resolves a trailer block at all", trailers !== null);
    check("(5) Loom-Worker-Branch trailer matches the branch", trailers?.branch === branch);
    check("(5) Loom-Worker-Base trailer matches landedBase", trailers?.base === result.landedBase);
    check("(5) Loom-Worker-PathSet trailer is present", typeof trailers?.pathSet === "string" && trailers.pathSet.length > 0);
  }
} finally {
  for (const wt of worktreesToClean) {
    try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the solo squash commit message rides -F via the shared temp-file helper; a pathologically long title lands without ENAMETOOLONG, the always-single-trailing-LF invariant holds on the real path under both cleanup modes, -m/-F stay byte-identical for the real squash-shaped message, a write failure refuses by name and rolls back cleanly, and post-commit trailer/pathset verification is unaffected."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
