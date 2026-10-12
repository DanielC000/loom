import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 5b50eede — the launcher refuses a non-absolute git path, and a git.exe PLANTED in the launcher's
// own directory (the genuinely NEW hijack surface CreateProcessW's bare-name search adds over Node's own
// bare spawn("git")) is never the one run once an absolute path is passed. Full mechanism:
// docs/decisions/5b50eede-absolute-git-path.md.
//
// WINDOWS-ONLY, requires build:native. NEVER touches the real packages/daemon/assets/native/
// win-job-launcher.exe — every scenario drives a COPY of it in an isolated scratch dir, exactly the
// posture docs/decisions/1718416d-*.md's "Do not" section requires.
//
// This file drives the REAL win-job-launcher.exe DIRECTLY (its own argv, like win-job-launcher-fidelity.mjs
// does) rather than through `killableCanonicalRaw` — bounded.ts's resilient per-call fallback to direct-
// spawn on ANY launcher refusal means a launcher-level hijack can be invisible from that higher level (a
// refused call just silently succeeds via the fallback): an earlier draft of this test asserted only
// end-to-end success through `killableCanonicalRaw` and passed even against the UNFIXED launcher, because
// the fallback masked the refusal. Driving the launcher directly and asserting its OWN exit code is what
// actually exercises the defect this card closes.
//
// MANUAL RED-PROOF PERFORMED BEFORE WRITING THIS FILE (not re-run automatically — it needs a source
// revert + two rebuilds, the documented negative-control cycle): reverted bounded.ts + launcher.cs to
// HEAD, rebuilt (build:native + tsc), and drove the UNFIXED launcher directly with a `git.exe` planted
// ONLY beside the launcher's own copy (its "own directory") — it returned 0x4C4F0003 (EXIT_REFUSED),
// i.e. CreateProcessW's bare "git.exe" search found and tried to execute the planted junk file instead of
// real git. The SAME setup with a `git.exe` planted ONLY in the cwd did NOT reproduce on this host/Node
// build — both the unfixed launcher and Node's own bare `spawn("git", ..., {cwd})` resolved the REAL git
// via PATH, never the cwd-planted file. That does not mean the cwd risk is imaginary (CreateProcessW's
// own documented search order, and libuv's own `search_path()`, both name cwd as a checked location) —
// only that it did not reproduce HERE, on this specific host/Node/Windows build, unlike the launcher's-
// own-directory case which reproduced cleanly and reliably. Restored the fix and rebuilt before writing
// the assertions below. See the card's own `worker_report` for the full writeup.
//
// ROUND 2 (CR 792785cb): a MAJOR was found AFTER the above — `resolveExecutable()` (the generic resolver
// round 1 reused) does not require a PATH entry to be absolute. A relative entry ("bin", ".", or a
// current-drive-relative "\tools") still resolved via `fs.existsSync` and was returned as a RELATIVE
// string, which round 1's TS-side filter (`!== "git"` + `.exe$`) happily accepted — and round 1's OWN
// direct-spawn fallback then spawned that relative string with `cwd: repoPath`, i.e. a REPO-RELATIVE git:
// a NEW hijack this file's round-1 assertions never covered. Section 4 below tests the dedicated walker
// (`resolveAbsoluteGitExePath`/`isAbsoluteWindowsExePath`, bounded.ts) that replaced it directly.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempManaged } from "./_tmp-fixture.mjs";

if (process.platform !== "win32") {
  console.log("SKIP  win-job-launcher-absolute-git-path — win32-only (this host is '" + process.platform + "').");
  process.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_EXE = path.join(__dirname, "..", "assets", "native", "win-job-launcher.exe");
if (!fs.existsSync(REAL_EXE)) {
  console.log("SKIP  win-job-launcher-absolute-git-path — win-job-launcher.exe not built. Run `pnpm --filter @loom/daemon build:native` first.");
  process.exit(0);
}

const distGitDir = path.join(__dirname, "..", "dist", "git");
const {
  killableCanonicalRaw, setWinJobLauncherOverrideForTest, LAUNCHER_EXIT_REFUSED,
  resolveAbsoluteGitExePath, isAbsoluteWindowsExePath,
} = await import(pathToFileURL(path.join(distGitDir, "bounded.js")).href);

// Card 5b50eede round 2: uses the SAME dedicated resolver production uses (never resolveExecutable,
// which this card's own fix stopped relying on — see section 4 below for why).
const GIT_EXE = resolveAbsoluteGitExePath();
if (!GIT_EXE) {
  console.log("SKIP  win-job-launcher-absolute-git-path — could not resolve an absolute git.exe on PATH.");
  process.exit(0);
}

// The real exe is NEVER touched by this file — assert it, not just assume it (same discipline as
// win-job-launcher-fallback.mjs).
const realExeHashAtStart = crypto.createHash("sha256").update(fs.readFileSync(REAL_EXE)).digest("hex");

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) { failures++; if (detail) console.log(`   ${detail}`); }
};

function runLauncher(exe, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { cwd, windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** A non-executable placeholder named exactly "git.exe" — CreateProcessW's own bare-name search would
 *  find THIS first (pre-fix, in the launcher's own directory — see the manual RED-proof above); it never
 *  needs to actually run anything, since finding it at all (even failing to execute it) is the defect. */
function plantFakeGit(dir) {
  fs.writeFileSync(path.join(dir, "git.exe"), "not a real executable — win-job-launcher-absolute-git-path.mjs\n");
}

function copyLauncherTo(dir) {
  const dest = path.join(dir, "win-job-launcher.exe");
  fs.copyFileSync(REAL_EXE, dest);
  return dest;
}

async function run() {
  // --- 1. The refusal contract, deterministic and environment-independent: a non-absolute git path (or
  // the entirely OLD argv shape, pre-dating the gitPath slot) must refuse via the EXISTING reserved
  // EXIT_REFUSED code — never git's own exit-code range, so the per-call fallback still recognizes it.
  {
    const cwd = mkdtempManaged("loom-wjl-abspath-refuse-bare-");
    const nonce = crypto.randomBytes(16).toString("hex");
    const r = await runLauncher(REAL_EXE, ["run", nonce, "git.exe", "--version"], cwd);
    check("a bare (non-absolute) git.exe argv value is REFUSED, not run", r.code === LAUNCHER_EXIT_REFUSED, `code=${r.code}`);
  }
  {
    const cwd = mkdtempManaged("loom-wjl-abspath-refuse-oldshape-");
    const nonce = crypto.randomBytes(16).toString("hex");
    // The pre-card argv shape entirely (no gitPath slot at all) — "--version" lands in the gitPath slot.
    const r = await runLauncher(REAL_EXE, ["run", nonce, "--version"], cwd);
    check("the old (pre-card) argv shape with no gitPath slot is REFUSED, not run", r.code === LAUNCHER_EXIT_REFUSED, `code=${r.code}`);
  }
  {
    const cwd = mkdtempManaged("loom-wjl-abspath-refuse-reldrive-");
    const nonce = crypto.randomBytes(16).toString("hex");
    // A current-drive-relative path ("\foo") is `Path.IsPathRooted`-true but NOT actually absolute — the
    // launcher must reject this shape specifically, not just an unrooted bare name.
    const r = await runLauncher(REAL_EXE, ["run", nonce, "\\not-a-real-absolute-path\\git.exe", "--version"], cwd);
    check("a current-drive-relative path (\\foo, NOT drive/UNC-absolute) is REFUSED, not run", r.code === LAUNCHER_EXIT_REFUSED, `code=${r.code}`);
  }

  // --- 2. Real, end-to-end hijack resistance: the launcher's OWN directory holds a planted junk
  // "git.exe" (the confirmed, reproducible pre-fix hijack site), the repo cwd holds one too (the card's
  // own literal DoD wording — "planted in the cwd AND in the launcher's directory"), and the launcher is
  // still handed the REAL resolved absolute path. It must run the REAL git regardless of either planted
  // file, proven via `--version` AND a real commit round-tripped through `git log`.
  {
    const launcherDir = mkdtempManaged("loom-wjl-abspath-launcherdir-");
    const launcherCopy = copyLauncherTo(launcherDir);
    plantFakeGit(launcherDir);
    const repo = mkdtempManaged("loom-wjl-abspath-repo-");
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "wjl@loom"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "wjl"], { cwd: repo });
    plantFakeGit(repo);

    const nonce1 = crypto.randomBytes(16).toString("hex");
    const rVersion = await runLauncher(launcherCopy, ["run", nonce1, GIT_EXE, "--version"], repo);
    check("junk planted in BOTH the launcher's own dir AND cwd: `git --version` still runs the REAL git",
      rVersion.code === 0 && /^git version /.test(rVersion.stdout), JSON.stringify(rVersion));

    const nonce2 = crypto.randomBytes(16).toString("hex");
    const msg = "absolute-git-path real-commit case";
    const rCommit = await runLauncher(launcherCopy, ["run", nonce2, GIT_EXE, "commit", "--allow-empty", "-m", msg], repo);
    check("junk planted in BOTH locations: a real commit via the launcher still exits 0", rCommit.code === 0, JSON.stringify(rCommit));
    if (rCommit.code === 0) {
      const logged = execFileSync("git", ["log", "-1", "--format=%s"], { cwd: repo, encoding: "utf8" }).trim();
      check("junk planted in BOTH locations: the commit landed with the EXACT intended message", logged === msg, `got=${JSON.stringify(logged)}`);
    }
  }

  // --- 3. The direct-spawn fallback (card 5b50eede, point 3) is hardened the same way — end-to-end via
  // the real `killableCanonicalRaw` API, forcing the fallback with `setWinJobLauncherOverrideForTest(null)`.
  // (This host's Node build did not reproduce the cwd-planting hazard pre-fix either — see the file header
  // — so this is a behavioral-equivalence/regression guard, not an independent security RED/GREEN proof.)
  {
    setWinJobLauncherOverrideForTest(null);
    try {
      const repo = mkdtempManaged("loom-wjl-abspath-directspawn-repo-");
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["config", "user.email", "wjl@loom"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "wjl"], { cwd: repo });
      plantFakeGit(repo);
      const msg = "absolute-git-path direct-spawn fallback case";
      let threw = null;
      try {
        await killableCanonicalRaw(repo, ["commit", "--allow-empty", "-m", msg], 10000, "wjl-abspath-directspawn");
      } catch (e) { threw = e; }
      check("direct-spawn fallback, junk planted in cwd: the call resolved (no error)", threw === null, threw?.message);
      if (threw === null) {
        const logged = execFileSync("git", ["log", "-1", "--format=%s"], { cwd: repo, encoding: "utf8" }).trim();
        check("direct-spawn fallback, junk planted in cwd: the commit landed with the EXACT intended message", logged === msg, `got=${JSON.stringify(logged)}`);
      }
    } finally {
      setWinJobLauncherOverrideForTest(undefined);
    }
  }

  // --- 4. The dedicated git-exe PATH walker itself (card 5b50eede round 2, CR 792785cb) — unit-level,
  // no launcher/real-spawn involved. `isAbsoluteWindowsExePath` first, directly:
  check("isAbsoluteWindowsExePath: drive-rooted is absolute", isAbsoluteWindowsExePath("C:\\Program Files\\Git\\bin"));
  check("isAbsoluteWindowsExePath: UNC is absolute", isAbsoluteWindowsExePath("\\\\server\\share\\git\\bin"));
  check("isAbsoluteWindowsExePath: a bare relative entry is NOT absolute", !isAbsoluteWindowsExePath("bin"));
  check("isAbsoluteWindowsExePath: \".\" is NOT absolute", !isAbsoluteWindowsExePath("."));
  check("isAbsoluteWindowsExePath: a current-drive-relative \"\\tools\" is NOT absolute (the exact .NET Path.IsPathRooted gotcha)", !isAbsoluteWindowsExePath("\\tools"));

  // A relative PATH entry whose own fs.existsSync hit is REAL (the exact pre-round-2 bug: resolveExecutable
  // happily returned this as "resolved") must still be SKIPPED by resolveAbsoluteGitExePath — chdir is
  // required since a relative entry is only ever meaningful relative to the calling process's cwd; scoped
  // tightly (no `await` between chdir and restore) so no concurrent code in this process observes it.
  {
    const relRoot = mkdtempManaged("loom-wjl-abspath-relpath-");
    fs.mkdirSync(path.join(relRoot, "bin"));
    fs.writeFileSync(path.join(relRoot, "bin", "git.exe"), "planted — relative PATH entry hijack probe\n");
    const plantedExists = fs.existsSync(path.join(relRoot, "bin", "git.exe"));
    check("positive control: the planted relative git.exe genuinely exists (proves the skip below isn't vacuous)", plantedExists);

    const originalCwd = process.cwd();
    process.chdir(relRoot);
    let result;
    try {
      result = resolveAbsoluteGitExePath("bin");
    } finally {
      process.chdir(originalCwd);
    }
    check("a RELATIVE PATH entry (\"bin\") with a REAL matching git.exe is SKIPPED, not returned", result === null, `got=${JSON.stringify(result)}`);
  }
  {
    const dotRoot = mkdtempManaged("loom-wjl-abspath-dotpath-");
    fs.writeFileSync(path.join(dotRoot, "git.exe"), "planted — \".\" PATH entry hijack probe\n");
    const originalCwd = process.cwd();
    process.chdir(dotRoot);
    let result;
    try {
      result = resolveAbsoluteGitExePath(".");
    } finally {
      process.chdir(originalCwd);
    }
    check("a \".\" PATH entry with a REAL matching git.exe is SKIPPED, not returned", result === null, `got=${JSON.stringify(result)}`);
  }
  {
    // No real file is planted on the system drive for this one (writing outside the repo/temp area is
    // out of scope) — this instead proves the SKIP decision itself never even reaches fs.existsSync for
    // this shape, combined with the direct predicate unit check above.
    const result = resolveAbsoluteGitExePath("\\tools-definitely-does-not-exist-5b50eede");
    check("a current-drive-relative PATH entry alone resolves to null without erroring", result === null, `got=${JSON.stringify(result)}`);
  }
  {
    // A git.cmd earlier on PATH must never mask a real git.exe later — the walker tests ONLY "git.exe"
    // per directory, never falling through to a .cmd/.bat the way resolveExecutable's PATHEXT order would.
    const cmdOnlyDir = mkdtempManaged("loom-wjl-abspath-cmdonly-");
    fs.writeFileSync(path.join(cmdOnlyDir, "git.cmd"), "@echo off\r\necho planted git.cmd — should never be resolved\r\n");
    const realExeDir = mkdtempManaged("loom-wjl-abspath-realexe-");
    fs.writeFileSync(path.join(realExeDir, "git.exe"), "planted — the ONLY valid candidate in this PATH\n");
    const result = resolveAbsoluteGitExePath(`${cmdOnlyDir};${realExeDir}`);
    check("a git.cmd-before-git.exe PATH resolves the LATER .exe, never the earlier .cmd",
      result === path.join(realExeDir, "git.exe"), `got=${JSON.stringify(result)}`);
  }

  const realExeHashAtEnd = crypto.createHash("sha256").update(fs.readFileSync(REAL_EXE)).digest("hex");
  check("the real win-job-launcher.exe's content hash is UNCHANGED (this test never touched the real file)", realExeHashAtEnd === realExeHashAtStart);

  console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

run();
