import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 2267e8fa (CR 4eb77ad0 round 2, BLOCKING finding 1) — `isGitIdentityUnresolvedError` matches git's
// ENGLISH fatal text, but the identity probe used to inherit whichever env the CALLER's real git
// instance happened to carry. `mergeBranchLocked`/batch-merge's cherry-pick already passed
// `nonInteractiveEnv()` (which pins `LC_ALL=C`, safe), but `mergeMainIntoWorktree` and `commitVault`'s
// `pinnedGit` carried NO locale pin at all — on a localized host (e.g. `LANG=de_DE` with a gettext git),
// git's own fatal would come back translated, `isGitIdentityUnresolvedError` would never match it, the
// probe would read "resolved" when it genuinely was NOT, and the real commit would then fail outright —
// a REGRESSION versus the old config-read probe, which never depended on locale at all.
//
// FIX: `resolveGitIdentityFallbackArgs`/`resolveGitIdentityFallbackArgsSync` now pin `LC_ALL=C`/
// `LANGUAGE=C` on the PROBE's own env themselves (via `localReadGitEnv`), regardless of what env the
// caller's REAL commit instance uses — see bounded.ts's own doc for why this can't be done by mutating
// the caller's existing instance (`.env()` replaces it wholesale).
//
// Windows can't exercise a genuinely translated git binary to prove this BEHAVIORALLY (no localized git
// available here), so per the CR's own direction this test uses the ENV-ASSERTION PROXY instead: a
// test-seam factory/exec-fn captures the EXACT env object passed to the probe's own construction/call at
// EACH of the four async identity-creating sites plus the one sync site, and asserts `LC_ALL === "C"` AND
// `LANGUAGE === "C"` on every one of them — the only thing a RED here can mean is that one of those five
// sites stopped pinning the probe's locale, which is exactly the regression this guards against.
//
// Run: 1) build daemon (pnpm build), 2) node test/identity-probe-locale-pin.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const worktreesUrl = pathToFileURL(path.join(__dirname, "..", "dist", "git", "worktrees.js")).href;
const batchMergeUrl = pathToFileURL(path.join(__dirname, "..", "dist", "git", "batch-merge.js")).href;
const versionerUrl = pathToFileURL(path.join(__dirname, "..", "dist", "vault", "versioner.js")).href;
const { mergeMainIntoWorktree, mergeBranch } = await import(worktreesUrl);
const { assembleBatchBranches } = await import(batchMergeUrl);
const { commitVault, VaultVersioner } = await import(versionerUrl);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const git = (cwd, args) => execFileSync("git", args, { cwd }).toString().trim();

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const tmpDirs = [];
const ID_ARGS = ["-c", "user.email=setup@loom", "-c", "user.name=setup"]; // scoped: persists nothing

function makeRepo(prefix) {
  const repo = path.join(os.tmpdir(), `loom-iplp-${prefix}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  execSync("git init -q", { cwd: repo });
  // Card 2267e8fa (CR 7163d56a round 2, BLOCKING finding 1): PERSIST a repo-local identity (never a
  // scoped `-c` override, which the stubbed probe's real commit below cannot see) — same pattern case
  // (5)'s own vault setup already uses. The stub probe always reports "resolved", so `identityArgs` is
  // `[]` for every case here: the REAL commit that follows relies entirely on whatever identity git
  // itself resolves at commit time. On an identity-LESS host (no ambient config, no env — the real
  // condition this repo's own ubuntu CI runs under, per memory `2e73af30`'s own recipe) that commit
  // would otherwise fail outright ("Author identity unknown"), making this test pass only on a host that
  // happens to already have a git identity configured — exactly the ambient-state dependency CLAUDE.md's
  // own hermetic-test rule forbids. Persisting it here removes that dependency.
  execFileSync("git", ["config", "user.email", "iplp@loom"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "iplp"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "# iplp\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", [...ID_ARGS, "commit", "-q", "-m", "init"], { cwd: repo });
  return repo;
}

function cutWorktree(repo, branch, file) {
  const wt = path.join(os.tmpdir(), `loom-iplp-wt-${branch.replace(/\//g, "-")}-${sfx}`);
  tmpDirs.push(wt);
  execFileSync("git", ["worktree", "add", "-q", "-b", branch, wt, "HEAD"], { cwd: repo });
  fs.writeFileSync(path.join(wt, file), "work\n");
  execFileSync("git", ["add", "."], { cwd: wt });
  execFileSync("git", [...ID_ARGS, "commit", "-q", "-m", `${branch} work`], { cwd: wt });
  return wt;
}

/** A fake probe factory: captures every call's `(cwd, timeoutMs, env)`, resolves both `git var` probes as
 *  success (so the caller's own identityArgs decision is `[]` and the REST of the real function proceeds
 *  normally against the real repo, under the PERSISTED repo-local identity `makeRepo`/the vault setup
 *  below establish — never an ambient one, which a clean CI host simply doesn't have). */
function makeCapturingProbeFactory(captured) {
  return (cwd, timeoutMs, env) => {
    captured.push({ cwd, timeoutMs, env });
    return { raw: async () => "whatever\n" };
  };
}

function assertLocalePinned(label, captured) {
  check(`${label}: the probe's factory was actually invoked`, captured.length > 0);
  for (const [i, c] of captured.entries()) {
    check(`${label}: call #${i + 1} pins LC_ALL=C`, c.env?.LC_ALL === "C");
    check(`${label}: call #${i + 1} pins LANGUAGE=C`, c.env?.LANGUAGE === "C");
  }
}

// ── (1) mergeMainIntoWorktree ──────────────────────────────────────────────────────────────────────────
{
  const captured = [];
  const repo = makeRepo("mmiw");
  const branch = `loom/iplp-mmiw-${sfx}`;
  const wt = cutWorktree(repo, branch, "branch-file.txt");
  fs.writeFileSync(path.join(repo, "main-file.txt"), "main advance\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", [...ID_ARGS, "commit", "-q", "-m", "main advance"], { cwd: repo });

  const res = await mergeMainIntoWorktree(repo, wt, { identityProbeGitFactory: makeCapturingProbeFactory(captured) });
  check("(1) mergeMainIntoWorktree: the merge itself still succeeded with the probe stubbed", res.ok === true);
  assertLocalePinned("(1) mergeMainIntoWorktree", captured);
}

// ── (2) mergeBranchLocked (via mergeBranch) ───────────────────────────────────────────────────────────
{
  const captured = [];
  const repo = makeRepo("squash");
  const branch = `loom/iplp-squash-${sfx}`;
  cutWorktree(repo, branch, "feature.txt");
  const res = await mergeBranch(repo, branch, "test(git): locale pin probe", { identityProbeGitFactory: makeCapturingProbeFactory(captured) });
  check("(2) mergeBranch (solo squash): the squash itself still succeeded with the probe stubbed", res.ok === true);
  assertLocalePinned("(2) mergeBranchLocked", captured);
}

// ── (3) batch-merge's cherry-pick commit (landBranchCommitsIndividually, via assembleBatchBranches) ─────
{
  const captured = [];
  const repo = makeRepo("batch");
  const branch = `loom/iplp-batch-${sfx}`;
  cutWorktree(repo, branch, "feature.txt");
  const batchWt = path.join(os.tmpdir(), `loom-iplp-batchwt-${sfx}`);
  tmpDirs.push(batchWt);
  execFileSync("git", ["worktree", "add", "-q", "-b", `loom/iplp-batch-scratch-${sfx}`, batchWt, "HEAD"], { cwd: repo });

  const { landed, dropped } = await assembleBatchBranches(repo, batchWt, [
    { workerSessionId: "iplp-wkr", taskId: "iplp-task", branch, taskTitle: "feat(test): iplp" },
  ], { identityProbeGitFactory: makeCapturingProbeFactory(captured) });
  check("(3) assembleBatchBranches: landed exactly one candidate with the probe stubbed", landed.length === 1 && dropped.length === 0);
  assertLocalePinned("(3) batch-merge cherry-pick", captured);
}

// ── (4) commitVault (async) ────────────────────────────────────────────────────────────────────────────
{
  const captured = [];
  const vaultDir = path.join(os.tmpdir(), `loom-iplp-vault-${sfx}`);
  fs.mkdirSync(vaultDir, { recursive: true });
  tmpDirs.push(vaultDir);
  // Pre-`git init` + PERSIST an identity (same reasoning as makeRepo above, and the same pattern case
  // (5)'s own vault setup uses) — commitVault's own discovery sees this already-initialized repo and
  // never re-inits it, so the persisted identity is what the real commit resolves under.
  execSync("git init -q", { cwd: vaultDir });
  execFileSync("git", ["config", "user.email", "iplp-vault@loom"], { cwd: vaultDir });
  execFileSync("git", ["config", "user.name", "iplp-vault"], { cwd: vaultDir });
  fs.writeFileSync(path.join(vaultDir, "note.md"), "note\n");
  const result = await commitVault(vaultDir, "test: locale pin probe", { deps: { identityProbeGitFactory: makeCapturingProbeFactory(captured) } });
  check("(4) commitVault: the commit itself still succeeded with the probe stubbed", result?.committed === true);
  assertLocalePinned("(4) commitVault", captured);
}

// ── (5) flushSync (sync) — the one site with NO identityProbeGitFactory; captures via the SAME
//     flushExecFileSyncImpl seam `add`/`commit` already use, distinguishing a `var` probe call by argv. ──
{
  const capturedEnvs = [];
  const vaultDir = path.join(os.tmpdir(), `loom-iplp-flushvault-${sfx}`);
  fs.mkdirSync(vaultDir, { recursive: true });
  tmpDirs.push(vaultDir);
  execSync("git init -q", { cwd: vaultDir });
  execFileSync("git", ["config", "user.email", "flush-iplp@loom"], { cwd: vaultDir });
  execFileSync("git", ["config", "user.name", "flush-iplp"], { cwd: vaultDir });
  fs.writeFileSync(path.join(vaultDir, "note.md"), "note\n");

  const capturingExecImpl = (file, args, opts) => {
    if (args.includes("var")) capturedEnvs.push(opts.env);
    return execFileSync(file, args, opts);
  };
  const vc = new VaultVersioner(vaultDir, 60_000, undefined, { flushExecFileSyncImpl: capturingExecImpl });
  await vc.start();
  const resultSync = vc.flushSync();
  await vc.stop();
  check("(5) flushSync: the commit itself still succeeded with the probe captured", resultSync === true);
  check("(5) flushSync: the probe's exec call was actually captured (both GIT_AUTHOR_IDENT and GIT_COMMITTER_IDENT)", capturedEnvs.length === 2);
  for (const [i, env] of capturedEnvs.entries()) {
    check(`(5) flushSync: probe call #${i + 1} pins LC_ALL=C`, env?.LC_ALL === "C");
    check(`(5) flushSync: probe call #${i + 1} pins LANGUAGE=C`, env?.LANGUAGE === "C");
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — every one of the five identity-fallback probe sites (mergeMainIntoWorktree, the solo squash, batch-merge's cherry-pick, commitVault, and flushSync) pins LC_ALL=C/LANGUAGE=C on its OWN probe call, regardless of what env the caller's real commit instance carries."
  : `\n❌ ${failures} FAILURE(S).`);

for (const d of tmpDirs) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
}

process.exit(failures === 0 ? 0 : 1);
