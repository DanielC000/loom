import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card a746a3eb: canonical/worktree simple-git calls that construct a REAL `SimpleGit` instance with an
// EXPLICIT env built from `nonInteractiveEnv()` (git/writer.ts) — e.g. `boundedMergeGit`'s
// `canonicalGit(repoPath, timeoutMs, nonInteractiveEnv())` — arm simple-git's `blockUnsafeOperationsPlugin`
// the moment `.env()` is called with that object, because `nonInteractiveEnv()` only strips the
// editor/pager family (`scrubGitEnv`/`GIT_ENV_STRIP_KEYS`), never the transport family
// (`GIT_ENV_TRANSPORT_KEYS`: GIT_ASKPASS/SSH_ASKPASS/GIT_SSH/GIT_SSH_COMMAND/GIT_PROXY_COMMAND/...). A
// daemon launched from a terminal that ambiently exports GIT_ASKPASS (VS Code's integrated terminal does
// this for its own Git extension) then fails every LOCAL read/write that happens to route through one of
// those instances' own `.raw()`/`.status()`/`.revparse()`/`.branchLocal()` methods directly — with
// simple-git's own "not permitted without enabling allowUnsafeAskPass" — even though none of these calls
// ever touches a remote and GIT_ASKPASS is never actually invoked.
//
// FOUR real-git scenarios, all WITH a configured identity (so a failure here can only be this card's own
// bug, never the separate identity-fallback class card 2267e8fa/7b59e981 already cover):
//   (A) the solo squash merge (`mergeBranch` → `mergeBranchLocked`, git/worktrees.ts) — `boundedMergeGit`
//       builds its `git` object via `canonicalGit(repoPath, timeoutMs, nonInteractiveEnv())`, and
//       `mergeBranchLocked` calls `git.raw(["diff","--cached","--name-only"])` directly on it (the EXACT
//       site the card's own repro names: "failed to inspect canonical repo staged state before merge").
//   (B) the codex auto-commit (`attemptCodexAutoCommit`, git/worktrees.ts) — its own `makeGit` default is
//       `canonicalGit(p, ms, nonInteractiveEnv(), ...)`, and step (A) (`rev-parse --abbrev-ref HEAD`) calls
//       `git.raw([...])` directly on it, before the commit step is ever reached.
//   (C) `GitWriter.checkout()` + `GitWriter.commit()` (git/writer.ts) — the human/agent-facing project-repo
//       write surface. Its own `resolveOperationalHomeToplevelRefusal` gate (`refuseIfOperationalHome`)
//       runs before EITHER method's real work, so this also covers that chokepoint.
//   (D) the batch landing worktree (`assembleBatchBranches`, git/batch-merge.ts) — its own `boundedMergeGit`
//       is a SEPARATE site from (A)'s (git/worktrees.ts has its own copy), and CR 01e61841 found nothing in
//       this suite exercised it under an ambient GIT_ASKPASS — the gate/CI never set one, so a revert here
//       was gate-invisible. Also pins the strip's BREADTH beyond GIT_ASKPASS alone: one cheap case each for
//       `GIT_SSH_COMMAND` and `GIT_CONFIG_COUNT` (both in `GIT_ENV_TRANSPORT_KEYS`, `git/bounded.ts`).
//   (E) card 23c74c62's own bug, not a746a3eb's: an ENV-LESS `canonicalGit(...)` call under BOTH GIT_ASKPASS
//       AND GIT_CONFIG ambient at once. GIT_CONFIG's presence forces `prepareCanonicalEnv` (git/bounded.ts)
//       to MATERIALIZE an explicit env for what would otherwise stay env-less — `canonicalGit` itself now
//       ALSO strips GIT_ASKPASS from that materialized copy, but ONLY when the caller passed no `env` of
//       its own (Code Review round of 23c74c62: the fix narrowed from stripping inside `prepareCanonicalEnv`
//       itself, which would ALSO have silently changed the raw-spawn path's env — see (G) below).
//   (F) the narrow fix's OTHER edge, proving it stays narrow: canonicalGit called with an EXPLICIT env that
//       itself carries GIT_CONFIG + GIT_ASKPASS must still REFUSE loudly — an explicit env is the caller's
//       OWN responsibility (already `localNonInteractiveEnv()`/`localReadGitEnv()`-class in every real
//       caller), never silently stripped on its behalf.
//   (G) the raw-spawn path (`killableCanonicalRaw` → `spawnCanonicalGitTree` → `rawViaDirectSpawn`/
//       `rawViaWinJobLauncher`) must stay BYTE-IDENTICAL to pre-card behaviour: under the SAME GIT_CONFIG +
//       GIT_ASKPASS ambient combination that (E) fixes for `canonicalGit`, a raw-spawn child must still
//       actually RECEIVE `GIT_ASKPASS` in its own env — this path never touches simple-git's
//       `blockUnsafeOperationsPlugin` at all, and may legitimately need the transport family for an
//       IMPLICIT fetch (an LFS smudge filter, a partial-clone promisor fetch) during a canonical mutation.
//
// All seven set an ambient transport-family var (a fake, never-invoked value for the ASKPASS/SSH shapes —
// matching VS Code's own `GIT_ASKPASS=C:/fake/askpass.exe` shape named in the card) and expect the op to
// succeed unchanged (or, for (F), to loudly refuse), since none of these ever touch a remote. (A)-(D) were
// RED before card a746a3eb's own fix landed, now PASS; (E) is RED before card 23c74c62's fix (`canonicalGit`,
// `git/bounded.ts`); (F) and (G) pin the narrow fix's own boundary and would have been RED against the
// FIRST (too-broad) shape of 23c74c62's fix, which stripped transport keys inside `prepareCanonicalEnv`
// itself — see docs/decisions/a746a3eb-*.md's "Follow-up 23c74c62" section.
// `GitWriter.push()` is the deliberate exception (CAN reach a remote, must STAY blocked) — pinned in
// `test/git-env-vulnerability-strip.mjs`'s own section 2b, not duplicated here.
//
// Run: 1) build daemon (pnpm build), 2) node test/git-askpass-explicit-env.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";

// createworktree-loom-home-guard: scenario (B) calls the real createWorktree( below, so a temp LOOM_HOME
// must be in force BEFORE the dist import (WORKTREES_DIR is a sibling of LOOM_HOME).
process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-gaee-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { mergeBranch, createWorktree, attemptCodexAutoCommit } = await import("../dist/git/worktrees.js");
const { GitWriter } = await import("../dist/git/writer.js");
const { assembleBatchBranches } = await import("../dist/git/batch-merge.js");
const { canonicalGit, killableCanonicalRaw, localReadGitEnv } = await import("../dist/git/bounded.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const git = (cwd, args) => execFileSync("git", args, { cwd }).toString().trim();

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const tmpDirs = [process.env.LOOM_HOME];

function makeRepo(prefix) {
  const repo = path.join(os.tmpdir(), `loom-gaee-${prefix}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  execSync("git init -q", { cwd: repo });
  return repo;
}

function makeWorktree(repo, branch, file, content) {
  const wt = path.join(os.tmpdir(), `loom-gaee-wt-${branch.replace(/\//g, "-")}-${sfx}`);
  tmpDirs.push(wt);
  execFileSync("git", ["worktree", "add", "-q", "-b", branch, wt, "HEAD"], { cwd: repo });
  fs.writeFileSync(path.join(wt, file), content);
  execFileSync("git", ["add", "."], { cwd: wt });
  execFileSync("git", ["commit", "-q", "-m", `${branch} work`], { cwd: wt });
  return wt;
}

// A fake, never-invoked askpass target — matching the card's own VS Code example. These ops never
// authenticate, so GIT_ASKPASS is never actually exec'd; its mere PRESENCE in an explicit env simple-git
// `.env()`s is what arms blockUnsafeOperationsPlugin.
const FAKE_ASKPASS = process.platform === "win32" ? "C:\\fake\\askpass.exe" : "/fake/askpass.sh";

const savedAskpass = process.env.GIT_ASKPASS;

// ── (A) solo squash merge, WITH a configured identity, under an ambient GIT_ASKPASS ──────────────────────
{
  console.log("\n— (A) solo squash merge (mergeBranch) with a configured identity + ambient GIT_ASKPASS —");
  const repo = makeRepo("a");
  execFileSync("git", ["config", "user.email", "configured-a@loom"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "configured-a"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "# a\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "init", "--allow-empty"], { cwd: repo });

  const branch = "loom/gaee-a";
  makeWorktree(repo, branch, "feature-a.txt", `a-content-${sfx}\n`);

  process.env.GIT_ASKPASS = FAKE_ASKPASS;
  let res;
  try {
    res = await mergeBranch(repo, branch, "test(git): verify squash under ambient GIT_ASKPASS (A)");
  } finally {
    if (savedAskpass === undefined) delete process.env.GIT_ASKPASS; else process.env.GIT_ASKPASS = savedAskpass;
  }

  check(
    `(A) mergeBranch succeeds under an ambient GIT_ASKPASS (never touches a remote) (reason: ${res.ok ? "n/a" : res.reason})`,
    res.ok === true,
  );
  if (res.ok) {
    const author = git(repo, ["log", "-1", "--format=%an <%ae>"]);
    check(`(A) the landed commit's author is the CONFIGURED identity (got "${author}")`, author === "configured-a <configured-a@loom>");
  }
}

// ── (B) codex auto-commit, WITH a configured identity, under an ambient GIT_ASKPASS ───────────────────────
{
  console.log("\n— (B) codex auto-commit (attemptCodexAutoCommit) with a configured identity + ambient GIT_ASKPASS —");
  const repo = makeRepo("b");
  execFileSync("git", ["config", "user.email", "configured-b@loom"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "configured-b"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "# b\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });

  const { worktreePath, branch } = await createWorktree(repo, `gaee-b-proj-${sfx}`, `gaee-b-task-${sfx}`);
  tmpDirs.push(worktreePath);
  fs.writeFileSync(path.join(worktreePath, "feature-b.txt"), `b-content-${sfx}\n`);

  process.env.GIT_ASKPASS = FAKE_ASKPASS;
  let ac;
  try {
    // @decision 3a5c5d4a — `trustedMainRoot: repo` mirrors what a real caller (sessions/service.ts)
    // now threads explicitly; without it checkCommondirTrust would compare the worktree against itself.
    ac = await attemptCodexAutoCommit(worktreePath, branch, { summary: "verify auto-commit under ambient GIT_ASKPASS (B)" }, { trustedMainRoot: repo });
  } finally {
    if (savedAskpass === undefined) delete process.env.GIT_ASKPASS; else process.env.GIT_ASKPASS = savedAskpass;
  }

  check(
    `(B) attemptCodexAutoCommit succeeds under an ambient GIT_ASKPASS (never touches a remote) (error: ${ac.error ?? "n/a"}, skippedReason: ${ac.skippedReason ?? "n/a"})`,
    ac.committed === true,
  );
  if (ac.committed) {
    const author = git(worktreePath, ["log", "-1", "--format=%an <%ae>"]);
    check(`(B) the landed commit's author is the CONFIGURED identity (got "${author}")`, author === "configured-b <configured-b@loom>");
  }
}

// ── (C) GitWriter.checkout() + GitWriter.commit(), WITH a configured identity, under an ambient
//      GIT_ASKPASS — covers resolveOperationalHomeToplevelRefusal's own gate too, since both methods call
//      it before doing any real work. ─────────────────────────────────────────────────────────────────────
{
  console.log("\n— (C) GitWriter.checkout()/commit() with a configured identity + ambient GIT_ASKPASS —");
  const repo = makeRepo("c");
  execFileSync("git", ["config", "user.email", "configured-c@loom"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "configured-c"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "# c\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
  execFileSync("git", ["branch", "gaee-c-side"], { cwd: repo });

  const writer = new GitWriter(repo);

  process.env.GIT_ASKPASS = FAKE_ASKPASS;
  let checkoutRes, commitRes;
  try {
    checkoutRes = await writer.checkout("gaee-c-side");
    fs.writeFileSync(path.join(repo, "feature-c.txt"), `c-content-${sfx}\n`);
    commitRes = await writer.commit("test(git): verify GitWriter commit under ambient GIT_ASKPASS (C)");
  } finally {
    if (savedAskpass === undefined) delete process.env.GIT_ASKPASS; else process.env.GIT_ASKPASS = savedAskpass;
  }

  check(
    `(C) GitWriter.checkout() succeeds under an ambient GIT_ASKPASS (never touches a remote) (error: ${checkoutRes.ok ? "n/a" : checkoutRes.error})`,
    checkoutRes.ok === true,
  );
  check(
    `(C) GitWriter.commit() succeeds under an ambient GIT_ASKPASS (never touches a remote) (error: ${commitRes.ok ? "n/a" : commitRes.error})`,
    commitRes.ok === true,
  );
  if (commitRes.ok) {
    const author = git(repo, ["log", "-1", "--format=%an <%ae>"]);
    check(`(C) the landed commit's author is the CONFIGURED identity (got "${author}")`, author === "configured-c <configured-c@loom>");
  }
}

// ── (D) batch landing (assembleBatchBranches → landBranchCommitsIndividually, git/batch-merge.ts), WITH
//      a configured identity, under each of GIT_ASKPASS / GIT_SSH_COMMAND / GIT_CONFIG_COUNT in turn —
//      git/batch-merge.ts's own `boundedMergeGit` is a SEPARATE site from (A)'s (git/worktrees.ts), never
//      exercised anywhere else in this suite under an ambient transport var. ──────────────────────────────
async function runBatchAskpassScenario(envVarName, envVarValue) {
  console.log(`\n— (D) batch landing (assembleBatchBranches) with a configured identity + ambient ${envVarName} —`);
  const tag = envVarName.toLowerCase().replace(/_/g, "-");
  const repo = makeRepo(`d-${tag}`);
  execFileSync("git", ["config", "user.email", `configured-d-${tag}@loom`], { cwd: repo });
  execFileSync("git", ["config", "user.name", `configured-d-${tag}`], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), `# d-${tag}\n`);
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "init", "--allow-empty"], { cwd: repo });

  const branch = `loom/gaee-d-${tag}`;
  execFileSync("git", ["worktree", "add", "-q", "-b", branch, path.join(os.tmpdir(), `loom-gaee-wt-d-${tag}-${sfx}`), "HEAD"], { cwd: repo });
  const workerWt = path.join(os.tmpdir(), `loom-gaee-wt-d-${tag}-${sfx}`);
  tmpDirs.push(workerWt);
  fs.writeFileSync(path.join(workerWt, `feature-d-${tag}.txt`), `d-${tag}-content-${sfx}\n`);
  execFileSync("git", ["add", "."], { cwd: workerWt });
  execFileSync("git", ["-c", "user.email=worker@loom", "-c", "user.name=worker", "commit", "-q", "-m", `${branch} work`], { cwd: workerWt });

  const batchWt = path.join(os.tmpdir(), `loom-gaee-batch-d-${tag}-${sfx}`);
  tmpDirs.push(batchWt);
  execFileSync("git", ["worktree", "add", "-q", "-b", `loom/gaee-d-${tag}-batch`, batchWt, "HEAD"], { cwd: repo });

  const saved = process.env[envVarName];
  process.env[envVarName] = envVarValue;
  let result;
  try {
    const candidate = { workerSessionId: `gaee-d-${tag}`, taskId: `gaee-d-${tag}-task`, branch, taskTitle: `feat(test): gaee d ${tag}` };
    result = await assembleBatchBranches(repo, batchWt, [candidate]);
  } finally {
    if (saved === undefined) delete process.env[envVarName]; else process.env[envVarName] = saved;
  }

  check(
    `(D) assembleBatchBranches lands the candidate under an ambient ${envVarName} (never touches a remote) (dropped: ${JSON.stringify(result.dropped)})`,
    result.landed.length === 1 && result.dropped.length === 0,
  );
  if (result.landed.length === 1) {
    const author = git(batchWt, ["log", "-1", "--format=%an <%ae>"]);
    check(`(D/${envVarName}) the landed commit's AUTHOR is the worker's own identity (got "${author}")`, author === "worker <worker@loom>");
  }
}

await runBatchAskpassScenario("GIT_ASKPASS", FAKE_ASKPASS);
await runBatchAskpassScenario("GIT_SSH_COMMAND", process.platform === "win32" ? "C:\\fake\\ssh.exe" : "/fake/ssh");
await runBatchAskpassScenario("GIT_CONFIG_COUNT", "0"); // breadth pin (CR 01e61841): not ASKPASS-shaped at all

// ── (E) card 23c74c62: env-less canonicalGit(...).raw(status), under BOTH GIT_ASKPASS AND GIT_CONFIG
//      ambient at once. GIT_CONFIG's own presence forces prepareCanonicalEnv (git/bounded.ts) to
//      MATERIALIZE an explicit env for what would otherwise stay an env-less (no `.env()` call) instance
//      — that materialized copy must still exclude GIT_ASKPASS, or the materialize branch itself
//      re-introduces this card's exact bug on every ambient-GIT_CONFIG host. GIT_CONFIG alone (no
//      GIT_ASKPASS) is already covered by canonical-git-isolation.mjs's own GIT_CONFIG block; this is the
//      combination that card 23c74c62 found broken. ──────────────────────────────────────────────────────
{
  console.log("\n— (E) env-less canonicalGit(...).raw(status) with GIT_ASKPASS + GIT_CONFIG both ambient —");
  const repo = makeRepo("e");
  execFileSync("git", ["config", "user.email", "configured-e@loom"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "configured-e"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "# e\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "init", "--allow-empty"], { cwd: repo });

  const emptyGitConfig = path.join(os.tmpdir(), `loom-gaee-empty-gitconfig-${sfx}`);
  fs.writeFileSync(emptyGitConfig, "");
  tmpDirs.push(emptyGitConfig);

  const savedGitConfig = process.env.GIT_CONFIG;
  process.env.GIT_ASKPASS = FAKE_ASKPASS;
  process.env.GIT_CONFIG = emptyGitConfig;
  let out, err = null;
  try {
    out = await canonicalGit(repo, 15_000).raw(["status"]);
  } catch (e) {
    err = e;
  } finally {
    if (savedAskpass === undefined) delete process.env.GIT_ASKPASS; else process.env.GIT_ASKPASS = savedAskpass;
    if (savedGitConfig === undefined) delete process.env.GIT_CONFIG; else process.env.GIT_CONFIG = savedGitConfig;
  }

  check(
    `(E) an env-less canonicalGit(...).raw(status) succeeds with GIT_ASKPASS + GIT_CONFIG both ambient (error: ${err?.message ?? "n/a"})`,
    err === null,
  );
  check("(E) ...and it genuinely ran (returned real status output)", typeof out === "string" && out.length > 0);
}

// ── (F) card 23c74c62 (round 2): canonicalGit with an EXPLICIT env carrying GIT_CONFIG + GIT_ASKPASS must
//      still REFUSE — an explicit env is the CALLER's own responsibility (every real caller already uses
//      localNonInteractiveEnv()/localReadGitEnv() when it needs transport keys stripped); the narrow fix
//      proven by (E) strips transport keys ONLY when the caller itself passed no env at all. ──────────────
{
  console.log("\n— (F) canonicalGit with an EXPLICIT env (GIT_CONFIG + GIT_ASKPASS) still refuses —");
  const repo = makeRepo("f");
  execFileSync("git", ["config", "user.email", "configured-f@loom"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "configured-f"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "# f\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "init", "--allow-empty"], { cwd: repo });

  const emptyGitConfigF = path.join(os.tmpdir(), `loom-gaee-empty-gitconfig-f-${sfx}`);
  fs.writeFileSync(emptyGitConfigF, "");
  tmpDirs.push(emptyGitConfigF);

  const explicitEnv = { ...process.env, GIT_CONFIG: emptyGitConfigF, GIT_ASKPASS: FAKE_ASKPASS, GIT_TERMINAL_PROMPT: "0" };
  let err = null;
  try {
    await canonicalGit(repo, 15_000, explicitEnv).raw(["status"]);
  } catch (e) {
    err = e;
  }

  check(
    `(F) canonicalGit with an explicit env carrying GIT_CONFIG + GIT_ASKPASS still refuses (error: ${err?.message ?? "n/a"})`,
    err !== null && /GIT_ASKPASS/.test(String(err.message)) && /not permitted|allowUnsafe/i.test(String(err.message)),
  );
}

// ── (G) card 23c74c62 (round 2): the RAW-SPAWN path (killableCanonicalRaw -> spawnCanonicalGitTree ->
//      rawViaDirectSpawn/rawViaWinJobLauncher) must stay BYTE-IDENTICAL to pre-card behaviour: under the
//      SAME GIT_CONFIG + GIT_ASKPASS ambient combination (E) fixes for canonicalGit, a raw-spawn child must
//      still actually RECEIVE GIT_ASKPASS in its own env — this path never touches simple-git's
//      blockUnsafeOperationsPlugin at all, and may legitimately need the transport family for an implicit
//      fetch (an LFS smudge filter, a partial-clone promisor fetch) during a canonical mutation. Proven by
//      a `-c alias` that shells out to a tiny probe script and writes what it actually saw to a marker file
//      — the most direct way to observe the CHILD's own env without relying on git itself ever invoking
//      GIT_ASKPASS for real (these local-only ops never do). ──────────────────────────────────────────────
{
  console.log("\n— (G) raw-spawn path (killableCanonicalRaw) still receives GIT_ASKPASS with GIT_CONFIG + GIT_ASKPASS ambient —");
  const repo = makeRepo("g");
  execFileSync("git", ["config", "user.email", "configured-g@loom"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "configured-g"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "# g\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "init", "--allow-empty"], { cwd: repo });

  const emptyGitConfigG = path.join(os.tmpdir(), `loom-gaee-empty-gitconfig-g-${sfx}`);
  fs.writeFileSync(emptyGitConfigG, "");
  tmpDirs.push(emptyGitConfigG);

  const probeMarker = path.join(os.tmpdir(), `loom-gaee-askpass-probe-marker-${sfx}.txt`);
  const probeScript = path.join(os.tmpdir(), `loom-gaee-askpass-probe-${sfx}.mjs`);
  // forward-slashed for the alias string below — avoids any POSIX-shell backslash-escaping hazard inside
  // the sh -c command git-for-windows' own "!"-prefixed alias execution runs; node accepts "/" on win32 too.
  const probeScriptForShell = probeScript.replace(/\\/g, "/");
  fs.writeFileSync(probeScript, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(probeMarker)}, process.env.GIT_ASKPASS ?? "<unset>");\n`);
  tmpDirs.push(probeScript, probeMarker);

  const savedGitConfigG = process.env.GIT_CONFIG;
  process.env.GIT_ASKPASS = FAKE_ASKPASS;
  process.env.GIT_CONFIG = emptyGitConfigG;
  let err = null;
  try {
    await killableCanonicalRaw(repo, ["-c", `alias.gaee-askpass-probe=!node "${probeScriptForShell}"`, "gaee-askpass-probe"], 15_000, "test(git): verify GIT_ASKPASS reaches the raw-spawn child (G)");
  } catch (e) {
    err = e;
  } finally {
    if (savedAskpass === undefined) delete process.env.GIT_ASKPASS; else process.env.GIT_ASKPASS = savedAskpass;
    if (savedGitConfigG === undefined) delete process.env.GIT_CONFIG; else process.env.GIT_CONFIG = savedGitConfigG;
  }

  check(`(G) killableCanonicalRaw's alias probe ran without error (error: ${err?.message ?? "n/a"})`, err === null);
  const seen = fs.existsSync(probeMarker) ? fs.readFileSync(probeMarker, "utf8") : "<marker missing>";
  check(`(G) the raw-spawn CHILD's own env still carried GIT_ASKPASS (saw "${seen}")`, seen === FAKE_ASKPASS);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — local-only canonical git ops succeed under an ambient GIT_ASKPASS."
  : `\n❌ ${failures} FAILURE(S).`);

for (const d of tmpDirs) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
}

process.exit(failures === 0 ? 0 : 1);
