import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card cf9a32cf (round 3 of 5b50eede) — `canonicalGit`/`boundedSimpleGit` (git/bounded.ts) still handed
// simple-git a bare "git" even after 5b50eede/round-2 made the win-job-launcher and its direct-spawn
// fallback resolve git to an absolute path — the SAME Windows cwd/relative-PATH-entry hijack surface those
// rounds closed stays open for every NON-killable canonical simple-git call (status/rev-parse/branch
// reads through `canonicalGit(...).raw(...)`, not `spawnCanonicalGitTree`). Full mechanism, round 3:
// docs/decisions/5b50eede-absolute-git-path.md.
//
// WINDOWS-ONLY for the hijack-resistance half (sections 1-2); sections 3-5 run on every platform,
// mirroring canonical-git-isolation.mjs's own win32/POSIX split for the GIT_CONFIG casing test.
//
// Section 1 asserts the CONFIGURED binary directly, via the same internal plugin hook
// `GitExecutorChain.attemptRemoteTask` itself reads before every real spawn
// (`git._executor._plugins.exec("spawn.binary", "", {...})`, verified against the live
// node_modules/simple-git source) — never merely that a `raw()` call succeeded. A resilient fallback
// (or, as round 1 of 5b50eede found, a planted cwd git.exe that this specific host/Node build simply
// doesn't resolve ahead of PATH) would make an end-to-end-only assertion pass even against unfixed code,
// exactly the trap win-job-launcher-absolute-git-path.mjs's own header documents avoiding. Section 2 is
// deliberately a BEHAVIOURAL SMOKE CHECK on top of section 1's direct proof, NOT independent RED evidence
// on its own — this host/Node build does not reproduce the cwd-planted hijack even pre-fix (see section
// 2's own comment), so section 2 passing says "still works end-to-end," never "resists the hijack."
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempManaged } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) { failures++; if (detail) console.log(`   ${detail}`); }
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const boundedModuleUrl = pathToFileURL(path.join(distGitDir, "bounded.js")).href;
const { canonicalGit, boundedSimpleGit, resolveAbsoluteGitExePath, isAbsoluteWindowsExePath } = await import(boundedModuleUrl);

function mkRepo(prefix) {
  const repo = mkdtempManaged(prefix);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "cf9a32cf@loom"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "cf9a32cf"], { cwd: repo });
  return repo;
}

/** Reads back the binary simple-git is actually configured to spawn, via the SAME internal hook the
 *  library's own executor calls before every real spawn — no process is launched to find out. */
function configuredBinary(git) {
  return git._executor._plugins.exec("spawn.binary", "", { method: "", commands: [] });
}

if (process.platform !== "win32") {
  console.log("SKIP  (sections 1-2, win32-only) canonical-git-absolute-binary — hijack-resistance assertions need a real win32 git.exe resolution; this host is '" + process.platform + "'.");
} else {
  const GIT_EXE = resolveAbsoluteGitExePath();
  if (!GIT_EXE) {
    console.log("SKIP  (sections 1-2) canonical-git-absolute-binary — could not resolve an absolute git.exe on PATH.");
  } else {
    check("(0) positive control: resolveAbsoluteGitExePath() returns a value isAbsoluteWindowsExePath accepts", isAbsoluteWindowsExePath(GIT_EXE), GIT_EXE);

    // --- 1. canonicalGit's non-killable simple-git calls are configured with the RESOLVED ABSOLUTE
    // git.exe, never the bare "git" PATH lookup — this is the exact asymmetry the card closes.
    {
      const repo = mkRepo("loom-cf9a32cf-canonicalgit-");
      const git = canonicalGit(repo, 10_000);
      const binary = configuredBinary(git);
      check("(1) canonicalGit configures simple-git with the resolved absolute git.exe, not bare \"git\"", binary === GIT_EXE, `got=${JSON.stringify(binary)}`);
      check("(1) …and that configured value is itself drive/UNC-absolute (never a relative hit)", isAbsoluteWindowsExePath(binary));
    }

    // --- 2. End-to-end: a REAL raw() call through canonicalGit, with a planted junk "git.exe" sitting in
    // the repo's own cwd, still runs the REAL git (round 1 of 5b50eede found this specific cwd-planting
    // case did not reproduce a hijack on that host/Node build even pre-fix — see this card's own
    // worker_report for the direct re-check on THIS host — so this is an end-to-end regression/behavioral
    // guard alongside section 1's direct configured-value proof, not an independent hijack reproduction).
    {
      const repo = mkRepo("loom-cf9a32cf-e2e-");
      fs.writeFileSync(path.join(repo, "git.exe"), "not a real executable — canonical-git-absolute-binary.mjs\n");
      const git = canonicalGit(repo, 10_000);
      let threw = null, out = "";
      try { out = await git.raw(["rev-parse", "--show-toplevel"]); } catch (e) { threw = e; }
      check("(2) a real canonicalGit raw() call succeeds with junk \"git.exe\" planted in the repo cwd", threw === null, threw?.message);
      if (threw === null) {
        const normalizedRepo = repo.replace(/\\/g, "/");
        check("(2) …and resolves to the real repo (not a result from the planted junk)", out.trim().toLowerCase() === normalizedRepo.toLowerCase(), `got=${JSON.stringify(out.trim())} want=${JSON.stringify(normalizedRepo)}`);
      }
    }
  }
}

// --- 3. POSIX / unresolved-git byte-identical: boundedSimpleGit without a `binary` override is
// configured with simple-git's own default "git" literal — on EVERY platform (runs regardless of host).
{
  const repo = mkRepo("loom-cf9a32cf-default-");
  const git = boundedSimpleGit(repo, 10_000);
  const binary = configuredBinary(git);
  check("(3) boundedSimpleGit with no `binary` override stays simple-git's own default \"git\" (byte-identical)", binary === "git", `got=${JSON.stringify(binary)}`);
}

// --- 4. canonicalGit's OWN non-win32 branch, not just boundedSimpleGit's — real on a non-win32 host
// (notably Linux CI, where this actually exercises the production code path and would catch a
// regression in canonicalGit's platform check), skipped on win32 (this dev host): there is no
// platform-override seam in bounded.ts to flip `process.platform` without changing production code
// purely for testability, and the win32 branch is already covered directly by section 1 above.
if (process.platform === "win32") {
  console.log("SKIP  (4, non-win32-only) canonicalGit's own POSIX branch — this host is win32 (section 1 above already covers the win32 branch directly; no platform-override seam exists to flip it here).");
} else {
  const repo = mkRepo("loom-cf9a32cf-posix-canonicalgit-");
  const git = canonicalGit(repo, 10_000);
  const binary = configuredBinary(git);
  check("(4) canonicalGit on a non-win32 host stays simple-git's own default \"git\" (never attempts an absolute resolution)", binary === "git", `got=${JSON.stringify(binary)}`);
}

// --- 5. isAbsoluteWindowsExePath / resolveAbsoluteGitExePath are REUSED verbatim, never re-implemented —
// a real source-text check (not a vacuous `typeof === "function"`, which would pass just as happily
// against a SECOND, differently-named-but-also-exported resolver): exactly one `function
// resolveAbsoluteGitExePath` declaration exists anywhere under src/git. Runs on every platform (reads
// TypeScript source text, not compiled output, so no build/host dependency).
{
  const srcGitDir = path.join(__dirname, "..", "src", "git");
  const tsFiles = fs.readdirSync(srcGitDir).filter((f) => f.endsWith(".ts"));
  let declCount = 0;
  const decls = [];
  for (const f of tsFiles) {
    const text = fs.readFileSync(path.join(srcGitDir, f), "utf8");
    const matches = text.match(/\bfunction\s+resolveAbsoluteGitExePath\b/g) ?? [];
    if (matches.length > 0) decls.push(`${f}:${matches.length}`);
    declCount += matches.length;
  }
  check("(5) positive control: the source scan itself found at least one *.ts file under src/git", tsFiles.length > 0, `tsFiles=${tsFiles.length}`);
  check("(5) exactly ONE `function resolveAbsoluteGitExePath` declaration exists under src/git (no second resolver)", declCount === 1, `found ${declCount} across [${decls.join(", ")}]`);
}

console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
