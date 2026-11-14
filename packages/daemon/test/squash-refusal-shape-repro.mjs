import "./_guard.mjs"; // prod-guard
// Card 0e916885 — the Rust judge saw `git merge --squash failed` on a branch plain git merges cleanly.
// Scratch repo of the judge's shape: main edits line 5 of f.txt AFTER the worker is cut, the worker
// edits line 1; run with and without a `.gitattributes` on main. REAL git, no claude, no daemon.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { registerForCleanup, useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), `loom-no-such-codex-bin-${process.pid}`);
useOwnLoomHome("loom-srsr-home-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distUrl = (p) => pathToFileURL(path.join(__dirname, "..", "dist", p)).href;
const { createWorktree, mergeBranch } = await import(distUrl("git/worktrees.js"));

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const IDENT = { GIT_AUTHOR_NAME: "srsr", GIT_AUTHOR_EMAIL: "srsr@loom", GIT_COMMITTER_NAME: "srsr", GIT_COMMITTER_EMAIL: "srsr@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=srsr@loom -c user.name=srsr";
const LINES = ["l1", "l2", "l3", "l4", "l5", "l6", "l7"];

async function scenario(tag, gitattributes) {
  const repo = mkdtempManaged(`loom-srsr-${tag}-`);
  git(repo, "init", "-q", "-b", "main"); git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "user.email", "srsr@loom"); git(repo, "config", "user.name", "srsr");
  fs.writeFileSync(path.join(repo, "f.txt"), LINES.join("\n") + "\n");
  commitAll(repo, "init", GIT_ID);
  git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  const taskId = `srsr-${tag}-task`;
  const { worktreePath, branch } = await createWorktree(repo, `srsr-proj-${tag}`, taskId);
  registerForCleanup(worktreePath);
  const w = LINES.slice(); w[0] = "l1-worker";
  fs.writeFileSync(path.join(worktreePath, "f.txt"), w.join("\n") + "\n");
  commitAll(worktreePath, "feat(test): worker edits line 1", GIT_ID);
  // main moves on AFTER the cut: edits line 5 (+ optionally a .gitattributes)
  const m = LINES.slice(); m[4] = "l5-main";
  fs.writeFileSync(path.join(repo, "f.txt"), m.join("\n") + "\n");
  if (gitattributes) fs.writeFileSync(path.join(repo, ".gitattributes"), gitattributes);
  commitAll(repo, "feat(test): main edits line 5", GIT_ID);
  // control: plain git squash of the same shape merges cleanly
  git(repo, "merge", "--squash", branch);
  check(`(${tag}) control: plain git merge --squash stages cleanly`, git(repo, "ls-files", "--unmerged") === "");
  git(repo, "reset", "--hard", "HEAD");
  const r = await mergeBranch(repo, branch, "feat(test): worker edits line 1", {});
  console.log(`(${tag}) mergeBranch ->`, JSON.stringify(r));
  check(`(${tag}) Loom's mergeBranch lands what plain git accepts`, r.ok === true);
  const content = fs.readFileSync(path.join(repo, "f.txt"), "utf8").split("\n");
  check(`(${tag}) landed file carries both edits`, content[0] === "l1-worker" && content[4] === "l5-main");
}

await scenario("plain", null);
await scenario("attrs", "* text=auto\n*.txt text eol=lf\n");
await scenario("attrs-merge", "*.txt merge=union\n");
// The judge's leftover from its removed driver plant: an attribute naming a driver that is NOT defined anywhere.
await scenario("attrs-undefined-driver", "f.txt merge=judgedrv\n");

// ---- error surfacing: a REAL non-conflict squash failure (unrelated histories) carries git's own text ----
{
  const { boundedSquashFailureTail } = await import(distUrl("git/worktrees.js"));
  const repo = mkdtempManaged("loom-srsr-fail-");
  git(repo, "init", "-q", "-b", "main"); git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "user.email", "srsr@loom"); git(repo, "config", "user.name", "srsr");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  commitAll(repo, "init", GIT_ID);
  git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git(repo, "checkout", "-q", "--orphan", "loom/unrelated");
  git(repo, "rm", "-rfq", ".");
  fs.writeFileSync(path.join(repo, "b.txt"), "b\n");
  commitAll(repo, "feat(test): unrelated root", GIT_ID);
  git(repo, "checkout", "-q", "main");
  const r = await mergeBranch(repo, "loom/unrelated", "feat(test): unrelated root", {});
  console.log("(unrelated) mergeBranch ->", JSON.stringify(r));
  check("(unrelated) refused, not conflict", r.ok === false && !r.conflict);
  check("(unrelated) reason names the failing step AND git's real cause", /git merge --squash failed: .*unrelated histories/i.test(r.reason ?? ""));
  check("(unrelated) reason does not leak the repo path", !(r.reason ?? "").includes(repo.replace(/\\/g, "/")) && !(r.reason ?? "").includes(repo));

  const long = boundedSquashFailureTail(`fatal: ${"x".repeat(2000)} END ${repo}`, repo);
  check("(helper) bounded to the tail, keeps the end", long.length <= 301 && long.includes("END <repo>"));
  check("(helper) empty in -> empty out", boundedSquashFailureTail(undefined, repo) === "");
}

console.log(failures ?`\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
