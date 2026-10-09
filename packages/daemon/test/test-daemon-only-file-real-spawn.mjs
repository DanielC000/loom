// Card cee17efe (LEAD round-2 ruling, item 1, CRITICAL): the dist-importer check's own gate command
// embeds a `--only=<names>` selection built from a direct-importer scan — for the two historical
// incident commits (service.ts/host.ts) that list alone measured ~13-16K chars. `gate-runner.ts` spawns
// every gate command with `shell:true`, and on win32 that is cmd.exe, whose command-line-length ceiling
// is ~8191 chars — well under that measured size. This is a REAL spawn test (per the LEAD's own
// instruction: "a stubbed runGate is not enough") proving two things against the REAL
// `scripts/test-daemon.mjs`, never a mock: (1) an inline `--only=` selection that long genuinely fails
// at the OS/shell layer on win32 (the RED this card's own incident would have produced without the fix),
// and (2) the SAME selection, delivered via `--only-file=` instead, reaches this script's own in-process
// argument handling regardless of size — the fix.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempManaged } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const testFileDir = path.dirname(fileURLToPath(import.meta.url));
const daemonPkgDir = path.join(testFileDir, "..");
const scriptPath = path.join(daemonPkgDir, "scripts", "test-daemon.mjs");
const repoRoot = path.join(daemonPkgDir, "..", "..");

// A deliberately bogus (never a real discovered test) but plausible-shaped name list, long enough to
// exceed cmd.exe's ~8191-char ceiling by a wide margin regardless of exactly how it's split — this is
// about COMMAND-LINE LENGTH, not about selecting a real test, so the names never need to resolve.
const PADDING_NAMES = Array.from({ length: 1200 }, (_, i) => `cee17efe-padding-name-${i}`);
const PADDING_LIST = PADDING_NAMES.join(",");
check("[setup] the padding --only= value alone exceeds 8191 chars (the actual hazard this test proves)", PADDING_LIST.length > 8191);

function runSpawn(commandSuffix) {
  return new Promise((resolve) => {
    const command = `node ${JSON.stringify(scriptPath)} ${commandSuffix}`;
    let spawnError = null;
    let child;
    try {
      // Mirrors gate-runner.ts's own real gate-command spawn EXACTLY (shell:true, same stdio shape) —
      // the point of this test is that THIS spawn call is where the hazard actually lives.
      child = spawn(command, { cwd: daemonPkgDir, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ spawnThrew: true, spawnError: err, code: null, out: "", err: "" });
      return;
    }
    let out = "";
    let errOut = "";
    child.stdout?.on("data", (d) => { out += d; });
    child.stderr?.on("data", (d) => { errOut += d; });
    child.on("error", (err) => { spawnError = err; });
    child.on("close", (code) => resolve({ spawnThrew: false, spawnError, code, out, err: errOut }));
  });
}

const isWindows = process.platform === "win32";

const run = async () => {
  // (1) RED, win32-only: the inline --only= form hits the real OS command-line-length ceiling. This
  // assertion is platform-gated (not skipped-as-failed) because the ~8191-char limit is cmd.exe's own —
  // a POSIX shell's ARG_MAX is typically far larger, so the SAME padding list would not reproduce the
  // hazard there; the fix (--only-file=) is what's actually platform-independent, and is asserted below
  // on every platform.
  if (isWindows) {
    const inlineResult = await runSpawn(`--only=${PADDING_LIST}`);
    const looksLikeCommandLineFailure =
      inlineResult.spawnThrew ||
      (inlineResult.spawnError != null) ||
      // A genuinely-started cmd.exe that itself refuses an overlong command line exits non-zero with
      // no captured stdout from our own script at all (it never got far enough to print anything) —
      // distinguished from a real in-process refusal, which always prints our own "❌ test-daemon.mjs:"
      // prefix to stderr (see the --only-file= assertion below for that shape).
      (inlineResult.code !== 0 && !inlineResult.out.includes("test-daemon.mjs") && !inlineResult.err.includes("test-daemon.mjs"));
    check(
      "[positive control, win32] an inline --only= selection this long fails at the OS/shell layer, never reaching this script's own argument handling",
      looksLikeCommandLineFailure,
    );
  } else {
    console.log("ℹ skipping the win32-only command-line-length positive control on this platform (not win32) — --only-file='s own fix is still asserted below.");
  }

  // (2) GREEN, every platform: the SAME oversized selection, delivered via --only-file=, reaches this
  // script's own in-process `resolveSelectionForCliMode` — which then correctly (and CLEANLY, via this
  // script's own exit(1) + stderr message, never an OS-level spawn failure) refuses because none of the
  // padding names are real discovered tests. The refusal itself is the proof: reaching it at all means
  // the command line was short enough to spawn `node` successfully.
  const tmpDir = mkdtempManaged("loom-test-cee17efe-only-file-");
  const onlyFilePath = path.join(tmpDir, "only-file-list.txt");
  fs.writeFileSync(onlyFilePath, PADDING_NAMES.join("\n"), "utf8");
  const fileResult = await runSpawn(`--only-file=${JSON.stringify(onlyFilePath)}`);
  check(
    "--only-file= with the SAME oversized list reaches this script's own in-process argument handling (not an OS/shell failure)",
    !fileResult.spawnThrew && fileResult.spawnError == null && (fileResult.out.includes("test-daemon.mjs") || fileResult.err.includes("test-daemon.mjs")),
  );
  check(
    "that in-process refusal correctly rejects the bogus (never-discovered) padding names, naming the selection as unknown",
    fileResult.code === 1 && /--only names \d+ file\(s\) not in the discovered hermetic set/.test(fileResult.err) && fileResult.err.includes("cee17efe-padding-name-0"),
  );

  // [negative control] a SHORT, real --only-file= selection (one genuinely discovered test, read from
  // this project's own corpus) must still resolve and run for real — proving --only-file= is not merely
  // "always refuses", only that it correctly refuses an unknown selection while still accepting a real
  // one. Selects THIS file's own fast sibling (test-daemon-cli-args.mjs) so the real run stays quick.
  const realOnlyFilePath = path.join(tmpDir, "only-file-real.txt");
  fs.writeFileSync(realOnlyFilePath, "test-daemon-cli-args\n", "utf8");
  const realResult = await runSpawn(`--only-file=${JSON.stringify(realOnlyFilePath)}`);
  check(
    "[negative control] a genuinely-discovered name via --only-file= is accepted and actually runs (exit 0, not refused as unknown)",
    realResult.code === 0 && !realResult.err.includes("not in the discovered hermetic set") && realResult.out.includes("selection active"),
  );

  // (3) R3-7: the EXACT production command string `runOneDistImporterCheck` builds —
  // `pnpm --filter @loom/daemon test:daemon --only-file=<JSON path>`, spawned via shell:true from the
  // repo root (mirroring the production cwd, an isolated worktree that IS the repo root) — with the
  // `--only-file=` PATH itself containing a literal space, the realistic hazard this proves survives
  // cmd.exe's own quoting: a worktree/temp path with a space (a username with a space, "Program Files"-
  // style segments) must not break the JSON.stringify-quoted argument the same way an unquoted one would.
  const spacedOnlyFilePath = path.join(tmpDir, "only file list with a space.txt");
  fs.writeFileSync(spacedOnlyFilePath, "test-daemon-cli-args\n", "utf8");
  const prodResult = await new Promise((resolve) => {
    const command = `pnpm --filter @loom/daemon test:daemon --only-file=${JSON.stringify(spacedOnlyFilePath)}`;
    let child;
    try {
      child = spawn(command, { cwd: repoRoot, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ spawnThrew: true, code: null, out: "", err: String(err) });
      return;
    }
    let out = "";
    let errOut = "";
    child.stdout?.on("data", (d) => { out += d; });
    child.stderr?.on("data", (d) => { errOut += d; });
    child.on("close", (code) => resolve({ spawnThrew: false, code, out, err: errOut }));
  });
  check(
    "[R3-7] the production command string (pnpm --filter … test:daemon --only-file=<path with a space>) spawns cleanly and runs the real, named test",
    !prodResult.spawnThrew && prodResult.code === 0 && (prodResult.out.includes("selection active") || prodResult.err.includes("selection active")),
  );

  console.log(`\n${failures === 0 ? "✅" : "❌"} test-daemon-only-file-real-spawn: ${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
};

run();
