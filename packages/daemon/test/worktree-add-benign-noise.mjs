import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card af436c99 — batch gate 1af9138e observed merge-deny-glob.mjs's own (A)-(C) assertions all PASS,
// then the whole process died on an uncaught GitError:
//   GitError: HEAD is now at 366e155 init
//   Preparing worktree (new branch 'loom/a994adf44ada')
// That text is git's OWN benign, informational `worktree add` progress output (verified against real git:
// "HEAD is now at <sha> <subject>" on stdout, "Preparing worktree (...)" on stderr — both printed on every
// SUCCESSFUL add). simple-git's default error detection flags a task as failed whenever the reported
// exitCode is truthy AND stderr carries ANY content, with no regard for what that content says — so an add
// that finishes genuinely fine, but whose completion-detection plugin reads a stale/misreported non-zero
// exitCode (a known simple-git race under host contention), still throws a GitError carrying only that
// benign text. This is NOT the deny-glob feature failing and NOT a timeout (nothing here times out) — it's
// createWorktree's own `worktree add` catch treating success output as a real failure.
//
// THE FIX (git/worktrees.ts, createWorktree's `worktree add` catch): recognize the NARROW case where the
// thrown error's message consists ENTIRELY of git's own known benign worktree-add progress lines, confirm
// the worktree actually landed on the right branch, and treat that combination as success instead of
// rethrowing.
//
// Proves:
//   (A) a `worktree add` that performs a REAL, complete add — genuinely creating the worktree on disk —
//       but is wrapped by a gitFactory that then throws a GitError whose message is EXACTLY that benign
//       progress text: createWorktree does NOT reject; it returns the worktree info as if the add had
//       reported success cleanly.
//   (B) NEGATIVE CONTROL — the identical real add, but the injected error's message carries ONE extra
//       non-benign line (a `fatal:` line) alongside the same benign text: createWorktree still REJECTS.
//       Proves the allowlist is exact-match, not "contains benign text" — a genuine failure whose message
//       happens to also carry benign progress lines must never be swallowed.
//   (C) NEGATIVE CONTROL — the add never actually creates the worktree at all (no real add performed) and
//       the thrown message is benign-shaped text with no real worktree behind it: createWorktree still
//       REJECTS, because the post-benign-match landing check (fs existence + branch verification) fails.
//       Proves the fix does not trust the message alone.
//   (D) sibling tests (worktree-locked-residue-cleanup.mjs (b)/(c)/(e)) already prove a REAL killed/timed-
//       out child ("... (git child killed)" / "... giving up (hung git child?)") and a genuine
//       "already used by worktree" failure are UNCHANGED by this fix (their messages never match the
//       benign allowlist) — not re-proven here to avoid duplicating that file's own coverage.
//
// Run: 1) build daemon (pnpm build), 2) node test/worktree-add-benign-noise.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-wtbn-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { createWorktree } = await import("../dist/git/worktrees.js");
const { simpleGit: realSimpleGit } = await import("simple-git");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const repo = path.join(os.tmpdir(), `loom-wtbn-repo-${Date.now()}-${process.pid}`);
const extraDirs = [];

// The EXACT shape observed in the batch gate specimen — stdout first, then stderr (matches simple-git's
// own getErrorMessage: Buffer.concat([...stdOut, ...stdErr])).
const benignMessage = (branch) =>
  `HEAD is now at 366e155 init\nPreparing worktree (new branch '${branch}')`;

try {
  fs.mkdirSync(repo, { recursive: true });
  execSync(`git init -q && git config user.email wtbn@loom && git config user.name wtbn && git commit -q --allow-empty -m init`, { cwd: repo });

  // ── (A) real add succeeds on disk, but the wrapper throws pure benign-progress text ──────────────────
  {
    let capturedWtPath, capturedBranch;
    const benignNoiseFactory = (repoPathArg) => {
      const real = realSimpleGit(repoPathArg);
      return {
        raw: async (args) => {
          if (args[0] === "worktree" && args[1] === "add") {
            capturedWtPath = args[2];
            capturedBranch = args.includes("-b") ? args[args.indexOf("-b") + 1] : args[3];
            await real.raw(args); // the REAL add — genuinely lands on disk
            throw new Error(benignMessage(capturedBranch));
          }
          return real.raw(args);
        },
      };
    };
    let result, thrown = null;
    try {
      result = await createWorktree(repo, "projBenignA", "task-benign-a", {}, undefined, undefined, { gitFactory: benignNoiseFactory, timeoutMs: 5000 });
    } catch (e) { thrown = e; }
    if (result?.worktreePath) extraDirs.push(result.worktreePath);
    check("(A) createWorktree does NOT reject on pure benign worktree-add progress text",
      thrown === null && !!result?.worktreePath);
    check("(A) returned worktreePath matches the real add's path",
      result?.worktreePath === capturedWtPath);
    check("(A) returned branch matches the real add's branch", result?.branch === capturedBranch);
    check("(A) the worktree genuinely exists on disk", !!capturedWtPath && fs.existsSync(capturedWtPath));
    let landedBranch = null;
    try {
      if (capturedWtPath && fs.existsSync(capturedWtPath)) {
        landedBranch = execSync(`git -C "${capturedWtPath}" rev-parse --abbrev-ref HEAD`, { encoding: "utf8" }).trim();
      }
    } catch { /* pre-fix: createWorktree's own cleanup may have already removed it — landedBranch stays null, check fails below */ }
    check("(A) it is checked out on the right branch", landedBranch === capturedBranch);
  }

  // ── (B) NEGATIVE CONTROL: benign text PLUS a real fatal line — must still reject ─────────────────────
  {
    let capturedWtPath;
    const mixedFactory = (repoPathArg) => {
      const real = realSimpleGit(repoPathArg);
      return {
        raw: async (args) => {
          if (args[0] === "worktree" && args[1] === "add") {
            capturedWtPath = args[2];
            await real.raw(args); // still a real add underneath — proves the message, not the disk state, is what's checked
            throw new Error(`${benignMessage("loom-benign-b")}\nfatal: something genuinely went wrong`);
          }
          return real.raw(args);
        },
      };
    };
    let rejected = false, rejectMessage = null;
    await createWorktree(repo, "projBenignB", "task-benign-b", {}, undefined, undefined, { gitFactory: mixedFactory, timeoutMs: 5000 })
      .catch((e) => { rejected = true; rejectMessage = e?.message ?? String(e); });
    check("(B) [negative control] a fatal line alongside benign text is NOT swallowed — createWorktree rejects",
      rejected === true && /fatal: something genuinely went wrong/.test(rejectMessage ?? ""));
    if (capturedWtPath) extraDirs.push(capturedWtPath);
  }

  // ── (C) NEGATIVE CONTROL: benign-shaped message but NO real add ever ran — must still reject ─────────
  {
    const neverAddedFactory = (repoPathArg) => {
      const real = realSimpleGit(repoPathArg);
      return {
        raw: async (args) => {
          if (args[0] === "worktree" && args[1] === "add") {
            throw new Error(benignMessage("loom-benign-c")); // no real().raw(args) call — nothing lands on disk
          }
          return real.raw(args);
        },
      };
    };
    let rejected = false, rejectMessage = null;
    await createWorktree(repo, "projBenignC", "task-benign-c", {}, undefined, undefined, { gitFactory: neverAddedFactory, timeoutMs: 5000 })
      .catch((e) => { rejected = true; rejectMessage = e?.message ?? String(e); });
    check("(C) [negative control] benign-shaped text with no real worktree behind it is NOT trusted on message alone",
      rejected === true);
  }
} finally {
  for (const d of extraDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — createWorktree's `worktree add` catch tolerates git's own benign informational progress " +
    "text (the exact GitError shape a contended batch gate observed) once the resulting worktree is " +
    "independently confirmed to have actually landed, while a genuine failure — a real fatal line, or a " +
    "benign-shaped message with no worktree behind it — still rejects."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
