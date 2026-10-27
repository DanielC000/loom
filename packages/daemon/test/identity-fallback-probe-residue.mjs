import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision f4da727f round 2 — the identity-fallback probe must run BEFORE `git merge --squash`, never
// cleaned up after it: the real probe failure (a commondir-trust pinMismatch) uses the same trust check
// a post-stage `reset --hard` cleanup would also hit, so a persisting condition would refuse that too.
//
// SCENARIO: a REAL commondir-trust-pin mismatch (not a synthetic injected error) trips the probe via the
// production seam (registerCommondirTrustPinLookup); asserts the canonical index stays UNTOUCHED, and
// once the condition clears, a second, unrelated branch's plain merge succeeds immediately.
//
// RED PROOF (negative control, run once, not re-run automatically): this scenario's residue/second-merge
// checks both fail against EITHER prior state — ed64ba98 (pre-card base, no cleanup at all) AND round 1
// (a0d1b81e, post-stage resetOrSkip, which the same persisting trust condition also refuses) — see the
// worker's own report for both runs.
//
// Run: 1) pnpm build, 2) node packages/daemon/test/identity-fallback-probe-residue.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-ifpr-");
requireHermeticEnv();

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { mergeBranch } = await import("../dist/git/worktrees.js");
const { registerCommondirTrustPinLookup, canonicalGit } = await import("../dist/git/bounded.js");

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const tmpDirs = [];

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-ifpr-${tag}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "# repo\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.email=setup@loom", "-c", "user.name=setup", "commit", "-q", "-m", "init"], { cwd: repo });
  return repo;
}

function addWorktreeBranch(repo, branch, fileName, content) {
  const wt = path.join(os.tmpdir(), `loom-ifpr-wt-${branch.replace(/\//g, "_")}-${sfx}`);
  tmpDirs.push(wt);
  execFileSync("git", ["worktree", "add", "-q", "-b", branch, wt, "HEAD"], { cwd: repo });
  fs.writeFileSync(path.join(wt, fileName), content);
  execFileSync("git", ["add", "."], { cwd: wt });
  execFileSync("git", ["-c", "user.email=worker@loom", "-c", "user.name=worker", "commit", "-q", "-m", "worker work"], { cwd: wt });
  return wt;
}

try {
  const repo = makeRepo("s1");
  const branch = `loom/ifpr-s1-${sfx}`;
  addWorktreeBranch(repo, branch, "feature.txt", `content-${sfx}\n`);

  // PRODUCTION-SHAPED fault: a real commondir-trust-pin mismatch via checkCommondirTrust, not a synthetic
  // injected error. Once `untrusted` flips true, EVERY canonicalGit-mediated call (including resetOrSkip's
  // own `reset --hard`, if it ran) sees the same persisting refusal — the shape that defeated round 1's
  // post-stage cleanup. `identityProbeGitFactory` flips it as a side effect of being called at probe time,
  // mirroring the real-world case where a worker/process changes the commondir between calls.
  let untrusted = false;
  registerCommondirTrustPinLookup((p) => (untrusted
    ? { toplevel: "C:\\fake\\pinned", pinnedAt: "2026-01-01T00:00:00.000Z", source: "bind", projectId: "p", repoKey: "r" }
    : null));
  const identityProbeGitFactory = (cwd, ms, env) => { untrusted = true; return canonicalGit(cwd, ms, env); };

  const result1 = await mergeBranch(repo, branch, "feat(test): ifpr-s1", { identityProbeGitFactory });
  check("(1) merge refused (real commondir-trust pinMismatch at probe time)", result1.ok === false);
  check("(1) refusal names the identity-fallback probe", (result1.reason ?? "").includes("identity-fallback probe:"));
  check('(1) refusal is literally "refused, nothing changed" (canonicalFailureMessage\'s own pinMismatch wording)', (result1.reason ?? "").includes("refused, nothing changed"));
  check("(1) refusal carries no quarantined/transient/residuePossible flag — there is nothing to flag", !result1.quarantined && !result1.transient && !result1.residuePossible);

  const staged = git(repo, ["diff", "--cached", "--name-only"]);
  check("(1) CANONICAL INDEX UNTOUCHED: the probe ran before the squash, so nothing was ever staged", staged === "");

  // Simulate the real remedy (a human fixes the pin / the condition clears) and prove no residue survived
  // to block the NEXT merge — the actual behavior this ordering buys over round 1's post-stage cleanup,
  // which could itself be refused by the same persisting condition.
  untrusted = false;
  const branch2 = `loom/ifpr-s1b-${sfx}`;
  addWorktreeBranch(repo, branch2, "feature2.txt", `content2-${sfx}\n`);
  const result2 = await mergeBranch(repo, branch2, "feat(test): ifpr-s1b");
  check("(2) SECOND merge (unrelated branch, condition cleared, no fault) succeeds immediately", result2.ok === true);

  registerCommondirTrustPinLookup(undefined);

  console.log(failures === 0
    ? "\n✅ ALL PASS — moving the identity-fallback probe before the squash leaves the canonical repo genuinely untouched on a real commondir-trust refusal, so no residue survives to block the next merge."
    : `\n❌ ${failures} FAILURE(S).`);
} finally {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
}

process.exit(failures === 0 ? 0 : 1);
