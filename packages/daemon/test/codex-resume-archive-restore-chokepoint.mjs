import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 5172fe3a — proves `PtyHost.createCodexPty` is wired to `restoreArchivedCodexRollout`
// (pty/codex-rollout-archive.ts) at the chokepoint: every codex spawn whose argv would include
// `resume <uuid>` (decided solely by `buildCodexResumeArgs`) restores that id's rollout from the
// archive to its EXACT original live path BEFORE the real process is ever spawned, and a restore
// failure refuses the spawn entirely rather than letting codex crash on its own with a far more
// confusing error. See docs/decisions/5172fe3a-codex-rollout-archiver-cannot-race-a-restore.md and
// codex-rollout-archive.mjs (restoreArchivedCodexRollout's own unit coverage) for the rest of this
// card's tests; this file is specifically the WIRING proof — createCodexPty actually calls it.
//
// Drives the REAL (unsubclassed) `PtyHost.createCodexPty()` against a fixture CLI that records its own
// argv (fixtures/env-dump-cli.mjs via LOOM_CODEX_BIN) — never the real codex CLI, no
// acquireCodexRealSpawnLock() needed. Same technique as codex-model-pin-spawn-argv.mjs /
// codex-update-check-spawn-argv.mjs. WINDOWS-ONLY (`.cmd` wrapper); SKIPS (exit 0) elsewhere.
//
// Run: 1) build, 2) node test/codex-resume-archive-restore-chokepoint.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempManaged, finishAndExit, useOwnLoomHome } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond, diag) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) { failures++; if (diag) console.log(`      ${diag}`); }
};

if (process.platform !== "win32") {
  console.log("WARN  SKIP  codex-resume-archive-restore-chokepoint.mjs — the .cmd-wrapper fixture mechanism is Windows-only (mirrors codex-model-pin-spawn-argv.mjs's accepted POSIX gap); restoreArchivedCodexRollout's own unit coverage (codex-rollout-archive.mjs) is platform-agnostic and still runs everywhere.");
  process.exit(0);
}

const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "env-dump-cli.mjs");
const tmpHome = mkdtempManaged("loom-codex-resume-restore-chokepoint-");
useOwnLoomHome("loom-codex-resume-restore-chokepoint-loomhome-"); // scopes codexRolloutArchiveRoot() to a fresh temp LOOM_HOME
const tmpCodexHome = mkdtempManaged("loom-codex-resume-restore-chokepoint-codexhome-");
process.env.CODEX_HOME = tmpCodexHome; // scopes codexSessionsRoot() to a fresh temp CODEX_HOME — never the real ~/.codex
const wrapperPath = path.join(tmpHome, "fake-codex.cmd");
fs.writeFileSync(wrapperPath, `@"${process.execPath}" "${FIXTURE_PATH}" %*\r\n`);
process.env.LOOM_CODEX_BIN = wrapperPath;

const { PtyHost } = await import("../dist/pty/host.js");
const { codexRolloutArchiveRoot } = await import("../dist/pty/codex-rollout-archive.js");
const events = { onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onBusy() {}, onExit() {} };

function dayDir(root, y, m, d) { return path.join(root, y, m, d); }
function writeRollout(dayDirPath, fileName, sessionId, cwd) {
  fs.mkdirSync(dayDirPath, { recursive: true });
  const file = path.join(dayDirPath, fileName);
  fs.writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { session_id: sessionId, cwd, originator: "codex-tui" } }) + "\n");
  return file;
}

// ═══ Scenario A: resuming an ARCHIVED id restores it to the live path BEFORE spawning ═══
{
  const RESUME_ID = "aaaaaaaa-1111-1111-1111-111111111111";
  const rel = path.join("2026", "09", "01", `rollout-2026-09-01T00-00-00-${RESUME_ID}.jsonl`);
  const archivePath = path.join(codexRolloutArchiveRoot(), rel);
  const livePath = path.join(tmpCodexHome, "sessions", rel);
  writeRollout(path.dirname(archivePath), path.basename(archivePath), RESUME_ID, "/fake/cwd/a");

  check("RED CONTROL: before the spawn, the rollout is ONLY in the archive, not the live tree", fs.existsSync(archivePath) && !fs.existsSync(livePath));

  const host = new PtyHost(events);
  const spawnCwd = fs.mkdtempSync(path.join(tmpHome, "cwd-a-"));
  const argvOutputFile = path.join(tmpHome, "argv-a.json");
  const pty = host.createCodexPty({
    sessionId: "chokepoint-a", cwd: spawnCwd, permission: {}, geometry: { cols: 120, rows: 40 },
    sessionEnv: { FIXTURE_ENV_OUTPUT_FILE: path.join(tmpHome, "env-a.json"), FIXTURE_ARGV_OUTPUT_FILE: argvOutputFile },
    role: "worker", harness: "codex", resumeId: RESUME_ID,
  });
  try {
    await waitUntil(() => fs.existsSync(argvOutputFile), { label: "chokepoint-a fixture's argv dump file to appear (proves the process WAS spawned)" });
    const argv = JSON.parse(fs.readFileSync(argvOutputFile, "utf8"));
    check("the spawn still leads with `resume <uuid>` (restore doesn't change the argv decision itself)", argv[0] === "resume" && argv[1] === RESUME_ID, `argv=${JSON.stringify(argv)}`);
  } catch (err) {
    console.log(`FAIL  ${err.message}`);
    failures++;
  } finally {
    try { pty.kill(); } catch { /* best-effort */ }
  }
  check("the rollout is now at its EXACT original live path (restored BEFORE the spawn observably proceeded)", fs.existsSync(livePath));
  check("the archive copy is gone (moved, not copied-and-left)", !fs.existsSync(archivePath));
}

// ═══ Scenario B: resuming an id with NO archived copy is a no-op — spawn still proceeds normally ═══
{
  const RESUME_ID = "bbbbbbbb-2222-2222-2222-222222222222"; // never written anywhere
  const host = new PtyHost(events);
  const spawnCwd = fs.mkdtempSync(path.join(tmpHome, "cwd-b-"));
  const argvOutputFile = path.join(tmpHome, "argv-b.json");
  const pty = host.createCodexPty({
    sessionId: "chokepoint-b", cwd: spawnCwd, permission: {}, geometry: { cols: 120, rows: 40 },
    sessionEnv: { FIXTURE_ENV_OUTPUT_FILE: path.join(tmpHome, "env-b.json"), FIXTURE_ARGV_OUTPUT_FILE: argvOutputFile },
    role: "worker", harness: "codex", resumeId: RESUME_ID,
  });
  try {
    await waitUntil(() => fs.existsSync(argvOutputFile), { label: "chokepoint-b fixture's argv dump file to appear (an unmatched id must not block the spawn)" });
    const argv = JSON.parse(fs.readFileSync(argvOutputFile, "utf8"));
    check("NEGATIVE CONTROL: an id with no archived copy still spawns normally with `resume <uuid>` in argv", argv[0] === "resume" && argv[1] === RESUME_ID, `argv=${JSON.stringify(argv)}`);
  } catch (err) {
    console.log(`FAIL  ${err.message}`);
    failures++;
  } finally {
    try { pty.kill(); } catch { /* best-effort */ }
  }
}

// ═══ Scenario C: a restore I/O FAILURE refuses the spawn entirely — synchronous throw, before codex is
// ever launched (no waiting/timing involved: the throw happens in the same synchronous call, strictly
// before this method's own `spawn(bin, args, ...)` line is ever reached — a child process structurally
// cannot have been created if this throws). ═══
{
  const RESUME_ID = "cccccccc-3333-3333-3333-333333333333";
  // A distinct, never-touched-by-any-other-scenario year segment ("2099") — scenarios A/B already create
  // real "2026" directories under this same tmpCodexHome/sessions root, so blocking "2026" here would
  // collide with their own, unrelated fixture state instead of cleanly sabotaging just this scenario.
  const rel = path.join("2099", "09", "01", `rollout-2099-09-01T00-00-00-${RESUME_ID}.jsonl`);
  const archivePath = path.join(codexRolloutArchiveRoot(), rel);
  writeRollout(path.dirname(archivePath), path.basename(archivePath), RESUME_ID, "/fake/cwd/c");
  // Sabotage the restore deterministically, cross-platform: pre-create the LIVE sessions root's "2099"
  // path SEGMENT as a plain FILE (not a directory). restoreArchivedCodexRollout's own
  // `fs.mkdirSync(path.dirname(dest), { recursive: true })` then genuinely cannot create
  // ".../sessions/2099/09/01" — ENOTDIR, a real I/O error — before it ever reaches moveFile.
  fs.mkdirSync(path.join(tmpCodexHome, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(tmpCodexHome, "sessions", "2099"), "blocker — not a directory");

  const host = new PtyHost(events);
  const spawnCwd = fs.mkdtempSync(path.join(tmpHome, "cwd-c-"));
  const argvOutputFile = path.join(tmpHome, "argv-c.json");
  let threw = null;
  try {
    host.createCodexPty({
      sessionId: "chokepoint-c", cwd: spawnCwd, permission: {}, geometry: { cols: 120, rows: 40 },
      sessionEnv: { FIXTURE_ENV_OUTPUT_FILE: path.join(tmpHome, "env-c.json"), FIXTURE_ARGV_OUTPUT_FILE: argvOutputFile },
      role: "worker", harness: "codex", resumeId: RESUME_ID,
    });
  } catch (err) {
    threw = err;
  }
  check("createCodexPty THROWS synchronously when the restore fails (never returns a live pty on this path)", threw instanceof Error, `threw=${threw}`);
  check("the thrown error names the resume id (a clear, diagnosable error, not a bare crash)", threw ? String(threw.message).includes(RESUME_ID) : false, `message=${threw?.message}`);
  check("the fixture process was NEVER spawned — no argv dump file exists (the throw is BEFORE spawn(), not racing it)", !fs.existsSync(argvOutputFile));
  check("the archive copy was left untouched by the failed attempt (no partial move)", fs.existsSync(archivePath));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — createCodexPty restores an archived rollout to its exact original live path before spawning any `codex resume <uuid>`, a no-archive id passes through untouched, and a genuine restore failure refuses the spawn synchronously with a clear error instead of letting codex crash on its own."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
