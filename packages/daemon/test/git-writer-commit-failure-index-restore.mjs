import "./_guard.mjs"; // prod-guard: pure real-git exercise, no Db.
// Card af9e70b9 — GitWriter.commit() ran `add -A` and then a failing `git commit` (a refusing pre-commit
// hook) left everything `add -A` staged in the index. The fix snapshots the index tree before `add -A` and
// restores it (`read-tree`) on a confirmed failure, so the index ends exactly as it was before the call:
// this call's own staging is gone AND pre-existing staged residue is intact (content included).
//
// Run: 1) build daemon (pnpm build), 2) node test/git-writer-commit-failure-index-restore.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit, useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-gw-idxrestore-home-");
requireHermeticEnv();

const { GitWriter } = await import("../dist/git/writer.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = fs.realpathSync(mkdtempManaged("loom-gw-idxrestore-"));
const repo = path.join(root, "repo");
fs.mkdirSync(repo);
const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] }).toString();
git("init", "-q");
git("config", "user.email", "idx@loom");
git("config", "user.name", "idx");
git("commit", "-q", "--allow-empty", "-m", "init");

// Pre-existing staged residue: one file staged as v1, then edited again in the worktree (so `add -A`
// would restage v2 over it), plus a brand-new untracked file only this call's `add -A` would stage.
fs.writeFileSync(path.join(repo, "residue.txt"), "v1\n");
git("add", "residue.txt");
fs.writeFileSync(path.join(repo, "residue.txt"), "v2\n");
fs.writeFileSync(path.join(repo, "new.txt"), "new\n");
const indexBefore = git("ls-files", "--stage");
const headBefore = git("rev-parse", "HEAD").trim();
check("[0] precondition: only residue.txt is staged", indexBefore.split("\n").filter(Boolean).length === 1 && indexBefore.includes("residue.txt"));

// A refusing pre-commit hook: `add -A` succeeds, `commit` fails.
const hook = path.join(repo, ".git", "hooks", "pre-commit");
fs.writeFileSync(hook, "#!/bin/sh\necho refused >&2\nexit 1\n");
fs.chmodSync(hook, 0o755);

const writer = new GitWriter(repo);
const res = await writer.commit("test: refused by hook");
check("[1] commit() fails (hook refusal)", res.ok === false);
check("[2] no commit landed — HEAD unchanged", git("rev-parse", "HEAD").trim() === headBefore);
check("[3] index is byte-identical to its pre-call state (new.txt unstaged, residue.txt still the v1 blob)", git("ls-files", "--stage") === indexBefore);
check("[4] worktree files untouched (residue.txt still v2, new.txt present)",
  fs.readFileSync(path.join(repo, "residue.txt"), "utf8") === "v2\n" && fs.existsSync(path.join(repo, "new.txt")));

// Control: with a passing hook the same call commits normally (the restore never fires on success).
fs.rmSync(hook);
const ok = await writer.commit("test: succeeds");
check("[5] control: without the hook the same commit() succeeds and stages everything", ok.ok === true && git("show", "--stat", "--format=", "HEAD").includes("new.txt"));

// ── Commit that LANDS and then fails (reviewer round): git ignores a failing post-commit hook's exit status,
// so the failure is a post-commit hook that outlives a short timeout (kill confirmed, but HEAD already
// advanced). Restoring the pre-call snapshot here would stage a REVERSAL of the landed commit.
git("reset", "-q", "--hard", "HEAD");
fs.writeFileSync(path.join(repo, "landed.txt"), "landed\n");
const postHook = path.join(repo, ".git", "hooks", "post-commit");
fs.writeFileSync(postHook, "#!/bin/sh\nexec sleep 30\n");
fs.chmodSync(postHook, 0o755);
const headPre = git("rev-parse", "HEAD").trim();
const slowWriter = new GitWriter(repo, { gitLocalMs: 4000 });
const res2 = await slowWriter.commit("test: lands then post-commit hook hangs");
fs.rmSync(postHook);
const headPost = git("rev-parse", "HEAD").trim();
check("[6] commit() reports failure (post-commit hook outlived the timeout)", res2.ok === false);
check("[7] the commit DID land — HEAD advanced", headPost !== headPre && git("log", "-1", "--format=%s").includes("lands then"));
check("[8] index matches the NEW HEAD (no staged reversal of the landed commit)", git("diff", "--cached", "--name-status").trim() === "");
check("[9] the error says the commit may have landed", /may have landed/.test(res2.error ?? ""));

finishAndExit(failures);
