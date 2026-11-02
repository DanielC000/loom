import "./_guard.mjs"; // prod-guard (sets LOOM_TEST=1)
// Card 015fdb23 — drives the REAL (unsubclassed) `PtyHost.createPty()` through the cwd-skill permission
// scan (see docs/decisions/015fdb23-skill-shell-execution-disable-and-cwd-skill-scan.md for why a pure-
// function/direct-settings-call proxy isn't enough, and the CI-non-win32 gap this file itself has).
// A real node.exe substituted for `claude` via `LOOM_CLAUDE_BIN` (the same technique `boot-mode-settings-
// argv-coupling.mjs` and `kickoff-real-spawn.mjs` already established), for two roles, asserts:
//   (a) the WRITTEN settings.json carries `disableSkillShellExecution:true` for an in-scope role
//       (worker) and lacks the key entirely for an out-of-scope one (manager);
//   (b) a real, non-Loom-owned `<cwd>/.claude/skills` skill carrying `hooks:` fires the REAL
//       `onSkillPermissionFrontmatterWarning` callback for the in-scope role, naming it;
//   (c) a Loom-PLACED skill (delivered by this SAME real `injectSkills` call, carrying the identical
//       `hooks:` vector) is NOT flagged — the fingerprint-matched exclusion actually reaches this call,
//       not just the pure-function test;
//   (2) the out-of-scope role (manager) never even runs the scan — no warning at all, despite an
//       identical hooked repo skill sitting in its own cwd.
//
// RED-PROOF recipe + the actual run: see the decision record linked above (CR round 3, finding 4).
//
// RUN: pnpm build (repo root) then `node test/skill-permission-scan-createpty-wiring.mjs` from packages/daemon.
// WINDOWS-ONLY (mirrors boot-mode-settings-argv-coupling.mjs's own header): the LOOM_CLAUDE_BIN real-
// node.exe-substitution technique was only established/verified on Windows in this repo.
import fs from "node:fs";
import path from "node:path";
import { mkdtempManaged, registerForCleanup, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

if (process.platform !== "win32") {
  console.log("WARN  SKIP  skill-permission-scan-createpty-wiring.mjs — the LOOM_CLAUDE_BIN real-node.exe-substitution technique this file uses was only established/verified on Windows (process.platform !== 'win32' here); see boot-mode-settings-argv-coupling.mjs's own header for the same gap.");
  process.exit(0);
}

const tmpHome = mkdtempManaged("loom-skpw-");
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
// Substitute a real, trivial, always-present executable for `claude` (mirrors boot-mode-settings-argv-
// coupling.mjs): resolveExecutable passes an absolute path through unchanged, so createPty's real spawn
// launches a harmless node.exe instead of a real `claude`.
process.env.LOOM_CLAUDE_BIN = process.execPath;
// Card 849acf9b's redirect (same as boot-mode-settings-argv-coupling.mjs): createPty's real spawn path
// reaches ensureTrustedResilient -> ensureTrusted unconditionally, which writes a trust entry into
// whatever claudeJsonPath() resolves to. Redirect it BEFORE the ../dist import, or this leaks into the
// owner's REAL ~/.claude.json.
const claudeConfigDir = path.join(tmpHome, "claude-config");
fs.mkdirSync(claudeConfigDir, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");
const { ensureDirs, WORKTREES_DIR, SETTINGS_DIR } = await import("../dist/paths.js");
const { claudeJsonPath } = await import("../dist/pty/claude-config.js");
ensureDirs();
registerForCleanup(WORKTREES_DIR); // sibling of LOOM_HOME, created by production ensureDirs()

// Assert the redirect actually took before any real spawn can reach ensureTrusted — same abort-before-
// real-spawn discipline as boot-mode-settings-argv-coupling.mjs.
{
  const resolved = path.resolve(claudeJsonPath());
  const expected = path.resolve(path.join(claudeConfigDir, ".claude.json"));
  check("claudeJsonPath() resolves under this test's own temp CLAUDE_CONFIG_DIR, never the real ~/.claude.json", resolved === expected);
  if (resolved !== expected) {
    console.log("\n❌ refusing to proceed to a real spawn: claudeJsonPath() does not resolve under this test's own CLAUDE_CONFIG_DIR. Aborting before host.spawn().");
    await finishAndExit(1);
  }
}

// Seed the skill STORE (~/.loom/skills = LOOM_HOME/skills) with ONE skill that itself carries `hooks:`
// frontmatter — a REAL Loom-placed skill this scan must trust once fingerprint-matched, unlike an
// un-Loom-owned repo skill carrying the identical vector.
const STORE = path.join(tmpHome, "skills");
fs.mkdirSync(path.join(STORE, "loom-hooked-skill"), { recursive: true });
fs.writeFileSync(path.join(STORE, "loom-hooked-skill", "SKILL.md"), "---\nname: loom-hooked-skill\nhooks:\n  Stop:\n---\nbody\n");

const warnings = [];
const events = {
  onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {},
  onSkillPermissionFrontmatterWarning(sessionId, info) { warnings.push({ sessionId, ...info }); },
};
const host = new PtyHost(events);

function writeRepoSkill(cwd, name, frontmatterBody) {
  const dir = path.join(cwd, ".claude", "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\n${frontmatterBody}---\nbody\n`);
}

function readWrittenSettings(sessionId) {
  return JSON.parse(fs.readFileSync(path.join(SETTINGS_DIR, `${sessionId}.json`), "utf8"));
}

let sessionWorker, sessionManager;
try {
  // ===================== (a)/(b)/(c): a LOOM_DRIVEN_ROLES role (worker) =====================
  const cwdWorker = path.join(tmpHome, "cwd-worker");
  fs.mkdirSync(cwdWorker, { recursive: true });
  writeRepoSkill(cwdWorker, "repo-hooked-skill", "name: repo-hooked-skill\nhooks:\n  Stop:\n");

  sessionWorker = "wiring-worker-1";
  host.spawn({
    sessionId: sessionWorker, cwd: cwdWorker, role: "worker",
    permission: { mode: "acceptEdits", allow: [], deny: [] },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });

  check("(a) worker: real settings.json carries disableSkillShellExecution:true",
    readWrittenSettings(sessionWorker).disableSkillShellExecution === true);

  check("(setup) loom-hooked-skill was actually delivered into the worker's cwd by this same real spawn (so (c) below is a genuine exclusion, not an absence)",
    fs.existsSync(path.join(cwdWorker, ".claude", "skills", "loom-hooked-skill", "SKILL.md")));

  const workerWarnings = warnings.filter((w) => w.sessionId === sessionWorker);
  check("(b) exactly one real onSkillPermissionFrontmatterWarning fired for the worker spawn", workerWarnings.length === 1);
  const wFindings = workerWarnings[0]?.findings ?? [];
  check("(b) the repo's OWN hooked skill (never Loom's) IS flagged, with hooks",
    wFindings.some((f) => f.name === "repo-hooked-skill" && f.fields.includes("hooks")));
  check("(c) the fingerprint-matched LOOM-PLACED hooked skill is NOT flagged",
    !wFindings.some((f) => f.name === "loom-hooked-skill"));

  // ===================== (2): manager (out of scope) — the scan must not even run =====================
  const cwdManager = path.join(tmpHome, "cwd-manager");
  fs.mkdirSync(cwdManager, { recursive: true });
  writeRepoSkill(cwdManager, "repo-hooked-skill", "name: repo-hooked-skill\nhooks:\n  Stop:\n");

  sessionManager = "wiring-manager-1";
  host.spawn({
    sessionId: sessionManager, cwd: cwdManager, role: "manager",
    permission: { mode: "acceptEdits", allow: [], deny: [] },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });

  check("(a) manager: real settings.json has NO disableSkillShellExecution key at all",
    !("disableSkillShellExecution" in readWrittenSettings(sessionManager)));
  check("(2) a manager spawn never runs the scan at all — no warning fired despite an identical hooked repo skill in its own cwd",
    !warnings.some((w) => w.sessionId === sessionManager));
} finally {
  for (const sid of [sessionWorker, sessionManager].filter(Boolean)) {
    try { host.stop(sid, "hard"); } catch { /* best-effort cleanup */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the REAL createPty wiring actually threads isLoomDrivenRole into both disableSkillShellExecution AND the scan's own role gate, actually fires onSkillPermissionFrontmatterWarning for a real hooked repo skill, and actually trusts a fingerprint-matched Loom-placed skill carrying the identical vector — not merely a pure-function/direct-settings-call proxy for any of it."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
