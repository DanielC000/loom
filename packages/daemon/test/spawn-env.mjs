import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Worker pty spawn ENV (buildSpawnEnv) — DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE. Pure-seam test
// mirroring browser-testing-spawn.mjs / the buildMcpServers + buildSpawnArgs seams.
//
// Proves the fix for the "git wedges the unattended worker pty" class (card bd6e1340):
//   - the spawn env carries the three git-safety vars GIT_PAGER=cat / PAGER=cat / GIT_TERMINAL_PROMPT=0
//     (without these a worker's post-commit `git diff`/`git log` can page into `less` and block forever,
//     freezing the turn at busy → a FALSE worker-stuck trip + a queued, undelivered worker_report);
//   - the existing behavior is preserved: the CLAUDECODE / CLAUDE_CODE_* scrub still strips those keys
//     (a nested claude must not think it runs inside another claude);
//   - sessionEnv STILL overrides — load-bearing: proves a project's deliberate env override is NOT
//     regressed by the three new vars (they're set BEFORE the sessionEnv merge).
//
// Run: 1) build (turbo builds shared first), 2) node test/spawn-env.mjs
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { buildSpawnEnv } = await import("../dist/pty/host.js");

// A representative inherited process.env: some normal vars, the two CLAUDE_* species that MUST be
// scrubbed, and an undefined value (skipped, like the real loop). The default session env (the two
// alt-screen vars) is layered on top, exactly as createPty does.
const processEnv = {
  PATH: "/usr/bin",
  HOME: "/home/worker",
  CLAUDECODE: "1",                              // scrubbed
  CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1",    // scrubbed (CLAUDE_CODE_* prefix)
  CLAUDE_CODE_ENTRYPOINT: "cli",                // scrubbed
  GIT_PAGER: "less",                            // inherited value the fix must OVERRIDE to "cat"
  UNSET_VAR: undefined,                         // skipped (v === undefined)
};
const sessionEnv = {
  CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1",
  CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: "1",
};
const spawnCwd = "/home/worker/worktrees/loom-600bca4c";

const env = buildSpawnEnv(processEnv, sessionEnv, spawnCwd);

// --- the three git-safety vars (the headline fix) ---
check("GIT_PAGER === 'cat' (git never launches a pager)", env.GIT_PAGER === "cat");
check("PAGER === 'cat' (other pager-using tools never block either)", env.PAGER === "cat");
check("GIT_TERMINAL_PROMPT === '0' (git fails fast on an auth prompt, never hangs)", env.GIT_TERMINAL_PROMPT === "0");
// the fix OVERRIDES an inherited GIT_PAGER (e.g. the daemon ran under GIT_PAGER=less) — it's not merely additive.
check("an inherited GIT_PAGER=less is overridden to 'cat'", env.GIT_PAGER === "cat");

// --- behavior preserved: the CLAUDE_*/CLAUDECODE scrub still strips those keys from the INHERITED env ---
check("CLAUDECODE is scrubbed from the inherited env", !("CLAUDECODE" in env) || env.CLAUDECODE === undefined);
check("CLAUDE_CODE_ENTRYPOINT (a CLAUDE_CODE_* var) is scrubbed", !("CLAUDE_CODE_ENTRYPOINT" in env));
// an undefined inherited value is skipped, exactly like the original loop.
check("an undefined inherited value is skipped (not set to undefined)", !("UNSET_VAR" in env));
// ordinary inherited vars pass through untouched.
check("ordinary inherited vars pass through (PATH)", env.PATH === "/usr/bin");
check("ordinary inherited vars pass through (HOME)", env.HOME === "/home/worker");

// --- sessionEnv still applies + still OVERRIDES (load-bearing: no capability regression) ---
// The default sessionEnv re-adds the alt-screen vars AFTER the scrub — they end up SET (sessionEnv wins
// over the scrub, exactly as before this change).
check("sessionEnv re-adds CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN after the scrub", env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN === "1");
check("sessionEnv adds CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT", env.CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT === "1");

// LOAD-BEARING: a project that deliberately overrides one of the three git vars via sessionEnv STILL WINS
// (the three are set BEFORE the sessionEnv merge). Proves the fix introduces no capability regression.
const overridden = buildSpawnEnv(processEnv, { ...sessionEnv, PAGER: "less", GIT_TERMINAL_PROMPT: "1" });
check("a sessionEnv PAGER override STILL wins over the fix's PAGER=cat", overridden.PAGER === "less");
check("a sessionEnv GIT_TERMINAL_PROMPT override STILL wins", overridden.GIT_TERMINAL_PROMPT === "1");
// (a var NOT overridden by sessionEnv keeps the safety default)
check("a git var NOT overridden by sessionEnv keeps its safety default (GIT_PAGER=cat)", overridden.GIT_PAGER === "cat");

// --- LOOM_WORKTREE (card 600bca4c): the cwd anchor an agent's own Bash calls can reference, since Loom
// cannot reset the Bash tool's cwd itself (that shell state is internal to the upstream CLI process). ---
check("LOOM_WORKTREE is set to the spawn cwd", env.LOOM_WORKTREE === spawnCwd);
const anotherCwd = "/home/worker/worktrees/loom-other-task";
check("LOOM_WORKTREE tracks a DIFFERENT spawn cwd (not hardcoded)", buildSpawnEnv(processEnv, sessionEnv, anotherCwd).LOOM_WORKTREE === anotherCwd);
// a deliberate sessionEnv override still wins, exactly like the git-safety vars.
check("a sessionEnv LOOM_WORKTREE override STILL wins", buildSpawnEnv(processEnv, { ...sessionEnv, LOOM_WORKTREE: "/overridden" }, spawnCwd).LOOM_WORKTREE === "/overridden");

console.log(failures === 0
  ? "\n✅ ALL PASS — buildSpawnEnv carries GIT_PAGER/PAGER=cat + GIT_TERMINAL_PROMPT=0 (closes the git-wedges-the-worker-pty class) + LOOM_WORKTREE=spawnCwd (card 600bca4c's cwd-anchor mitigation), preserves the CLAUDE_*/CLAUDECODE scrub + undefined-skip, and a project sessionEnv override still wins for all of them (no capability regression)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
