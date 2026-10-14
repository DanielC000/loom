import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 7b59e981 — regression test for the shared helper's own unit-level behavior (the real end-to-end
// hybrid case through an actual commit SITE lives in merge-solo-squash-identity-fallback.mjs's scenario
// (E)). Proves, against the REAL shared helper (`resolveGitIdentityFallbackArgs`,
// `isGitIdentityUnresolvedError`, `git/bounded.ts`) and a REAL git binary, the three defects named on the
// card, all now FIXED:
//
//  (A) the HYBRID bug (CR 4eb77ad0 round 2): when only ONE role is genuinely unresolvable, the helper used
//      to return a combined `-c user.name=/-c user.email=` fallback that also overrode the OTHER, already-
//      resolvable role's EMAIL-env-resolved component, discarding the user's real email. FIX: the helper
//      now returns a PER-ROLE env override (`buildGitIdentityFallbackEnv`) — only the unresolvable role's
//      `GIT_<ROLE>_NAME`/`GIT_<ROLE>_EMAIL`, never a shared pair.
//  (B) `useConfigOnly` (CR 89a88e7b finding 1): `isGitIdentityUnresolvedError` did not match git's real
//      fatal under `user.useConfigOnly=true` ("no email/name was given and auto-detection is disabled"),
//      so such a host read as "resolvable" and the fallback never engaged. FIX: the regex now matches it.
//  (C) never-throw (CR 89a88e7b finding 2): a synchronous `makeProbeGit` construct failure made
//      `resolveGitIdentityFallbackArgs` THROW instead of degrading to "resolvable" ({}). FIX: wrapped in
//      try/catch.
//
// Every env is fully isolated (own HOME/USERPROFILE/XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL=<empty file>,
// GIT_CONFIG_NOSYSTEM=1) so this never depends on this host's own ambient git identity — see CLAUDE.md's
// hermetic-test rule.
//
// RED/GREEN proof: `pnpm --filter @loom/daemon negative-control --file packages/daemon/src/git/bounded.ts
// --test packages/daemon/test/identity-fallback-per-role-repro.mjs --ref 7d13b283` — RED on that pre-fix
// sha (all three [FIX TARGET] checks fail), GREEN with this fix.
//
// Run: 1) build daemon (pnpm build), 2) node test/identity-fallback-per-role-repro.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const boundedUrl = pathToFileURL(path.join(__dirname, "..", "dist", "git", "bounded.js")).href;
const { resolveGitIdentityFallbackArgs, isGitIdentityUnresolvedError } = await import(boundedUrl);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const tmpDirs = [];
function freshDir(prefix) {
  const d = path.join(os.tmpdir(), `loom-ifpr-${prefix}-${sfx}`);
  fs.mkdirSync(d, { recursive: true });
  tmpDirs.push(d);
  return d;
}

// ── (A) the hybrid bug ──────────────────────────────────────────────────────────────────────────────────
// The RESOLVABILITY DECISION is driven by a STUBBED probe (author resolvable, committer not) — deterministic
// across hosts, sidestepping real auto-detect's host-specific quirks (verified separately against this real
// host: NAME auto-detect succeeds unconditionally via a Windows API call no env var touches, and EMAIL
// universally backstops BOTH roles' email whenever neither sets its own role-scoped GIT_AUTHOR_EMAIL/
// GIT_COMMITTER_EMAIL — so a real, portable "one role auto-detect-fails, the other resolves via EMAIL" case
// can't be constructed from env alone on every host). What this case actually proves is the STRUCTURAL
// flaw: whatever decided a fallback is needed, the returned override is a single GLOBAL `-c user.*` pair
// that cannot discriminate roles — it clobbers the author's real, EMAIL-env-resolved address even though
// the stub only ever claimed the COMMITTER was unresolvable.
function makeStubProbeFactory(authorOk, committerOk) {
  return () => ({
    raw: async (args) => {
      const varName = Array.isArray(args) ? args[args.length - 1] : args;
      const ok = varName === "GIT_AUTHOR_IDENT" ? authorOk : varName === "GIT_COMMITTER_IDENT" ? committerOk : true;
      if (ok) return "Stub <stub@example>\n";
      throw new Error("fatal: empty ident name (for <>) not allowed"); // a real, regex-matched git fatal shape
    },
  });
}
{
  const home = freshDir("a-home");
  const repo = freshDir("a-repo");
  const emptyGlobal = path.join(home, "empty-gitconfig");
  fs.writeFileSync(emptyGlobal, "");
  execFileSync("git", ["init", "-q", "."], { cwd: repo });
  fs.writeFileSync(path.join(repo, "f.txt"), "x\n");

  const baseEnv = {
    PATH: process.env.PATH, Path: process.env.Path,
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, ".config"),
    GIT_CONFIG_GLOBAL: emptyGlobal, GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Alice", EMAIL: "alice@real",
  };
  execFileSync("git", ["add", "."], { cwd: repo, env: baseEnv });

  const identityEnv = await resolveGitIdentityFallbackArgs(repo, 15_000, makeStubProbeFactory(true, false), baseEnv);
  check("(A) helper decided a fallback is needed (stub: author ok, committer not)", Object.keys(identityEnv).length > 0);
  check("(A) [FIX TARGET] the fallback touches ONLY the committer role's env keys, never the author's", Object.keys(identityEnv).sort().join(",") === "GIT_COMMITTER_EMAIL,GIT_COMMITTER_NAME");

  const commitEnv = { ...baseEnv, ...identityEnv };
  execFileSync("git", ["commit", "-q", "-m", "hybrid repro"], { cwd: repo, env: commitEnv });
  const authorEmail = execFileSync("git", ["log", "-1", "--format=%ae"], { cwd: repo, env: baseEnv }).toString().trim();
  const authorName = execFileSync("git", ["log", "-1", "--format=%an"], { cwd: repo, env: baseEnv }).toString().trim();
  const committerName = execFileSync("git", ["log", "-1", "--format=%cn"], { cwd: repo, env: baseEnv }).toString().trim();

  console.log(`    landed: author="${authorName} <${authorEmail}>" committer="${committerName}"`);
  check("(A) [FIX TARGET] the author's real, EMAIL-env-resolved address survives a committer-only fallback", authorEmail === "alice@real");
  check("(A) sanity: the author's real name was never in question", authorName === "Alice");
  check("(A) the committer gets the generic Loom fallback name", committerName === "Loom");
}

// ── (B) useConfigOnly ───────────────────────────────────────────────────────────────────────────────────
{
  const noEmailMsg = "fatal: no email was given and auto-detection is disabled";
  const noNameMsg = "fatal: no name was given and auto-detection is disabled";
  check("(B) [FIX TARGET] isGitIdentityUnresolvedError matches git's real useConfigOnly 'no email' fatal", isGitIdentityUnresolvedError(new Error(noEmailMsg)));
  check("(B) [FIX TARGET] isGitIdentityUnresolvedError matches git's real useConfigOnly 'no name' fatal", isGitIdentityUnresolvedError(new Error(noNameMsg)));

  // Verify these are REAL git fatals, not invented strings — reproduce them directly.
  const home = freshDir("b-home");
  const repo = freshDir("b-repo");
  const emptyGlobal = path.join(home, "empty-gitconfig");
  fs.writeFileSync(emptyGlobal, "");
  execFileSync("git", ["init", "-q", "."], { cwd: repo });
  const baseEnv = {
    PATH: process.env.PATH, Path: process.env.Path,
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, ".config"),
    GIT_CONFIG_GLOBAL: emptyGlobal, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C", LANGUAGE: "C",
  };
  let realFatal = "";
  try {
    execFileSync("git", ["-c", "user.useConfigOnly=true", "var", "GIT_AUTHOR_IDENT"], { cwd: repo, env: baseEnv, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    realFatal = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  check("(B) real git (useConfigOnly, no email anywhere) actually produces that exact fatal", realFatal.includes(noEmailMsg));
  check("(B) [FIX TARGET] the real fatal (as git actually emits it) is classified as unresolved", isGitIdentityUnresolvedError(new Error(realFatal)));
}

// ── (C) never-throw ─────────────────────────────────────────────────────────────────────────────────────
{
  const throwingMakeProbeGit = () => { throw new Error("directory does not exist (simulated worktree vanished mid-flight)"); };
  let threw = false;
  let result;
  try {
    result = await resolveGitIdentityFallbackArgs("/nonexistent/for-this-case", 15_000, throwingMakeProbeGit, undefined);
  } catch {
    threw = true;
  }
  check("(C) [FIX TARGET] a synchronous makeProbeGit construct failure never throws — degrades to resolvable ({})", threw === false && typeof result === "object" && !Array.isArray(result) && Object.keys(result).length === 0);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — none of the three defects reproduce (the fix is already in place)."
  : `\n❌ ${failures} FAILURE(S) — this is the EXPECTED RED state on main before card 7b59e981's fix lands.`);

for (const d of tmpDirs) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
}

process.exit(failures === 0 ? 0 : 1);
