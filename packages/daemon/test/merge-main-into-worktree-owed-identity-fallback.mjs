import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 7b59e981 — `mergeMainIntoWorktree`'s `owedBase` branch (worktrees.ts, the `commit-tree` call inside
// `if (owedBase)`) is the ONE identity-fallback call site with no existing per-call env hook: it reuses
// `wtGit`, constructed with no explicit env at all. The fix builds a dedicated one-off `canonicalGit`
// instance carrying the per-role fallback env ONLY when actually needed — this file is the dedicated
// real-git proof that specific site applies the fallback correctly, since none of the other identity test
// files exercise the owedBase branch at all (they only exercise the PLAIN union-merge branch).
//
// Uses `deps.identityProbeGitFactory` to STUB the resolvability decision (author ok, committer not) rather
// than forcing a real ambient failure: `computeOwedLanding` (worktrees.ts) ALSO needs an identity for its
// own internal, UNCONDITIONAL, deliberately-out-of-scope `commit-tree` calls (see docs/decisions/2267e8fa-
// ...md's "Out of scope, deliberately" bullet) when the owed range has a non-empty-on-main commit — an
// ambiently-forced failure (e.g. GIT_COMMITTER_NAME="") would ALSO break that unrelated, pre-existing,
// out-of-scope path, which isn't what this file exists to test. Stubbing the probe keeps the REAL ambient
// env fully resolvable (so computeOwedLanding's own internal step is unaffected) while still exercising
// this card's fix for the FINAL commit-tree call specifically.
//
// Second scenario (CR ff3eec9f): an ambient GIT_ASKPASS must not break the owedBase one-off instance —
// `wtGit` never had an explicit env before this card, so simple-git's `blockUnsafeOperationsPlugin` never
// ran on it; the one-off instance's explicit env must strip the transport family (`localReadGitEnv`) or an
// ambient GIT_ASKPASS throws "not permitted without allowUnsafeAskPass" on a call that used to be silent
// about it.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-main-into-worktree-owed-identity-fallback.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempManaged } from "./_tmp-fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const { mergeMainIntoWorktree } = await import(pathToFileURL(path.join(distGitDir, "worktrees.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const git = (cwd, args) => execFileSync("git", args, { cwd }).toString().trim();

const SETUP_ID_ARGV = ["-c", "user.email=mmiwo@loom", "-c", "user.name=mmiwo"]; // scoped: persists nothing

// A REAL, coherent owed fixture: a base commit, a worktree with ONE owed commit (a new file), and main
// independently advancing on a DIFFERENT file — a trivial, non-conflicting 3-way merge
// `computeOwedLanding` can actually compute. Every setup commit uses the scoped ID above, never ambient
// env, so the isolated/mutated env set up for the real test below never interferes with setup.
function makeOwedFixture() {
  const repo = mkdtempManaged("loom-mmiwo-");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", [...SETUP_ID_ARGV, "commit", "-q", "-m", "base"], { cwd: repo });
  const base = git(repo, ["rev-parse", "HEAD"]);
  const wt = mkdtempManaged("loom-mmiwo-wt-");
  const branch = "loom/mmiwo-owed";
  execFileSync("git", ["worktree", "add", "-q", "-b", branch, wt, "HEAD"], { cwd: repo });
  fs.writeFileSync(path.join(wt, "owed.txt"), "owed\n");
  execFileSync("git", ["add", "-A"], { cwd: wt });
  execFileSync("git", [...SETUP_ID_ARGV, "commit", "-q", "-m", "owed commit"], { cwd: wt });
  fs.writeFileSync(path.join(repo, "main.txt"), "main advance\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", [...SETUP_ID_ARGV, "commit", "-q", "-m", "main advance"], { cwd: repo });
  return { repo, wt, base, branch };
}

// Stub factory matching resolveGitIdentityFallbackArgs's own `makeProbeGit` shape — forces the
// resolvability DECISION deterministically (author ok, committer not), independent of the real ambient
// env or host-specific auto-detect quirks.
function makeStubProbeFactory(authorOk, committerOk) {
  return () => ({
    raw: async (args) => {
      const varName = Array.isArray(args) ? args[args.length - 1] : args;
      const ok = varName === "GIT_AUTHOR_IDENT" ? authorOk : varName === "GIT_COMMITTER_IDENT" ? committerOk : true;
      if (ok) return "Stub <stub@example>\n";
      throw new Error("fatal: empty ident name (for <>) not allowed");
    },
  });
}

console.log("\n— owedBase commit-tree: HYBRID identity (author via EMAIL env, committer genuinely unresolvable) —");
const { repo, wt, base, branch } = makeOwedFixture();

// Isolated HOME/GIT_CONFIG_GLOBAL so this REAL host's own global `user.email` (ranked ABOVE the EMAIL env
// var in git's precedence) can never leak in and resolve the author's email instead of EMAIL — same
// isolation merge-solo-squash-identity-fallback.mjs's own scenarios use, applied AFTER fixture setup
// (which never touches config/env — every setup commit uses the scoped `-c` ID above).
const isolatedHome = mkdtempManaged("loom-mmiwo-home-");
const emptyGlobalConfig = path.join(isolatedHome, "empty-gitconfig");
fs.writeFileSync(emptyGlobalConfig, "");
const savedEnv = {};
for (const k of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"]) {
  savedEnv[k] = process.env[k];
}
try {
  process.env.HOME = isolatedHome;
  process.env.USERPROFILE = isolatedHome;
  process.env.XDG_CONFIG_HOME = isolatedHome;
  process.env.GIT_CONFIG_GLOBAL = emptyGlobalConfig;
  process.env.GIT_CONFIG_SYSTEM = emptyGlobalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  delete process.env.GIT_AUTHOR_EMAIL;
  delete process.env.GIT_COMMITTER_NAME;
  delete process.env.GIT_COMMITTER_EMAIL;
  // The REAL env the FINAL commit-tree call's merged env (`{...nonInteractiveEnv(), ...identityEnv}`)
  // will carry for the author role — resolvable on its own (role-env name + EMAIL-env address), exactly
  // the hybrid shape card 7b59e981 fixes. The committer role is forced unresolvable by the STUB below,
  // never by ambient env, so `computeOwedLanding`'s own unrelated internal identity need is unaffected.
  process.env.GIT_AUTHOR_NAME = "Alice";
  process.env.EMAIL = "alice@real";

  const res = await mergeMainIntoWorktree(repo, wt, { identityProbeGitFactory: makeStubProbeFactory(true, false) }, base, branch);

  check(`mergeMainIntoWorktree (owedBase) succeeds (reason: ${res.ok ? "n/a" : res.reason})`, res.ok === true);
  check("a real owed-landing commit actually happened (merged:true)", res.ok === true && res.merged === true);
  if (res.ok) {
    const author = git(wt, ["log", "-1", "--format=%an <%ae>"]);
    check(`[FIX TARGET] the owedBase commit-tree's AUTHOR keeps the real EMAIL-env address, NOT the fallback (got "${author}")`, author === "Alice <alice@real>");
    const committer = git(wt, ["log", "-1", "--format=%cn <%ce>"]);
    check(`the owedBase commit-tree's COMMITTER gets the generic Loom fallback (got "${committer}")`, committer === "Loom <loom@localhost>");
  }
} finally {
  for (const k of Object.keys(savedEnv)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

// ── CR ff3eec9f regression: an ambient transport env var (GIT_ASKPASS, e.g. VS Code's own terminal sets
// it) must never make the owedBase one-off instance throw "not permitted without allowUnsafeAskPass" —
// `wtGit` never had an explicit env before this card (so simple-git's `blockUnsafeOperationsPlugin` never
// even ran on it), but the one-off instance DOES pass an explicit env, which arms that plugin unless the
// transport family is stripped first (`localReadGitEnv`, not a bare `{...nonInteractiveEnv(), ...}`
// spread). `commit-tree` never touches a remote, so stripping it here is safe. ───────────────────────────
{
  console.log("\n— owedBase commit-tree: an ambient GIT_ASKPASS must not break the one-off instance —");
  const { repo, wt, base, branch } = makeOwedFixture();
  const savedEnv2 = {};
  for (const k of ["GIT_ASKPASS", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL"]) savedEnv2[k] = process.env[k];
  try {
    // Never actually invoked (nothing here authenticates); its mere PRESENCE is what simple-git's
    // blockUnsafeOperationsPlugin reacts to on an explicit env.
    process.env.GIT_ASKPASS = path.join(path.sep, "nonexistent", "askpass-stub.exe");
    // Fully role-scoped (never EMAIL/auto-detect) so this scenario stays hermetic under the identity-less
    // recipe too — the stub forces committer to need the fallback (so identityEnv is non-empty and the
    // one-off instance is actually constructed), independent of whatever the real ambient env can resolve.
    process.env.GIT_AUTHOR_NAME = "AskpassAuthor";
    process.env.GIT_AUTHOR_EMAIL = "askpass-author@example.com";
    const res = await mergeMainIntoWorktree(repo, wt, { identityProbeGitFactory: makeStubProbeFactory(true, false) }, base, branch);
    check(`[FIX TARGET] mergeMainIntoWorktree (owedBase) succeeds despite an ambient GIT_ASKPASS (reason: ${res.ok ? "n/a" : res.reason})`, res.ok === true);
    check("[FIX TARGET] a real owed-landing commit actually happened despite the ambient GIT_ASKPASS (merged:true)", res.ok === true && res.merged === true);
  } finally {
    for (const k of Object.keys(savedEnv2)) {
      if (savedEnv2[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv2[k];
    }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — mergeMainIntoWorktree's owedBase commit-tree call applies the per-role identity fallback correctly, via its own dedicated one-off canonicalGit instance, and survives an ambient transport env var it never had to deal with before."
  : `\n❌ ${failures} FAILURE(S).`);

process.exit(failures === 0 ? 0 : 1);
