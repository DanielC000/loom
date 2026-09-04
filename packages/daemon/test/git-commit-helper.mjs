import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// POSITIVE CONTROL for _git-commit.mjs's commitAll() (card 0abfc9be).
//
// Proves the diagnostic this card exists to add actually discriminates: forcing the `git add .` half to
// fail names "add", forcing the `git commit` half to fail (with add having genuinely succeeded) names
// "commit" — never the other way, and never the old ambiguous "the whole chain failed" shape. A
// diagnostic never observed to fire is not a diagnostic (card 0abfc9be DoD-3) — this is that observation.
//
// Also proves identity pass-through: commitAll() with no `identity` arg commits with no `-c user.email=`/
// `-c user.name=` flags at all (the 8 original callsites this must not silently "tidy" — see _git-commit.mjs's
// own header), and with an `identity` arg the commit is recorded under exactly that committer.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loom-git-commit-helper-"));

// --- FORCE THE 'add' HALF TO FAIL: cwd is not a git repo at all, so `git add .` itself fails and
//     `git commit` never runs. ---
{
  const notARepo = path.join(tmpRoot, "not-a-repo");
  fs.mkdirSync(notARepo, { recursive: true });
  fs.writeFileSync(path.join(notARepo, "file.txt"), "x\n");

  let caught = null;
  try {
    commitAll(notARepo, "should never land", "-c user.email=gch@loom -c user.name=gch");
  } catch (err) {
    caught = err;
  }
  check("add-failure: commitAll threw", caught !== null);
  check("add-failure: error names 'git add .'", !!caught && caught.message.includes("'git add .' failed"));
  check("add-failure: error does NOT name 'git commit'", !!caught && !caught.message.includes("'git commit' failed"));
  check(
    "add-failure: error carries the real git stderr (not-a-repository)",
    !!caught && /not a git repository/i.test(caught.message),
  );
}

// --- FORCE THE 'commit' HALF TO FAIL, with 'add' genuinely succeeding first: a real repo, already
//     committed once and clean, so the second commitAll() call's `git add .` is a real (no-op) success
//     and `git commit` fails deterministically on "nothing to commit". ---
{
  const repo = path.join(tmpRoot, "clean-repo");
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
  commitAll(repo, "seed", "-c user.email=gch@loom -c user.name=gch");

  let caught = null;
  try {
    commitAll(repo, "nothing changed", "-c user.email=gch@loom -c user.name=gch");
  } catch (err) {
    caught = err;
  }
  check("commit-failure: commitAll threw", caught !== null);
  check("commit-failure: error names 'git commit'", !!caught && caught.message.includes("'git commit' failed"));
  check("commit-failure: error does NOT name 'git add .'", !!caught && !caught.message.includes("'git add .' failed"));
  check(
    "commit-failure: error carries the real git stderr/stdout (nothing to commit)",
    !!caught && /nothing to commit/i.test(caught.message),
  );
}

// --- GREEN PATH: single message, with identity — commit lands, is recorded under the given committer. ---
{
  const repo = path.join(tmpRoot, "green-repo");
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  commitAll(repo, "feat: add a.txt", "-c user.email=gch@loom -c user.name=gch");
  const subject = execFileSync("git", ["log", "-1", "--format=%s"], { cwd: repo }).toString().trim();
  const author = execFileSync("git", ["log", "-1", "--format=%ae"], { cwd: repo }).toString().trim();
  check("green: subject lands verbatim", subject === "feat: add a.txt");
  check("green: committer identity honored", author === "gch@loom");
}

// --- GREEN PATH: two messages (trailer commit), e.g. batch-merge.mjs's Claude-Session trailer shape. ---
{
  const repo = path.join(tmpRoot, "trailer-repo");
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "b.txt"), "b\n");
  commitAll(repo, ["feat(test): trailer commit", "Claude-Session: https://claude.ai/code/session_FAKE"], "-c user.email=gch@loom -c user.name=gch");
  const body = execFileSync("git", ["log", "-1", "--format=%B"], { cwd: repo }).toString();
  check("trailer: subject present", body.includes("feat(test): trailer commit"));
  check("trailer: trailer message present", body.includes("Claude-Session: https://claude.ai/code/session_FAKE"));
}

// --- GREEN PATH: no identity arg at all — commits with the ambient/pre-configured identity, i.e. does
//     NOT inject a default. Configure identity via `git config` on the repo itself (not via commitAll),
//     mirroring the 8 original no-identity-on-the-commit-line callsites. ---
{
  const repo = path.join(tmpRoot, "ambient-repo");
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "ambient@loom"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "ambient"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "c.txt"), "c\n");
  commitAll(repo, "init"); // no identity arg
  const author = execFileSync("git", ["log", "-1", "--format=%ae"], { cwd: repo }).toString().trim();
  check("ambient: commit used the repo's pre-configured identity, not an injected one", author === "ambient@loom");
}

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
