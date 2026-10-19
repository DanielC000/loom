import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 99d9eeb5 — buildSpawnEnv must scrub an inherited LOOM_PROJECT_WORK_DIR from the DAEMON's own
// process env. DEFENSE-IN-DEPTH, not a live-bug fix: this card's own investigation found no production
// call site that ever omits opts.projectId (sessions/service.ts is the only production caller of
// PtyHost.spawn() and every one of its ~16 call sites passes a genuinely resolved project.id; the DB's
// own `sessions.project_id TEXT NOT NULL` backs this structurally), so the gated per-call-site
// Object.assign in createPty/createCodexPty always wins today regardless of this scrub. The hazard this
// closes is a FUTURE/degraded spawn that omits projectId (the SpawnOpts type still permits it) combined
// with a daemon process that itself inherited the var — e.g. a throwaway daemon launched from inside an
// agent/worker/manager shell, since card 5eace211 gives every Loom-spawned session this var too (the
// SAME trap class the existing pty-claude-spawn-env.mjs / pty-codex-spawn-env.mjs negative controls
// already had to `delete process.env.LOOM_PROJECT_WORK_DIR` defensively to avoid).
//
// PART 1 — buildSpawnEnv (pure, no pty, cross-platform): an ambient LOOM_PROJECT_WORK_DIR on the DAEMON's
//          own processEnv is scrubbed, exactly like the existing CLAUDECODE/CLAUDE_CODE_*/MCP-token scrub
//          (card a50b8afd). A sessionEnv-provided value is deliberately NOT stripped at this level (same
//          design as that card) — it is merged AFTER this scrub's own base-copy loop, so a future
//          deliberate sessionEnv override would still win here, consistent with every other var this
//          function sets.
// PART 2 — a REAL claude spawn (LOOM_CLAUDE_BIN substitution, env-dump-cli.mjs fixture): with the ambient
//          var polluted AND no projectId, the child never sees it at all; with the SAME pollution present
//          AND a projectId, the child gets the CORRECT project's work dir, not the polluted value —
//          proving createPty's own gated Object.assign still wins even in the presence of ambient
//          pollution.
// PART 3 — the identical pair of real-spawn proofs for createCodexPty.
//
// WINDOWS-ONLY for PARTS 2/3 (the LOOM_CLAUDE_BIN/LOOM_CODEX_BIN .cmd-wrapper substitution technique is
// Windows-specific — see transcript-root-deny-chokepoint.mjs's own header for the accepted POSIX gap);
// PART 1 runs everywhere.
//
// Run: 1) build (turbo builds shared first), 2) node test/project-work-dir-ambient-env-scrub.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempManaged, registerForCleanup, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = mkdtempManaged("loom-pwd-scrub-");
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
// Card 5eace211 (Code Review, CRITICAL): clear any AMBIENT LOOM_PROJECT_WORK_ROOT (a human may set this
// to point at the REAL shared project-work-dir root) BEFORE importing dist/paths.js, which reads it at
// module load — mirrors project-work-dir.mjs's / pty-claude-spawn-env.mjs's own identical comment.
delete process.env.LOOM_PROJECT_WORK_ROOT;
// PART 2 below does a REAL claude spawn (host.spawn), which reaches ensureTrustedResilient ->
// ensureTrusted (host.ts) unconditionally and writes a trust entry into whatever claudeJsonPath()
// resolves to. Redirect HOME+USERPROFILE together, BEFORE the dist import below, same convention as
// pty-claude-spawn-env.mjs's own identical redirect — or this would land in the OWNER'S REAL
// ~/.claude.json on every run (card 849acf9b).
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { requireHermeticEnv, assertUnderOsTmpdir } = await import("./_guard.mjs");
requireHermeticEnv();

const { PtyHost, buildSpawnEnv } = await import("../dist/pty/host.js");
const { ensureDirs, WORKTREES_DIR, PROJECTS_WORK_ROOT, projectWorkDir } = await import("../dist/paths.js");
ensureDirs();
registerForCleanup(WORKTREES_DIR);
// Card 5eace211 (Code Review, CRITICAL): assert this is GENUINELY a temp-derived root before registering
// it for recursive removal — defense in depth, same as project-work-dir.mjs's own identical guard.
assertUnderOsTmpdir("PROJECTS_WORK_ROOT", PROJECTS_WORK_ROOT);
registerForCleanup(PROJECTS_WORK_ROOT);

// =====================================================================================================
// PART 1 — buildSpawnEnv scrubs an inherited LOOM_PROJECT_WORK_DIR from the DAEMON's own process env
// =====================================================================================================
{
  const pollutedProcessEnv = { ...process.env, LOOM_PROJECT_WORK_DIR: "/stray/inherited/from/daemon/own/env" };
  const env = buildSpawnEnv(pollutedProcessEnv, {}, tmpHome);
  check("(PART 1) buildSpawnEnv scrubs an inherited LOOM_PROJECT_WORK_DIR from processEnv, same as CLAUDECODE/CLAUDE_CODE_*/the MCP token var",
    env.LOOM_PROJECT_WORK_DIR === undefined);
  // Positive control: prove the scrub is SPECIFIC to this one key, not an accidental drop of everything.
  const envWithUnrelated = buildSpawnEnv({ ...process.env, LOOM_UNRELATED_PROBE_VAR: "survives" }, {}, tmpHome);
  check("(PART 1 positive control) an UNRELATED inherited env var survives the scrub untouched (proves this isn't a blanket env wipe)",
    envWithUnrelated.LOOM_UNRELATED_PROBE_VAR === "survives");
  // Card 99d9eeb5 (deliberate design, mirroring card a50b8afd's MCP-token scrub): a sessionEnv-provided
  // value is NOT stripped by this scrub — it is merged AFTER the base-copy loop this scrub lives in, so a
  // future deliberate sessionEnv override would still win at THIS level. The real protection for a
  // projectId spawn is the CALLER's own later, gated Object.assign in createPty/createCodexPty — proven
  // in PART 2/3 below, which also prove the no-projectId case genuinely omits the var rather than merely
  // relying on this scrub alone.
  const envWithSessionOverride = buildSpawnEnv(process.env, { LOOM_PROJECT_WORK_DIR: "/deliberate/session/value" }, tmpHome);
  check("(PART 1) buildSpawnEnv itself does NOT strip a sessionEnv-provided value — consistent with every other var in this function",
    envWithSessionOverride.LOOM_PROJECT_WORK_DIR === "/deliberate/session/value");
}

const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "env-dump-cli.mjs");

if (process.platform !== "win32") {
  console.log("WARN  SKIP  project-work-dir-ambient-env-scrub.mjs PARTS 2/3 — the LOOM_CLAUDE_BIN/LOOM_CODEX_BIN .cmd-wrapper substitution technique this file uses is Windows-only (process.platform !== 'win32' here); see transcript-root-deny-chokepoint.mjs's own header for the accepted POSIX gap.");
} else {
  const events = { onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onBusy() {}, onExit() {} };
  const wrapperPath = (name) => {
    const p = path.join(tmpHome, name);
    fs.writeFileSync(p, `@"${process.execPath}" "${FIXTURE_PATH}" %*\r\n`);
    return p;
  };

  // Pollute the AMBIENT var on THIS process's own env for every spawn in PARTS 2/3 below — simulating a
  // daemon that itself inherited LOOM_PROJECT_WORK_DIR from a launching agent/worker shell (card 5eace211).
  const POLLUTED_VALUE = "/stray/inherited/ambient/value";
  process.env.LOOM_PROJECT_WORK_DIR = POLLUTED_VALUE;

  // =====================================================================================================
  // PART 2 — a REAL claude spawn: ambient pollution never reaches a no-projectId child, and still loses
  // to the correct per-project value when a projectId IS present.
  // =====================================================================================================
  process.env.LOOM_CLAUDE_BIN = wrapperPath("fake-claude-pwd-scrub.cmd");
  {
    const sid = "pwd-scrub-claude-noproj";
    const dumpPath = path.join(tmpHome, `${sid}-env.json`);
    process.env.FIXTURE_ENV_OUTPUT_FILE = dumpPath;
    const host = new PtyHost(events);
    const cwd = fs.mkdtempSync(path.join(tmpHome, "cwd-"));
    host.spawn({
      sessionId: sid, cwd, role: "worker",
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    try {
      await waitUntil(() => fs.existsSync(dumpPath), { label: `${sid} fixture env dump` });
      const dump = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
      check("(PART 2, claude, no projectId) ambient LOOM_PROJECT_WORK_DIR pollution never reaches the real child env",
        !("LOOM_PROJECT_WORK_DIR" in dump));
    } finally {
      try { host.stop(sid, "hard"); } catch { /* best-effort */ }
    }
  }
  {
    const sid = "pwd-scrub-claude-proj";
    const dumpPath = path.join(tmpHome, `${sid}-env.json`);
    process.env.FIXTURE_ENV_OUTPUT_FILE = dumpPath;
    const PROJECT_ID = "pwd-scrub-claude-project-id";
    const host = new PtyHost(events);
    const cwd = fs.mkdtempSync(path.join(tmpHome, "cwd-"));
    host.spawn({
      sessionId: sid, cwd, role: "worker", projectId: PROJECT_ID,
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    try {
      await waitUntil(() => fs.existsSync(dumpPath), { label: `${sid} fixture env dump` });
      const dump = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
      const expected = projectWorkDir(PROJECT_ID);
      check("(PART 2, claude, WITH projectId) child gets the CORRECT project work dir despite ambient pollution",
        dump.LOOM_PROJECT_WORK_DIR === expected);
      check("(PART 2, claude, WITH projectId) child's value is NOT the polluted ambient string",
        dump.LOOM_PROJECT_WORK_DIR !== POLLUTED_VALUE);
    } finally {
      try { host.stop(sid, "hard"); } catch { /* best-effort */ }
    }
  }

  // =====================================================================================================
  // PART 3 — the identical pair of proofs for createCodexPty.
  // =====================================================================================================
  process.env.LOOM_CODEX_BIN = wrapperPath("fake-codex-pwd-scrub.cmd");
  {
    const sid = "pwd-scrub-codex-noproj";
    const dumpPath = path.join(tmpHome, `${sid}-env.json`);
    process.env.FIXTURE_ENV_OUTPUT_FILE = dumpPath;
    const cwd = fs.mkdtempSync(path.join(tmpHome, "cwd-"));
    const host = new PtyHost(events);
    const pty = host.createCodexPty({
      sessionId: sid, cwd, permission: {}, geometry: { cols: 120, rows: 40 },
      sessionEnv: {}, role: "worker", harness: "codex",
    });
    try {
      await waitUntil(() => fs.existsSync(dumpPath), { label: `${sid} fixture env dump` });
      const dump = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
      check("(PART 3, codex, no projectId) ambient LOOM_PROJECT_WORK_DIR pollution never reaches the real child env",
        !("LOOM_PROJECT_WORK_DIR" in dump));
    } finally {
      try { pty.kill(); } catch { /* best-effort */ }
    }
  }
  {
    const sid = "pwd-scrub-codex-proj";
    const dumpPath = path.join(tmpHome, `${sid}-env.json`);
    process.env.FIXTURE_ENV_OUTPUT_FILE = dumpPath;
    const cwd = fs.mkdtempSync(path.join(tmpHome, "cwd-"));
    const PROJECT_ID = "pwd-scrub-codex-project-id";
    const host = new PtyHost(events);
    const pty = host.createCodexPty({
      sessionId: sid, cwd, permission: {}, geometry: { cols: 120, rows: 40 },
      sessionEnv: {}, role: "worker", harness: "codex", projectId: PROJECT_ID,
    });
    try {
      await waitUntil(() => fs.existsSync(dumpPath), { label: `${sid} fixture env dump` });
      const dump = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
      const expected = projectWorkDir(PROJECT_ID);
      check("(PART 3, codex, WITH projectId) child gets the CORRECT project work dir despite ambient pollution",
        dump.LOOM_PROJECT_WORK_DIR === expected);
      check("(PART 3, codex, WITH projectId) child's value is NOT the polluted ambient string",
        dump.LOOM_PROJECT_WORK_DIR !== POLLUTED_VALUE);
    } finally {
      try { pty.kill(); } catch { /* best-effort */ }
    }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — buildSpawnEnv scrubs an inherited LOOM_PROJECT_WORK_DIR from the daemon's own process env (defense-in-depth), and a REAL claude/codex child never sees a polluted ambient value — absent entirely with no projectId, and overwritten with the CORRECT project's work dir (never the polluted string) when a projectId is present."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
