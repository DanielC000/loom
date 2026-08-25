// Child process: runs ROUNDS full repo lifecycles (init+commit, then TWO worktree adds
// each followed by a commit) — mirrors merge-repo-mutex.mjs's makeTrialRepo+makeWorktree
// shape (lines 149-164) plus task-defer-until.mjs's separate (non-chained) init/commit
// call shape (lines 45-51). Reports EVERY failure it hits as JSON-lines on stdout.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const workerId = process.argv[2];
const rounds = Number(process.argv[3] || "5");
const GIT_ID = "-c user.email=mrm@loom -c user.name=mrm";

function report(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function tryExec(label, cmd, cwd) {
  try {
    execSync(cmd, { cwd });
    return true;
  } catch (err) {
    report({
      ok: false,
      label,
      cmd,
      cwd,
      status: err.status ?? null,
      signal: err.signal ?? null,
      stdout: err.stdout ? err.stdout.toString("utf8") : null,
      stderr: err.stderr ? err.stderr.toString("utf8") : null,
      message: err.message,
      code: err.code ?? null,
    });
    return false;
  }
}

function makeTrialRepo(sfx) {
  const repo = path.join(os.tmpdir(), `loom-mrm-repo-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  tryExec(
    "init+commit",
    `git init -q && git config user.email mrm@loom && git config user.name mrm && git add -A && git ${GIT_ID} commit -q -m init --allow-empty`,
    repo
  );
  return repo;
}

function makeWorktree(repo, branch, file, content, sfx) {
  const wt = path.join(os.tmpdir(), `loom-mrm-wt-${branch.replace(/\//g, "-")}-${sfx}`);
  const ok1 = tryExec("worktree-add", `git worktree add -q -b ${branch} "${wt}" HEAD`, repo);
  if (!ok1) return null;
  fs.writeFileSync(path.join(wt, file), content);
  tryExec("worktree-commit", `git add -A && git ${GIT_ID} commit -q -m "${branch} work"`, wt);
  return wt;
}

for (let t = 0; t < rounds; t++) {
  const sfx = `${workerId}-${Date.now()}-${t}-${Math.random().toString(36).slice(2, 7)}`;
  const repo = makeTrialRepo(sfx);
  makeWorktree(repo, "loom/branch-a", "file-a.txt", `a-${sfx}\n`, sfx);
  makeWorktree(repo, "loom/branch-b", "file-b.txt", `b-${sfx}\n`, sfx);
}

report({ done: true, workerId, rounds });
