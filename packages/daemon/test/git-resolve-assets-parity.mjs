import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below
// PARITY GUARD (card 61d0c029) — packages/daemon/assets/git-resolve.mjs is a STANDALONE, duplicated-not-
// imported copy of the win32 absolute-git-path resolver in packages/daemon/src/git/bounded.ts (the two
// shipped session hooks under packages/daemon/assets/ cannot import the daemon's dist, so the resolver
// logic has to be available to them as a plain .mjs module — see that file's own header). A duplicated
// copy drifts silently the moment either side changes without the other; this test asserts the two stay
// behaviorally identical across a fixed set of real-fs scenarios, so a future edit to bounded.ts's
// resolver (or to the assets copy) that breaks parity fails HERE, not in production on a live hook run.
//
// Compares `isAbsoluteWindowsExePath`/`resolveAbsoluteGitExePath` (both accept the same optional
// `pathOverride` argument, so this runs identically regardless of host platform — the function itself
// never reads `process.platform`) across a shared set of synthetic PATH scenarios built from real
// temp-dir fixtures (a drive/UNC-absolute dir WITH a planted git.exe, one WITHOUT, and a relative entry
// that must be skipped outright per @decision 5b50eede). `resolveWin32GitBinary`/`resolveGitBinaryForSpawn`
// DO read `process.platform` and the REAL `process.env.PATH` with no override — those are compared
// directly against each other on THIS host's real environment, since both modules observe the identical
// env and must therefore agree.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempManaged } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) { failures++; if (detail !== undefined) console.log(`   ${detail}`); }
};

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const assetsModuleUrl = pathToFileURL(path.join(TEST_DIR, "..", "assets", "git-resolve.mjs")).href;
const distGitDir = path.join(TEST_DIR, "..", "dist", "git");
const boundedModuleUrl = pathToFileURL(path.join(distGitDir, "bounded.js")).href;

const assetsMod = await import(assetsModuleUrl);
const distMod = await import(boundedModuleUrl);

check("(setup) assets/git-resolve.mjs exports isAbsoluteWindowsExePath/resolveAbsoluteGitExePath/resolveWin32GitBinary/resolveGitBinaryForSpawn",
  typeof assetsMod.isAbsoluteWindowsExePath === "function"
  && typeof assetsMod.resolveAbsoluteGitExePath === "function"
  && typeof assetsMod.resolveWin32GitBinary === "function"
  && typeof assetsMod.resolveGitBinaryForSpawn === "function");
check("(setup) dist/git/bounded.js exports the SAME four names",
  typeof distMod.isAbsoluteWindowsExePath === "function"
  && typeof distMod.resolveAbsoluteGitExePath === "function"
  && typeof distMod.resolveWin32GitBinary === "function"
  && typeof distMod.resolveGitBinaryForSpawn === "function");

// ── 1. isAbsoluteWindowsExePath — a fixed set of inputs, both TRUE and FALSE cases, run through both
// modules and compared pairwise.
const ABSOLUTE_PATH_CASES = [
  "C:\\Program Files\\Git\\bin",
  "c:/git/bin",
  "\\\\server\\share\\git",
  "//server/share/git",
  "D:\\",
  "git\\bin",            // relative — FALSE
  "\\relative\\to\\drive", // current-drive-relative — FALSE (never path.isAbsolute's own answer)
  "",                     // empty — FALSE
  "C",                    // too short — FALSE
];
for (const p of ABSOLUTE_PATH_CASES) {
  const a = assetsMod.isAbsoluteWindowsExePath(p);
  const d = distMod.isAbsoluteWindowsExePath(p);
  check(`(1) isAbsoluteWindowsExePath(${JSON.stringify(p)}) agrees: assets=${a} dist=${d}`, a === d);
}
// Positive control: at least one TRUE and one FALSE case exist in the population above, so a check that
// always returns the same constant on both sides would still be caught by SOME disagreement if the two
// implementations ever genuinely diverged on sign.
check("(1) positive control: the case list itself contains both a TRUE and a FALSE case",
  ABSOLUTE_PATH_CASES.some((p) => assetsMod.isAbsoluteWindowsExePath(p)) && ABSOLUTE_PATH_CASES.some((p) => !assetsMod.isAbsoluteWindowsExePath(p)));

// ── 2. resolveAbsoluteGitExePath(pathOverride) — real-fs fixtures: an absolute dir WITH a planted
// git.exe, an absolute dir WITHOUT one, and a relative entry that must be skipped outright (round 2,
// @decision 5b50eede) rather than resolving to a repo-reachable relative spawn target.
{
  const dirWithGit = mkdtempManaged("loom-61d0c029-withgit-");
  fs.writeFileSync(path.join(dirWithGit, "git.exe"), "not a real executable — git-resolve-assets-parity.mjs\n");
  const dirWithoutGit = mkdtempManaged("loom-61d0c029-nogit-");

  const scenarios = [
    { label: "relative entry only (must be SKIPPED, never resolved)", override: "bin;..\\relative\\git\\bin" },
    { label: "absolute entry with no git.exe, then nothing", override: dirWithoutGit },
    { label: "absolute entry with a real git.exe", override: `${dirWithoutGit};${dirWithGit}` },
    { label: "relative entry BEFORE a real absolute hit (relative must not shadow the real hit)", override: `relative\\only;${dirWithGit}` },
    { label: "empty PATH", override: "" },
  ];
  for (const { label, override } of scenarios) {
    const a = assetsMod.resolveAbsoluteGitExePath(override);
    const d = distMod.resolveAbsoluteGitExePath(override);
    check(`(2) resolveAbsoluteGitExePath agrees for: ${label}`, a === d, `assets=${JSON.stringify(a)} dist=${JSON.stringify(d)}`);
  }
  // Positive control: the "real git.exe" scenario must actually resolve to the planted path on BOTH
  // sides — proving this isn't vacuously passing because both sides always return null.
  const resolvedBoth = assetsMod.resolveAbsoluteGitExePath(`${dirWithoutGit};${dirWithGit}`);
  check("(2) positive control: the planted git.exe scenario actually resolves (not vacuously null on both sides)",
    resolvedBoth !== null && path.resolve(resolvedBoth) === path.resolve(path.join(dirWithGit, "git.exe")));
}

// ── 3. resolveWin32GitBinary() / resolveGitBinaryForSpawn() — no override; both modules read the SAME
// real process.platform and process.env.PATH, so they must agree on THIS host's real environment.
{
  const aWin32 = assetsMod.resolveWin32GitBinary();
  const dWin32 = distMod.resolveWin32GitBinary();
  check(`(3) resolveWin32GitBinary() agrees on this host (platform=${process.platform})`, aWin32 === dWin32, `assets=${JSON.stringify(aWin32)} dist=${JSON.stringify(dWin32)}`);

  const aSpawn = assetsMod.resolveGitBinaryForSpawn();
  const dSpawn = distMod.resolveGitBinaryForSpawn();
  check(`(3) resolveGitBinaryForSpawn() agrees on this host`, aSpawn === dSpawn, `assets=${JSON.stringify(aSpawn)} dist=${JSON.stringify(dSpawn)}`);
  check("(3) resolveGitBinaryForSpawn() never returns an empty/falsy value", typeof aSpawn === "string" && aSpawn.length > 0, `assets=${JSON.stringify(aSpawn)}`);

  if (process.platform !== "win32") {
    check("(3) on non-win32, both resolveWin32GitBinary() are undefined", aWin32 === undefined && dWin32 === undefined);
    check("(3) on non-win32, both resolveGitBinaryForSpawn() are the bare \"git\" literal", aSpawn === "git" && dSpawn === "git");
  }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
