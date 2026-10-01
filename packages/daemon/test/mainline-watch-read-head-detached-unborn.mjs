import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card b801bad0 (fix round) — TEST GAP 5(c): a real-git integration test of `readMainlineHead`
// (git/mainline-watch.ts) on a DETACHED HEAD and an UNBORN repo (no commit yet). The pure parser
// (`parseHeadShaAndBranch`) already covers the detached SHAPE in mainline-watch-head-parse.mjs, and
// `batch-merge-watermark-branch-pin.mjs`'s own (P3) section exercises a detached repo end-to-end through
// the full `mergeBatchTracked` stack — but neither drives `readMainlineHead` itself, directly, against a
// REAL git process on an UNBORN repo (a worktree with no commits at all, e.g. right after `git init`,
// before `createWorktree` or any batch logic has ever run). `readMainlineHead` is `fastForwardCanonicalMain`'s
// own pin source via `readHeadShaAndBranch`, and `mergeBatchTracked`'s own watermark-fallback pin
// (card b801bad0, fix round) reads it directly too — so its real, spawn-level behavior on both edge states
// matters on its own, not just via the parser or the full service.
//
//   (D1) a real DETACHED HEAD (same repo, a prior commit checked out by sha): readMainlineHead returns null
//        (nothing nameable to pin) — never a guessed branch name.
//   (D2) control: the SAME repo, back on its real branch: readMainlineHead resolves branch+tip normally.
//   (U1) a genuinely UNBORN repo (`git init`, zero commits — `HEAD` doesn't resolve to any commit yet):
//        readMainlineHead returns null — a read failure, not a crash, not a guessed/empty branch.
//   (U2) control: the SAME repo, immediately after its first commit: readMainlineHead resolves normally.
//
// Run: 1) build daemon (pnpm build), 2) node test/mainline-watch-read-head-detached-unborn.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup } from "./_tmp-fixture.mjs";

const { readMainlineHead } = await import("../dist/git/mainline-watch.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const IDENT = { GIT_AUTHOR_NAME: "mwh", GIT_AUTHOR_EMAIL: "mwh@loom", GIT_COMMITTER_NAME: "mwh", GIT_COMMITTER_EMAIL: "mwh@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=mwh@loom -c user.name=mwh";
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// ── (D1)/(D2) a real DETACHED HEAD, then control back on the branch ──────────────────────────────────────
{
  const repo = path.join(os.tmpdir(), `loom-mwh-detached-${sfx}`);
  fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# mwh\n");
  git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "mwh@loom"); git(repo, "config", "user.name", "mwh");
  commitAll(repo, "init", GIT_ID);
  const branch = git(repo, "rev-parse", "--abbrev-ref", "HEAD");
  const sha = git(repo, "rev-parse", "HEAD");

  git(repo, "checkout", "-q", "--detach", sha);
  const isDetached = () => { try { execFileSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd: repo, stdio: ["ignore", "pipe", "ignore"] }); return false; } catch { return true; } };
  check("(D1) precondition: HEAD is genuinely detached", isDetached());
  const detached = await readMainlineHead(repo, 10_000);
  check("(D1) readMainlineHead returns null on a detached HEAD (nothing nameable to pin, never guessed)", detached === null);

  git(repo, "checkout", "-q", branch);
  const reattached = await readMainlineHead(repo, 10_000);
  check("(D2) control: back on the real branch, readMainlineHead resolves branch+tip normally", reattached?.branch === branch && reattached?.tip === sha);
}

// ── (U1)/(U2) a genuinely UNBORN repo, then control right after the first commit ─────────────────────────
{
  const repo = path.join(os.tmpdir(), `loom-mwh-unborn-${sfx}`);
  fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
  git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "mwh@loom"); git(repo, "config", "user.name", "mwh");
  const isUnborn = () => { try { execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, stdio: ["ignore", "pipe", "ignore"] }); return false; } catch { return true; } };
  check("(U1) precondition: the repo is genuinely unborn (no commit yet)", isUnborn());
  const unborn = await readMainlineHead(repo, 10_000);
  check("(U1) readMainlineHead returns null on an unborn repo (a read failure, never a crash or a guessed branch)", unborn === null);

  fs.writeFileSync(path.join(repo, "README.md"), "# mwh-unborn\n");
  commitAll(repo, "init", GIT_ID);
  const branch2 = git(repo, "rev-parse", "--abbrev-ref", "HEAD");
  const sha2 = git(repo, "rev-parse", "HEAD");
  const born = await readMainlineHead(repo, 10_000);
  check("(U2) control: immediately after the first commit, readMainlineHead resolves branch+tip normally", born?.branch === branch2 && born?.tip === sha2);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — readMainlineHead returns null (never a guess, never a crash) on a real detached HEAD and a real unborn repo, and resolves normally once either state is left."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
